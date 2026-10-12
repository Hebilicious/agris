import { defineWranglerConfig } from "wrangler/experimental-config";

// The caller answers on loopback only; `cf dev` does not forward an address flag.
export default defineWranglerConfig({ dev: { ip: "127.0.0.1" } });
