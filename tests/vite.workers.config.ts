import { mkdirSync } from "node:fs";

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

import { loadWorkerConfiguration } from "@agris/tooling/cloudflare-worker-configuration";

const { worker } = await loadWorkerConfiguration("../workers/market", "production");

// The plugin writes Build Output under its root rather than `build.outDir`, so this evidence bundle gets a root of its
// own, apart from the Worker's `cf` builds: .artifacts/market-worker-runtime/.cloudflare/output/v0/workers/default/bundle.
const root = ".artifacts/market-worker-runtime";
mkdirSync(root, { recursive: true });

export default defineConfig({
  root,
  plugins: [...cloudflare({ config: worker })],
});
