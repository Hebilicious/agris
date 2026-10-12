import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Build the Worker in the current directory for one mode and keep its bundle at a destination.
 *
 * `cf build` always writes `.cloudflare/output/v0`, which every build of the Worker shares, so a release diagnostic
 * that read it there could see whichever mode built last. The bundle is copied out while it is still this mode's.
 */

const [mode, destination] = process.argv.slice(2);
if (mode === undefined || destination === undefined) {
  throw new Error("Usage: cloudflare-bundle-retain.ts <mode> <destination-directory>");
}

const build = spawnSync("cf", ["build", "--mode", mode], { stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`cf build --mode ${mode} exited with ${String(build.status)}.`);

const target = resolve(destination);
await rm(target, { recursive: true, force: true });
await cp(resolve(".cloudflare/output/v0/workers/default/bundle"), target, { recursive: true });
