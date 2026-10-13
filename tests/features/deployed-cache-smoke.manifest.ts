import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface SmokeWorld {
  baseUrl?: string;
  failureAfterEpochMs?: number;
  query?: string;
  first?: Response;
  second?: Response;
  stale?: Response;
}

const steps: readonly StepDefinition<SmokeWorld>[] = [
  step("the smoke stage's caller, bound to its private deployed Agris Proxy", noStepArguments, async (world) => {
    world.baseUrl = await deployedCallerUrl();
    await waitUntilReady(world.baseUrl);
    const smokeOperation = cacheSmokeOperation();
    world.failureAfterEpochMs = smokeOperation.failureAfterEpochMs;
    world.query = smokeOperation.query;
  }),
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

export const deployedCacheSmokeFeature: ExecutableFeatureManifest<SmokeWorld> = {
  id: "deployed-cache-smoke",
  uri: "tests/features/deployed-cache-smoke.feature",
  createWorld: () => ({}),
  steps,
};

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
  // The caller copies the gateway's own cache headers, which the public edge in front of the caller may replace.
  assert.equal(response.headers.get("x-smoke-cf-cache-status"), expected.cacheStatus);
  assert.equal(response.headers.get("x-central-market-source"), expected.source);
  assert.equal(response.headers.get("x-central-market-refresh"), expected.refresh);
  if (expected.ageVisible === true) assert.match(response.headers.get("x-smoke-age") ?? "", /^\d+$/u);
}

/**
 * BOUNDARY: The deployed smoke stage's caller address, read from the stage's output in the account's state store
 * (`moon run infra:smoke-url`), whose printed JSON is matched for its `url`.
 */
async function deployedCallerUrl(): Promise<string> {
  const { stdout } = await promisify(execFile)("moon", ["run", "infra:smoke-url"], {
    cwd: new URL("../../", import.meta.url),
  });
  const url = /"url":\s*"(https:\/\/[^"]+)"/u.exec(stdout)?.[1];
  if (url === undefined) throw new Error(`The smoke stage has no caller address; deploy it first:\n${stdout}`);
  return url;
}

/**
 * Wait until a fresh deploy answers end to end: the caller's new `workers.dev` address, and its binding to the gateway,
 * which Cloudflare refuses with error 1042 for a moment after the gateway is first deployed.
 */
async function waitUntilReady(baseUrl: string): Promise<void> {
  while (true) {
    try {
      if ((await graphRequest(baseUrl, "query SmokeReadiness { __typename }")).status === 200) return;
    } catch {
      // Not reachable yet.
    }
    await delay(1_000);
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
