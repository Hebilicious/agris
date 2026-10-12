import { defineConfig } from "astro/config";

// A static site: `astro build` writes plain HTML, CSS and a few bytes of script to `dist/`, which the demo gateway
// serves as Workers static assets.
export default defineConfig({
  output: "static",
  site: "https://agris-demo.hebilicious.workers.dev",
  trailingSlash: "ignore",
  build: { format: "file" },
  devToolbar: { enabled: false },
});
