# @agris/core

Gateway request protocol, response classification and caching policy, the Service Binding coordinator, and market price freshness. `.` exports the protocol and coordinator, `./freshness` the price freshness constants, and `./testing` an in-process gateway over both subgraphs for tests.

It depends on the invocation budget. The gateway Worker supplies bindings; this package never imports a Worker.
