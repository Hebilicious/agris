import { defineWranglerConfig } from "wrangler/experimental-config";

// Each local Worker takes its own inspector port, so `moon run agris:dev` can start them side by side.
export default defineWranglerConfig({ dev: { inspectorPort: 9792 } });
