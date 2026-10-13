/**
 * The step strip over Fig 1 and the sentence under it: which stage of the request path the card is in, how each stage
 * ended, and what to try next. Pure functions of one job's pose, so the strip always agrees with the moving parts.
 */
import { ageOf, windowOf, type FigureQuery, type Outcome, type RateLimit } from "./model.ts";
import { STOPS, type Job, type Pose } from "./timeline.ts";

export type StepId = "limit" | "key" | "cache" | "federation" | "upstream" | "answer";

/** The six stages, in the order a request meets them, with the part of the machine that does each. */
export const STEPS: readonly { readonly id: StepId; readonly label: string; readonly part: string }[] = [
  { id: "limit", label: "Rate limit", part: "turnstile" },
  { id: "key", label: "Cache key", part: "punch" },
  { id: "cache", label: "Edge cache", part: "rack" },
  { id: "federation", label: "Federation", part: "splitter" },
  { id: "upstream", label: "Pearl Abyss", part: "carousel" },
  { id: "answer", label: "Answer", part: "stamp" },
];

export type StepState = "waiting" | "active" | "done" | "skipped" | "failed";

/** The answer's cache status, as the response's headers would report it; `working` until the rack has been checked. */
export type Status = "idle" | "working" | "hit" | "miss" | "stale" | "bypass" | "rejected";

export interface StepView {
  readonly states: Readonly<Record<StepId, StepState>>;
  /** The short tag on the cache step once it is known: `HIT`, `MISS`, `STALE`, `BYPASS`, or `429` on the limit. */
  readonly tag: string;
  readonly status: Status;
  readonly narration: string;
}

/** What the machine knows besides the pose: the limiter, and how many requests the current window has left. */
export interface StepContext {
  readonly rate: RateLimit;
  readonly left: number;
}

export function statusOf(outcome: Outcome): Exclude<Status, "idle" | "working"> {
  switch (outcome.kind) {
    case "rejected":
      return "rejected";
    case "hit":
      return "hit";
    case "stale":
      return "stale";
    case "miss":
      return outcome.stored ? "miss" : "bypass";
  }
}

const TAGS: Record<Exclude<Status, "idle" | "working">, string> = {
  rejected: "429",
  hit: "HIT",
  stale: "STALE",
  miss: "MISS",
  bypass: "BYPASS",
};

const all = (state: StepState): Record<StepId, StepState> => ({
  limit: state,
  key: state,
  cache: state,
  federation: state,
  upstream: state,
  answer: state,
});

export const IDLE_VIEW: StepView = {
  states: all("waiting"),
  tag: "",
  status: "idle",
  narration: "Pick a query and press Send. The card starts in the tray on the left.",
};

const calls = (count: number) => `${count} ${count === 1 ? "call" : "calls"}`;

/** The step strip and narration for one job at one instant. */
export function stepsAt(job: Job, pose: Pose, context: StepContext): StepView {
  const { query, outcome } = job;
  const status = statusOf(outcome);
  const tag = TAGS[status];

  if (outcome.kind === "rejected") {
    if (pose.phase === "sending")
      return {
        states: { ...all("waiting"), limit: "active" },
        tag: "",
        status: "working",
        narration: "The card reaches the turnstile, which counts every request in a one-minute window.",
      };
    return {
      states: { ...all("skipped"), limit: "failed" },
      tag,
      status,
      narration: `Turned away: that is more than ${context.rate.limit} in a minute. The visitor gets a 429 and may retry in ${outcome.retryAfter} s. Nothing went further, so Pearl Abyss never noticed.`,
    };
  }

  const fetching = pose.catalogShuttle > 0.02 || pose.marketShuttle > 0.02;
  const calling = pose.beads.some((share) => share >= 0);
  const called = query.market && pose.unloaded > 0.5;

  if (pose.phase === "sending") {
    const atGate = pose.card.x <= STOPS.gate + 1;
    return {
      states: { ...all("waiting"), limit: atGate ? "active" : "done", key: atGate ? "waiting" : "active" },
      tag: "",
      status: "working",
      narration: atGate
        ? `The turnstile counts the card and lets it through: ${context.left} more ${context.left === 1 ? "request is" : "requests are"} allowed this minute.`
        : "Through the turnstile and on to the punch.",
    };
  }
  if (pose.phase === "punching")
    return {
      states: { ...all("waiting"), limit: "done", key: "active" },
      tag: "",
      status: "working",
      narration: `The punch turns the query into its cache key, ${query.key}. The same question, however it is typed, gets the same holes.`,
    };
  if (pose.phase === "checking")
    return {
      states: { ...all("waiting"), limit: "done", key: "done", cache: "active" },
      tag: "",
      status: "working",
      narration:
        query.policy.mode === "no-store"
          ? "This query is never stored, so its pigeonhole is blanked off. The card goes straight past."
          : "The rack looks for an answer filed under that key.",
    };

  const done = pose.done;
  const answer: StepState = done ? "done" : pose.phase === "fetching" ? "waiting" : "active";

  if (outcome.kind === "hit")
    return {
      states: { limit: "done", key: "done", cache: "done", federation: "skipped", upstream: "skipped", answer },
      tag,
      status,
      narration: done
        ? `HIT. Answered from the cache, ${ageOf(outcome.age)} old, with no subgraph and no call to Pearl Abyss. Skip ahead to watch it go stale.`
        : `HIT: a fresh answer was waiting, ${ageOf(outcome.age)} old. It goes straight back to the tray.`,
    };

  if (outcome.kind === "stale") {
    const refreshed = pose.filed;
    return {
      states: {
        limit: "done",
        key: "done",
        cache: "done",
        federation: refreshed ? "done" : fetching ? "active" : "waiting",
        upstream: !query.market ? "skipped" : refreshed || called ? "done" : calling ? "active" : "waiting",
        answer,
      },
      tag,
      status,
      narration: refreshed
        ? `STALE, then refreshed. The visitor got the old answer at once, ${ageOf(outcome.age)} old, and a fresh one is now filed for the next card.`
        : `STALE: the answer is past its fresh window. It goes back at once while a refresh runs behind it.`,
    };
  }

  // A miss, stored or not.
  const federation: StepState = pose.phase === "fetching" ? (calling ? "done" : "active") : "done";
  const upstream: StepState = !query.market
    ? "skipped"
    : pose.phase !== "fetching"
      ? "done"
      : calling
        ? "active"
        : called
          ? "done"
          : "waiting";
  return {
    states: { limit: "done", key: "done", cache: "done", federation, upstream, answer },
    tag,
    status,
    narration: missNarration(query, outcome, pose, calling),
  };
}

function missNarration(query: FigureQuery, outcome: Outcome, pose: Pose, calling: boolean): string {
  const stored = outcome.kind === "miss" && outcome.stored;
  switch (pose.phase) {
    case "fetching":
      if (calling)
        return `The market's coordinator calls Pearl Abyss: ${calls(query.upstreamCalls)}, out along the one line that leaves the bench and back.`;
      if (!query.market) return "Only names are asked for, so only the catalog's drawer opens. No call to Pearl Abyss.";
      return stored
        ? "MISS: nothing filed yet. Hive Gateway splits the query: names from the catalog, prices from the market."
        : "Hive Gateway splits the query: names and search from the catalog, live summaries from the market.";
    case "stamping":
      return stored
        ? `The stamp marks the answer with how long it may be kept: ${windowOf(query.policy)}.`
        : "The stamp marks the answer never to be stored.";
    case "filing":
      return "The answer is filed in its pigeonhole, and its hourglass starts to run.";
    case "returning":
      return "The answer goes back to the tray.";
    default:
      return stored
        ? `MISS, now filed: ${windowOf(query.policy)}. Send it again to see a HIT.`
        : "BYPASS: this answer is never stored, so every one of these runs. Try Prices to see the cache work.";
  }
}
