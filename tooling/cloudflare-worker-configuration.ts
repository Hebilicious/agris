import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  convertToWranglerConfig,
  loadAndParseConfig,
  loadConfig,
  type ConfigContext,
  type ParsedInputWorkerConfig,
} from "@cloudflare/config";
import type { Unstable_RawConfig } from "wrangler";
import type { WranglerConfig } from "wrangler/experimental-config";

/** A Worker directory holding `cloudflare.config.ts`, and one of its modes. */
export interface WorkerSource {
  readonly directory: string;
  readonly mode: string;
}

/**
 * One Worker's configuration, evaluated for one mode.
 *
 * `cloudflare.config.ts` is the only place a Worker's deployment, bindings and local runtimes are declared, and
 * `wrangler.config.ts` beside it, where a Worker has one, holds the build settings Wrangler bundles with. Everything else reads a Worker through
 * this module: `cf` itself for dev, build and deploy, and the tools that still accept only a Wrangler configuration,
 * which get one generated from the same source.
 */
export interface WorkerConfiguration {
  /** The absolute directory holding the Worker's `cloudflare.config.ts`. */
  readonly directory: string;
  readonly mode: string;
  /** The mode's Worker as `@cloudflare/config` parses it, with an absolute entrypoint, for the Vite plugin. */
  readonly worker: ParsedInputWorkerConfig;
  /** The Wrangler configuration equivalent to this mode, with its build settings and absolute paths. */
  readonly wrangler: Unstable_RawConfig;
}

/** Evaluate a Worker's configuration for one mode, as `cf` evaluates it for `--mode`. */
/* BOUNDARY: `cloudflare.config.ts` is read from disk and parsed by `@cloudflare/config` before anything uses it. */
export async function loadWorkerConfiguration(directory: string, mode: string): Promise<WorkerConfiguration> {
  const workerDirectory = resolve(directory);
  const context: ConfigContext = { mode, isPreview: false };
  const { result } = await loadAndParseConfig(join(workerDirectory, "cloudflare.config.ts"), context);
  if (!result.success) {
    throw new TypeError(`${workerDirectory}/cloudflare.config.ts is invalid in mode ${mode}: ${result.error.message}`);
  }
  const parsedWorker = result.data.worker;
  if (parsedWorker === undefined)
    throw new TypeError(`${workerDirectory}/cloudflare.config.ts defines no Worker in mode ${mode}.`);
  const worker: ParsedInputWorkerConfig =
    typeof parsedWorker.entrypoint === "string"
      ? { ...parsedWorker, entrypoint: resolve(workerDirectory, parsedWorker.entrypoint) }
      : parsedWorker;
  const build = await loadBuildSettings(workerDirectory, context);
  const converted: Unstable_RawConfig = convertToWranglerConfig(result.data);
  const main = converted.main === undefined ? undefined : resolve(workerDirectory, converted.main);
  const assetsDirectory =
    build.assetsDirectory === undefined ? undefined : resolve(workerDirectory, build.assetsDirectory);
  const wrangler: Unstable_RawConfig = {
    ...converted,
    ...(main === undefined ? undefined : { main }),
    ...(build.rules === undefined ? undefined : { rules: build.rules }),
    ...(converted.assets === undefined && assetsDirectory === undefined
      ? undefined
      : {
          assets: {
            ...converted.assets,
            ...(assetsDirectory === undefined ? undefined : { directory: assetsDirectory }),
          },
        }),
  };
  return { directory: workerDirectory, mode, worker, wrangler };
}

/**
 * Write the mode's Wrangler configuration where a tool that reads only Wrangler files can load it.
 *
 * The file lives in the Worker's ignored `.cloudflare/` directory and is rewritten on every call, so it is never a
 * second source of truth: it is `cloudflare.config.ts`, spelled the way Wrangler reads it.
 */
export async function writeWranglerConfiguration(configuration: WorkerConfiguration): Promise<string> {
  const directory = join(configuration.directory, ".cloudflare", "wrangler");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${configuration.mode}.json`);
  await writeFile(path, `${JSON.stringify(configuration.wrangler, null, 2)}\n`);
  return path;
}

/** The build settings this repository declares in `wrangler.config.ts`. */
interface BuildSettings {
  readonly rules?: NonNullable<WranglerConfig["rules"]>;
  readonly assetsDirectory?: string;
}

const MODULE_RULE_TYPES = new Set([
  "ESModule",
  "CommonJS",
  "CompiledWasm",
  "Text",
  "Data",
  "PythonModule",
  "PythonRequirement",
]);

/* BOUNDARY: `wrangler.config.ts` is loaded as a module; only the settings this repository declares are read from it. */
async function loadBuildSettings(directory: string, context: ConfigContext): Promise<BuildSettings> {
  const path = join(directory, "wrangler.config.ts");
  // A Worker without build settings of its own has no `wrangler.config.ts`, and Wrangler's defaults apply.
  if (!existsSync(path)) return {};
  // `loadConfig` imports through Node itself, so a host that loads this module through its own runner, as Vite's
  // config loader does, still evaluates the file.
  const { config: exported } = await loadConfig(path);
  const settings: unknown = typeof exported === "function" ? await exported(context) : await exported;
  if (!isRecord(settings)) throw new TypeError(`${path} must export Wrangler build settings.`);
  const { rules, assetsDirectory } = settings;
  if (assetsDirectory !== undefined && (typeof assetsDirectory !== "string" || isAbsolute(assetsDirectory))) {
    throw new TypeError(`${path} must name assetsDirectory relative to the Worker.`);
  }
  if (rules !== undefined && !Array.isArray(rules)) throw new TypeError(`${path} must declare rules as a list.`);
  return {
    ...(rules === undefined ? undefined : { rules: rules.map((rule: unknown) => moduleRule(rule, path)) }),
    ...(assetsDirectory === undefined ? undefined : { assetsDirectory }),
  };
}

/* BOUNDARY: One module rule read from `wrangler.config.ts`, validated field by field. */
function moduleRule(rule: unknown, path: string): NonNullable<WranglerConfig["rules"]>[number] {
  const globs: unknown = isRecord(rule) ? rule.globs : undefined;
  const strings = Array.isArray(globs) ? globs.filter((glob: unknown): glob is string => typeof glob === "string") : [];
  if (
    !isRecord(rule) ||
    !isModuleRuleType(rule.type) ||
    !Array.isArray(globs) ||
    strings.length !== globs.length ||
    (rule.fallthrough !== undefined && typeof rule.fallthrough !== "boolean")
  ) {
    throw new TypeError(`${path} declares a module rule Wrangler cannot read.`);
  }
  return {
    type: rule.type,
    globs: strings,
    ...(rule.fallthrough === undefined ? undefined : { fallthrough: rule.fallthrough }),
  };
}

/* BOUNDARY: A module rule type read from `wrangler.config.ts`. */
function isModuleRuleType(value: unknown): value is NonNullable<WranglerConfig["rules"]>[number]["type"] {
  return typeof value === "string" && MODULE_RULE_TYPES.has(value);
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
