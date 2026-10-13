# @agris/core

Gateway request protocol, response classification and caching policy, the Service Binding coordinator, and market price freshness. `.` exports the protocol and coordinator; `./cache-freshness` the cache freshness policy (`DEFAULT_CACHE_FRESHNESS`, the `CACHE_*` setting names, `cacheFreshnessFromBindings`, `applyCacheFreshnessOverride`) on its own; `./document-limits` the public query limits and their `QUERY_*` settings; `./freshness` the price freshness constants; and `./testing` an in-process gateway over both subgraphs for tests. The `./cache-freshness`, `./document-limits` and `./freshness` modules import packages only by name, so Node loads them without a TypeScript loader.

It depends on the invocation budget. The gateway Worker supplies bindings; this package never imports a Worker.
