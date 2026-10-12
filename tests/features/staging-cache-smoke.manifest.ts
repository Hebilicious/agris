import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface SmokeWorld {
  baseUrl?: string;
  failureAfterEpochMs?: number;
  query?: string;
  first?: Response;
  second?: Response;
  stale?: Response;
}

const callers = new Set<ChildProcess>();

const steps: readonly StepDefinition<SmokeWorld>[] = [
  step(
    "a local smoke caller bound remotely to the private deployed staging Agris Proxy smoke variant",
    noStepArguments,
    async (world) => {
      const port = await availablePort();
      const caller = spawn(
        "moon",
        ["run", "smoke:dev-smoke-remote", "--", "--ip", "127.0.0.1", "--port", String(port)],
        { cwd: new URL("../../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
      );
      callers.add(caller);
      const output: string[] = [];
      caller.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      caller.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      world.baseUrl = `http://127.0.0.1:${port}`;
      await waitUntilReachable(world.baseUrl, caller, output);
      const smokeOperation = cacheSmokeOperation();
      world.failureAfterEpochMs = smokeOperation.failureAfterEpochMs;
      world.query = smokeOperation.query;
    },
  ),
  step("the same thirty-second Central Market item-price query is requested twice", noStepArguments, async (world) => {
    const baseUrl = requireBaseUrl(world);
    const query = requireQuery(world);
    world.first = await graphRequest(baseUrl, query);
    await delay(1_100);
    world.second = await graphRequest(baseUrl, query);
  }),
  step("the first response is MISS, live, and refresh-succeeded", noStepArguments, (world) => {
    assertResponse(world.first, { cacheStatus: "MISS", source: "live", refresh: "succeeded", status: 200 });
  }),
  step("the second response is HIT, cache-fresh, refresh-not-attempted, with Age visible", noStepArguments, (world) => {
    assertResponse(world.second, {
      cacheStatus: "HIT",
      source: "cache-fresh",
      refresh: "not-attempted",
      status: 200,
      ageVisible: true,
    });
  }),
  step("that entry expires and its refresh is forced to return HTTP 503", noStepArguments, async (world) => {
    await delay(31_500);
    await delayUntil(requireFailureDeadline(world) + 500);
    world.stale = await graphRequest(requireBaseUrl(world), requireQuery(world));
  }),
  step(
    "the successful cached response is delivered as STALE, cache-stale, refresh-failed, with Age visible",
    noStepArguments,
    (world) => {
      assertResponse(world.stale, {
        cacheStatus: "STALE",
        source: "cache-stale",
        refresh: "failed",
        status: 200,
        ageVisible: true,
      });
    },
  ),
];

export const centralMarketStagingCacheSmokeFeature: ExecutableFeatureManifest<SmokeWorld> = {
  id: "central-market-staging-cache-smoke",
  uri: "tests/features/staging-cache-smoke.feature",
  createWorld: () => ({}),
  steps,
};

export async function stopStagingSmokeCallers(): Promise<void> {
  await Promise.all(
    [...callers].map(
      (caller) =>
        new Promise<void>((resolve) => {
          if (caller.exitCode !== null || caller.signalCode !== null) return resolve();
          caller.once("close", () => resolve());
          caller.kill("SIGTERM");
        }),
    ),
  );
  callers.clear();
}

async function graphRequest(baseUrl: string, query: string, region = "EU", itemId?: string): Promise<Response> {
  return fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { region, ...(itemId === undefined ? undefined : { itemId }) } }),
  });
}

function cacheSmokeOperation() {
  const failureAfterEpochMs = Date.now() + 10_000;
  return {
    failureAfterEpochMs,
    query: `query CacheSmoke_${failureAfterEpochMs}_${randomUUID().replaceAll("-", "_")}($region: MarketRegion!) {
  market(region: $region) {
    observedAt
    items(ids: ["10006"]) {
      item { id }
      basePrice
    }
  }
}`,
  };
}

function assertResponse(
  response: Response | undefined,
  expected: {
    readonly ageVisible?: boolean;
    readonly cacheStatus: string;
    readonly refresh: string;
    readonly source: string;
    readonly status: number;
  },
): void {
  assert.ok(response);
  assert.equal(response.status, expected.status);
  assert.equal(response.headers.get("cf-cache-status"), expected.cacheStatus);
  assert.equal(response.headers.get("x-central-market-source"), expected.source);
  assert.equal(response.headers.get("x-central-market-refresh"), expected.refresh);
  if (expected.ageVisible === true) assert.match(response.headers.get("age") ?? "", /^\d+$/u);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate a smoke caller port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function waitUntilReachable(baseUrl: string, caller: ChildProcess, output: readonly string[]): Promise<void> {
  while (true) {
    if (caller.exitCode !== null || caller.signalCode !== null) {
      throw new Error(`Smoke caller exited before readiness:\n${output.join("")}`);
    }
    try {
      await fetch(baseUrl);
      return;
    } catch {
      await delay(50);
    }
  }
}

function requireBaseUrl(world: SmokeWorld): string {
  if (world.baseUrl === undefined) throw new Error("Smoke caller was not started");
  return world.baseUrl;
}

function requireQuery(world: SmokeWorld): string {
  if (world.query === undefined) throw new Error("Smoke query identity was not created");
  return world.query;
}

function requireFailureDeadline(world: SmokeWorld): number {
  if (world.failureAfterEpochMs === undefined) throw new Error("Smoke failure deadline was not created");
  return world.failureAfterEpochMs;
}

function delayUntil(epochMs: number): Promise<void> {
  return delay(Math.max(0, epochMs - Date.now()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
