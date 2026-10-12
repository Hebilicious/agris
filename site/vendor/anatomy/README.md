# anatomy (vendored)

`iso-kit.ts`, `iso.css`, `iso-kit.mjs`, `lathe.mjs`, `tube.mjs` and `audit.mjs` are copied unchanged from [anatomy](https://github.com/wheresryan22/anatomy), Ryan's kit for isometric explanatory figures, at commit `689dcf966e63d92be10a5d593c6e19e10acd4422`. It is MIT licensed; see `LICENSE`.

The site's Fig 1 builds its static art with the kit at build time (`site/src/figure/art.ts`) and rebuilds a few moving parts with it in the browser (`site/src/figure/parts.ts`). The `.mjs` modules build the line to Pearl Abyss (`site/src/figure/line.ts`) and prove it with the kit's audit (`moon run site:figure-audit`). The `.d.mts` files are not upstream: they declare, for TypeScript, only the functions the site calls.

Keep the upstream files byte-identical to upstream so they can be updated by copying; this directory is excluded from oxlint and oxfmt for that reason. Put changes in `site/src/figure/` instead.
