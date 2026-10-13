import assert from "node:assert/strict";

import { cacheFreshnessFromBindings, cacheFreshnessOverrideFromBindings } from "@agris/core";
import { gatewayCacheProps, gatewayProps } from "../../infra/src/gateway/props.ts";
import { marketProps } from "../../infra/src/market/props.ts";
import { DEMO_STAGE, DEFAULT_STAGE, stageSettings } from "../../infra/src/settings.ts";
import { buildSchema } from "graphql";

import { clientSchemaSdl } from "../../tools/schema/artifacts/gateway-schemas.ts";
import { DEMO, LIMIT_SETTINGS, SELF_HOSTED, type DeploymentFacts, type Rate } from "../../website/src/deployment.ts";
import {
  dataTableStepArgument,
  noStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";
import { boundRate, plainVariables } from "../support/deploy-bindings.ts";

interface SiteDeploymentFactsWorld {
  deployed?: { readonly selfHosted: DeploymentFacts; readonly demo: DeploymentFacts };
}

const clientSchema = buildSchema(clientSchemaSdl);

/**
 * What one stage's Workers would run with, read from the bindings its props declare and resolved by the gateway's own
 * parsers, so the site states what the deployment would serve.
 */
function deployedFacts(stage: string): DeploymentFacts {
  const settings = stageSettings(stage, {});
  const gateway = gatewayProps(settings);
  const market = marketProps(settings);
  const gatewayVariables = plainVariables(gateway.env);
  const cacheFreshness = cacheFreshnessFromBindings(gatewayVariables, clientSchema);
  const required = (rate: Rate | null, name: string): Rate => {
    assert.ok(rate !== null, `${stage} binds ${name}`);
    return rate;
  };
  const subrequestLimit = gateway.limits.subrequests;
  for (const props of [gateway, gatewayCacheProps(settings), market]) {
    assert.equal(props.limits.subrequests, subrequestLimit, `${props.name} shares the gateway's limits.subrequests`);
    assert.equal(plainVariables(props.env).SUBREQUEST_LIMIT, String(subrequestLimit), `${props.name} SUBREQUEST_LIMIT`);
  }
  return {
    clientRateLimit: boundRate(gateway.env, "CLIENT_RATE_LIMITER"),
    globalRateLimit: boundRate(gateway.env, "GLOBAL_RATE_LIMITER"),
    cacheFreshnessOverride: cacheFreshnessOverrideFromBindings(gatewayVariables, clientSchema) ?? null,
    cacheFreshness,
    freshnessFloorSeconds: cacheFreshness.minimumSeconds,
    pearlAbyssConcurrency: Number(plainVariables(market.env).PA_MAX_CONCURRENT_REQUESTS),
    pearlAbyssRateLimit: required(boundRate(market.env, "PA_RATE_LIMITER"), "PA_RATE_LIMITER"),
    subrequestLimit,
  };
}

const steps: readonly StepDefinition<SiteDeploymentFactsWorld>[] = [
  step("the self-hosted and demo stages of the deploy definition are loaded", noStepArguments, (world) => {
    world.deployed = { selfHosted: deployedFacts(DEFAULT_STAGE), demo: deployedFacts(DEMO_STAGE) };
  }),
  step(
    "the site's self-hosted limits and cache freshness are what a self-hosted stage deploys with nothing set",
    noStepArguments,
    (world) => {
      assert.deepEqual(SELF_HOSTED, world.deployed?.selfHosted);
    },
  ),
  step("the site's demo limits and cache freshness are what the demo stage deploys", noStepArguments, (world) => {
    assert.deepEqual(DEMO, world.deployed?.demo);
  }),
  step("the site lists these limit settings", dataTableStepArgument, (_world, table) => {
    const cell = (value: number | null) => (value === null ? "off" : String(value));
    assert.deepEqual(
      LIMIT_SETTINGS.map((setting) => ({
        variable: setting.variable,
        "self-hosted": cell(setting.selfHosted),
        demo: cell(setting.demo),
        "off with": setting.disable ?? "",
      })),
      table.hashes,
    );
  }),
];

export const siteDeploymentFactsFeature: ExecutableFeatureManifest<SiteDeploymentFactsWorld> = {
  id: "site-deployment-facts",
  uri: "tests/features/site-deployment-facts.feature",
  createWorld: () => ({}),
  steps,
};
