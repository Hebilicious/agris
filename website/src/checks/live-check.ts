/**
 * Checks the pure half of the live examples, run by `moon run website:live-check`: how `classify` sorts every kind of
 * answer the demo can give, and that the result panel's JSON tokens print exactly what `JSON.stringify` prints. The
 * panel itself is checked in a browser against the live demo.
 */
import assert from "node:assert/strict";

import { cacheReportOf, classify, retryAfterOf, type Answer } from "../live/client.ts";
import { jsonTextOf, jsonTokens } from "../live/json.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");

function answer(status: number, body: string, headers: Record<string, string> = {}): Answer {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    header: (name) => lower.get(name.toLowerCase()) ?? null,
    bodyText: body,
    ms: 120,
    fallbackRetryAfter: 60,
    now: NOW,
  };
}

const checks: [string, () => void][] = [
  [
    "a body with data and no errors is data, with its cache headers",
    () => {
      const result = classify(
        answer(200, '{"data":{"item":{"name":"Black Stone"}}}', {
          "Cf-Cache-Status": "hit",
          Age: "42",
          "Cache-Control": "public, max-age=600",
          "X-Central-Market-Source": "cache-fresh",
        }),
      );
      assert.equal(result.kind, "data");
      if (result.kind !== "data") return;
      assert.deepEqual(result.cache, {
        edge: "HIT",
        age: 42,
        control: "public, max-age=600",
        source: "cache-fresh",
      });
      assert.deepEqual(result.body, { data: { item: { name: "Black Stone" } } });
    },
  ],
  [
    "errors beside partial data are errors, with every message",
    () => {
      const result = classify(answer(200, '{"data":{"a":null},"errors":[{"message":"one"},{"message":"two"}]}'));
      assert.equal(result.kind, "errors");
      if (result.kind === "errors") assert.deepEqual(result.messages, ["one", "two"]);
    },
  ],
  [
    "a refused document is errors with its 400 status",
    () => {
      const result = classify(answer(400, '{"errors":[{"message":"Cannot query field \\"nope\\""}]}'));
      assert.equal(result.kind, "errors");
      if (result.kind === "errors") assert.equal(result.status, 400);
    },
  ],
  [
    "a 429 is busy for its Retry-After seconds",
    () =>
      assert.deepEqual(classify(answer(429, "{}", { "Retry-After": "42" })), {
        kind: "busy",
        sent: true,
        ms: 120,
        retryAfter: 42,
      }),
  ],
  [
    "a 429 without a usable Retry-After waits out the rate window",
    () => {
      const result = classify(answer(429, "not json", { "Retry-After": "soon" }));
      assert.equal(result.kind === "busy" ? result.retryAfter : null, 60);
    },
  ],
  [
    "a Retry-After date counts the seconds from now",
    () => assert.equal(retryAfterOf(new Date(NOW + 30_500).toUTCString(), { fallbackRetryAfter: 60, now: NOW }), 30),
  ],
  ["a body that is not JSON is a failure", () => assert.equal(classify(answer(200, "<html>")).kind, "failed")],
  ["an empty error body is a failure", () => assert.equal(classify(answer(502, "")).kind, "failed")],
  [
    "JSON that is not a GraphQL response is a failure",
    () => {
      assert.equal(classify(answer(200, '{"hello":1}')).kind, "failed");
      assert.equal(classify(answer(200, '{"errors":"nope"}')).kind, "failed");
      assert.equal(classify(answer(200, '{"errors":[{"code":1}]}')).kind, "failed");
      assert.equal(classify(answer(200, "[1,2]")).kind, "failed");
    },
  ],
  [
    "a non-2xx status without errors is a failure",
    () => assert.equal(classify(answer(503, '{"data":null}')).kind, "failed"),
  ],
  [
    "missing cache headers are null",
    () =>
      assert.deepEqual(
        cacheReportOf(() => null),
        { edge: null, age: null, control: null, source: null },
      ),
  ],
  [
    "JSON tokens print exactly what JSON.stringify prints",
    () => {
      const values: unknown[] = [
        null,
        true,
        -1.5e-7,
        'quote " backslash \\ newline \n 기억의 파편',
        [],
        {},
        [[], {}, [1, [2, { a: [] }]]],
        { data: { market: { items: [{ id: "44195", price: 2_450_000, listed: false, grade: null }] } }, errors: [] },
      ];
      for (const value of values) assert.equal(jsonTextOf(jsonTokens(value)), JSON.stringify(value, null, 2));
    },
  ],
  [
    "object keys are keys and string values are strings",
    () => {
      const kinds = jsonTokens({ name: "x", n: 1 })
        .filter((token) => token.kind !== "space" && token.kind !== "punctuation")
        .map((token) => `${token.kind}:${token.text}`);
      assert.deepEqual(kinds, ['key:"name"', 'string:"x"', 'key:"n"', "number:1"]);
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) {
  console.error(`${failed} of ${checks.length} live-example checks failed.`);
  process.exit(1);
}
console.log(
  `${checks.length} live-example checks passed: answers sort into data, errors, busy and failed, and JSON prints as JSON.stringify does.`,
);
