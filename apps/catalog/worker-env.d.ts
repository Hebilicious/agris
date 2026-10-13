// The catalog Worker's runtime globals. It reads no bindings.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/index.ts");
  }
}
