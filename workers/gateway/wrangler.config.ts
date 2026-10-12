import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig(({ mode }) => ({
  rules: [{ type: "Text", globs: ["**/*.graphql"], fallthrough: true }],
  // Only the hosted demo serves the static site: the Astro build output in `site/dist` (`moon run site:build`).
  ...(mode === "demo" ? { assetsDirectory: "../../site/dist" } : undefined),
  // Each local Worker takes its own inspector port, so `moon run agris:dev` can start them side by side.
  dev: { inspectorPort: 9790 },
}));
