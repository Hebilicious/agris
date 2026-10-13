import { setup, types } from "xstate";

type PearlAbyssExecutionAvailabilityEvent = { readonly type: "FAILED" } | { readonly type: "SUCCEEDED" };

export const pearlAbyssExecutionAvailabilityMachine = setup({
  schemas: {
    events: {
      FAILED: types<Omit<Extract<PearlAbyssExecutionAvailabilityEvent, { type: "FAILED" }>, "type">>(),
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
        SUCCEEDED: { target: "hasSuccess" },
      },
    },
    totalUnavailable: {
      on: {
        FAILED: {},
        SUCCEEDED: { target: "hasSuccess" },
      },
    },
    hasSuccess: {
      on: {
        FAILED: {},
        SUCCEEDED: {},
      },
    },
  },
});

export const settlementEvents = {
  failed: { type: "FAILED" },
  succeeded: { type: "SUCCEEDED" },
} as const satisfies Readonly<Record<"failed" | "succeeded", PearlAbyssExecutionAvailabilityEvent>>;
