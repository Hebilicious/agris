import assert from "node:assert/strict";

import { gatewayCacheProps, gatewayProps } from "../../infra/src/gateway/props.ts";
import { marketProps } from "../../infra/src/market/props.ts";
import { DEFAULT_STAGE, DEMO_STAGE, stageSettings, type DeploymentSettings } from "../../infra/src/settings.ts";

import { boundRate, plainVariables } from "../support/deploy-bindings.ts";
import {
  dataTableStepArgument,
  integerPairStepArguments,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

interface DeploySettingsWorld {
  settings?: DeploymentSettings;
  refusals?: readonly { readonly variable: string; readonly outcome: unknown }[];
}

/** Every limit the deploy environment can turn off, turned off. */
const EVERY_LIMIT_OFF = {
  CLIENT_RATE_LIMIT_REQUESTS: "0",
  GLOBAL_RATE_LIMIT_REQUESTS: "0",
  PA_RATE_LIMIT_REQUESTS: "0",
  PA_MAX_CONCURRENT_REQUESTS: "0",
  CACHE_MINIMUM_SECONDS: "0",
};

function required(world: DeploySettingsWorld): DeploymentSettings {
  assert.ok(world.settings);
  return world.settings;
}

function gateway(world: DeploySettingsWorld) {
  return gatewayProps(required(world));
}

function market(world: DeploySettingsWorld) {
  return marketProps(required(world));
}

function refusal(environment: Readonly<Record<string, string>>): unknown {
  try {
    stageSettings(DEFAULT_STAGE, environment);
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

const steps: readonly StepDefinition<DeploySettingsWorld>[] = [
  step("the production stage is resolved from an empty environment", noStepArguments, (world) => {
    world.settings = stageSettings(DEFAULT_STAGE, {});
  }),
  step("its Workers are named agris, agris-cache, agris-market and agris-catalog", noStepArguments, (world) => {
    const settings = required(world);
    assert.deepEqual(
      [
        gatewayProps(settings).name,
        gatewayCacheProps(settings).name,
        marketProps(settings).name,
        settings.names.catalog,
      ],
      ["agris", "agris-cache", "agris-market", "agris-catalog"],
    );
  }),
  step("its gateway binds no client rate limit and no global rate limit", noStepArguments, (world) => {
    assert.equal(boundRate(gateway(world).env, "CLIENT_RATE_LIMITER"), null);
    assert.equal(boundRate(gateway(world).env, "GLOBAL_RATE_LIMITER"), null);
  }),
  step(
    "its gateway, cache and market Workers allow {int} subrequests and bind SUBREQUEST_LIMIT to {int}",
    integerPairStepArguments,
    (world, subrequests, variable) => {
      const settings = required(world);
      for (const props of [gatewayProps(settings), gatewayCacheProps(settings), marketProps(settings)]) {
        assert.equal(props.limits.subrequests, subrequests, props.name);
        assert.equal(plainVariables(props.env).SUBREQUEST_LIMIT, String(variable), props.name);
      }
    },
  ),
  step(
    "its market Worker binds a Pearl Abyss rate limit of 100 per 10 seconds for the whole deployment and a concurrency of 6 per host",
    noStepArguments,
    (world) => {
      assert.deepEqual(boundRate(market(world).env, "PA_RATE_LIMITER"), { limit: 100, period: 10 });
      assert.equal(plainVariables(market(world).env).PA_MAX_CONCURRENT_REQUESTS, "6");
    },
  ),
  step(
    "its gateway binds no cache or query variable, so it runs the default policy and limits",
    noStepArguments,
    (world) => {
      assert.deepEqual(plainVariables(gateway(world).env), { SUBREQUEST_LIMIT: "50" });
    },
  ),
  step("it answers on workers.dev and on no other hostname", noStepArguments, (world) => {
    const props = gateway(world);
    assert.equal(props.workersDev.enabled, true);
    assert.equal("domain" in props, false);
  }),
  step("the production stage is resolved from this environment", dataTableStepArgument, (world, table) => {
    world.settings = stageSettings(
      DEFAULT_STAGE,
      Object.fromEntries(table.hashes.map((row) => [row.variable ?? "", row.value ?? ""])),
    );
  }),
  step(
    "its gateway binds a client rate limit of 30 a minute and a global rate limit of 300 per 10 seconds",
    noStepArguments,
    (world) => {
      assert.deepEqual(boundRate(gateway(world).env, "CLIENT_RATE_LIMITER"), { limit: 30, period: 60 });
      assert.deepEqual(boundRate(gateway(world).env, "GLOBAL_RATE_LIMITER"), { limit: 300, period: 10 });
    },
  ),
  step("its market Worker binds no Pearl Abyss rate limit and a concurrency of 0", noStepArguments, (world) => {
    assert.equal(boundRate(market(world).env, "PA_RATE_LIMITER"), null);
    assert.equal(plainVariables(market(world).env).PA_MAX_CONCURRENT_REQUESTS, "0");
  }),
  step("its gateway binds CACHE_ENABLED, QUERY_MAX_DEPTH and GRAPHIQL as they were set", noStepArguments, (world) => {
    assert.deepEqual(plainVariables(gateway(world).env), {
      CACHE_ENABLED: "false",
      QUERY_MAX_DEPTH: "0",
      GRAPHIQL: "disabled",
      SUBREQUEST_LIMIT: "50",
    });
    assert.equal(required(world).cacheFreshness.enabled, false);
  }),
  step("it answers on agris.example.com as well as workers.dev", noStepArguments, (world) => {
    const props = gateway(world);
    assert.equal(props.domain, "agris.example.com");
    assert.equal(props.workersDev.enabled, true);
  }),
  step("the production stage is resolved from each of these environments", dataTableStepArgument, (world, table) => {
    world.refusals = table.hashes.map((row) => {
      const variable = row.variable ?? "";
      return { variable, outcome: refusal({ [variable]: row.value ?? "" }) };
    });
  }),
  step("each environment is refused with an error that names its variable", noStepArguments, (world) => {
    assert.ok(world.refusals && world.refusals.length > 0);
    for (const { variable, outcome } of world.refusals) {
      assert.ok(outcome instanceof TypeError, `${variable} was accepted`);
      assert.ok(outcome.message.includes(variable), outcome.message);
    }
  }),
  step("the demo stage is resolved from an environment that turns every limit off", noStepArguments, (world) => {
    world.settings = stageSettings(DEMO_STAGE, EVERY_LIMIT_OFF);
  }),
  step(
    "its Workers are named agris-demo, agris-demo-cache, agris-demo-market and agris-demo-catalog",
    noStepArguments,
    (world) => {
      assert.deepEqual(required(world).names, {
        gateway: "agris-demo",
        cache: "agris-demo-cache",
        market: "agris-demo-market",
        catalog: "agris-demo-catalog",
      });
    },
  ),
  step(
    "its gateway binds a client rate limit of 10 a minute and a global rate limit of 120 a minute",
    noStepArguments,
    (world) => {
      assert.deepEqual(boundRate(gateway(world).env, "CLIENT_RATE_LIMITER"), { limit: 10, period: 60 });
      assert.deepEqual(boundRate(gateway(world).env, "GLOBAL_RATE_LIMITER"), { limit: 120, period: 60 });
    },
  ),
  step(
    "its market Worker binds a Pearl Abyss rate limit of 20 a minute for the whole deployment and a concurrency of 2 per host",
    noStepArguments,
    (world) => {
      assert.deepEqual(boundRate(market(world).env, "PA_RATE_LIMITER"), { limit: 20, period: 60 });
      assert.equal(plainVariables(market(world).env).PA_MAX_CONCURRENT_REQUESTS, "2");
    },
  ),
  step(
    "its gateway keeps every storable answer for at least 600 seconds and labels every response as the demo",
    noStepArguments,
    (world) => {
      const variables = plainVariables(gateway(world).env);
      assert.equal(variables.CACHE_MINIMUM_SECONDS, "600");
      assert.match(variables.DEMO_NOTICE ?? "", /^Shared demo/u);
    },
  ),
];

export const deploySettingsFeature: ExecutableFeatureManifest<DeploySettingsWorld> = {
  id: "deploy-settings",
  uri: "tests/features/deploy-settings.feature",
  createWorld: () => ({}),
  steps,
};
