import type { PearlAbyssRequestSettlement } from "@agris/pearl-abyss/server";
import { setup, types } from "xstate";

type PearlAbyssExecutionAvailabilityEvent =
  | { readonly type: "FAILED" }
  | { readonly type: "RATE_LIMITED" }
  | { readonly type: "REFUSED" }
  | { readonly type: "SUCCEEDED" };

/**
 * What one market execution's Pearl Abyss reads add up to, which picks the market's HTTP status. One success is
 * `hasSuccess`, whatever else happened: the answer has data. Without one, a throttled read makes it `throttled` (a 429,
 * since retrying at once would be throttled again), and otherwise a read that failed to arrive makes it
 * `totalUnavailable` (a 503). A budget refusal sends nothing to Pearl Abyss and says nothing about it, so it changes
 * nothing: its field carries `QUERY_BUDGET_EXCEEDED` in a 200.
 */
export const pearlAbyssExecutionAvailabilityMachine = setup({
  schemas: {
    events: {
      FAILED: types<Omit<Extract<PearlAbyssExecutionAvailabilityEvent, { type: "FAILED" }>, "type">>(),
      RATE_LIMITED: types<Omit<Extract<PearlAbyssExecutionAvailabilityEvent, { type: "RATE_LIMITED" }>, "type">>(),
      REFUSED: types<Omit<Extract<PearlAbyssExecutionAvailabilityEvent, { type: "REFUSED" }>, "type">>(),
      SUCCEEDED: types<Omit<Extract<PearlAbyssExecutionAvailabilityEvent, { type: "SUCCEEDED" }>, "type">>(),
    },
  },
}).createMachine({
  id: "pearlAbyssExecutionAvailability",
  initial: "notAttempted",
  states: {
    notAttempted: {
      on: {
        FAILED: { target: "totalUnavailable" },
        RATE_LIMITED: { target: "throttled" },
        REFUSED: {},
        SUCCEEDED: { target: "hasSuccess" },
      },
    },
    totalUnavailable: {
      on: {
        FAILED: {},
        RATE_LIMITED: { target: "throttled" },
        REFUSED: {},
        SUCCEEDED: { target: "hasSuccess" },
      },
    },
    throttled: {
      on: {
        FAILED: {},
        RATE_LIMITED: {},
        REFUSED: {},
        SUCCEEDED: { target: "hasSuccess" },
      },
    },
    hasSuccess: {
      on: {
        FAILED: {},
        RATE_LIMITED: {},
        REFUSED: {},
        SUCCEEDED: {},
      },
    },
  },
});

export const settlementEvents = {
  failed: { type: "FAILED" },
  "rate-limited": { type: "RATE_LIMITED" },
  refused: { type: "REFUSED" },
  succeeded: { type: "SUCCEEDED" },
} as const satisfies Readonly<Record<PearlAbyssRequestSettlement, PearlAbyssExecutionAvailabilityEvent>>;
