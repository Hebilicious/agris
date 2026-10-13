import { defineConfig } from "astro/config";

import { SITE_ORIGIN } from "./src/site.ts";

// A static site: `astro build` writes plain HTML, CSS and a few bytes of script to `dist/`, published as static assets
// on its own origin. The API it links to lives on another one (`DEMO_API_ORIGIN` in `src/site.ts`).
export default defineConfig({
  output: "static",
  site: SITE_ORIGIN,
  trailingSlash: "ignore",
  build: { format: "file" },
  devToolbar: { enabled: false },
  // ES2026 script. Vite turns a CSS target into browser versions and knows the browsers of ES2025 at most.
  vite: { build: { target: "es2026", cssTarget: "es2025" } },
});
