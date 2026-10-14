import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";

import { headersFileOf, inlineSourcesOf } from "./src/security-headers.ts";
import { SITE_ORIGIN } from "./src/site.ts";

/** Writes `dist/_headers` from the pages the build wrote, so the policy allows exactly their inline elements. */
const securityHeaders: AstroIntegration = {
  name: "agris-security-headers",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      const root = fileURLToPath(dir);
      const files = await readdir(root, { recursive: true });
      const pages = await Promise.all(
        files.filter((file) => file.endsWith(".html")).map((file) => readFile(join(root, file), "utf8")),
      );
      await writeFile(join(root, "_headers"), headersFileOf(inlineSourcesOf(pages)));
    },
  },
};

// A static site: `astro build` writes plain HTML, CSS and a few bytes of script to `dist/`, published as static assets
// on its own origin. The API it links to lives on another one (`DEMO_API_ORIGIN` in `src/site.ts`).
export default defineConfig({
  output: "static",
  site: SITE_ORIGIN,
  trailingSlash: "ignore",
  build: { format: "file" },
  devToolbar: { enabled: false },
  integrations: [securityHeaders],
  // ES2026 script. Vite turns a CSS target into browser versions and knows the browsers of ES2025 at most.
  vite: { build: { target: "es2026", cssTarget: "es2025" } },
});
