/**
 * The choreography of one card, as pure functions of time since it was sent. The live script asks where every part
 * stands at `t`; reduced motion asks for the end. Nothing here reads a clock or the DOM.
 */
import { AT } from "./layout.ts";
import type { FigureQuery, Outcome } from "./model.ts";

/** Where the card stops along the track, in world x. */
export const STOPS = {
  tray: AT.tray,
  gate: AT.turnstile - 14,
  punch: AT.punch,
  splitter: AT.splitter - 4,
  stamp: AT.stamp,
} as const;

/** How long one call takes to run out to Pearl Abyss and back along the line, and how far apart calls leave. */
export const TRIP = { seconds: 2, stagger: 0.25 } as const;

export interface Job {
  readonly query: FigureQuery;
  readonly outcome: Outcome;
  /** The pigeonhole column the card stops in front of, in world x. */
  readonly rackX: number;
  /** How many calls the carousel runs at once (`MachineFacts.carriages`). */
  readonly carriages: number;
}

/** Everything the figure moves, for one job at one instant. Shares run 0 (rest) to 1 (full travel). */
export interface Pose {
  readonly card: {
    readonly x: number;
    readonly lift: number;
    readonly shown: boolean;
    readonly holes: number;
    readonly stamped: boolean;
  };
  readonly gate: number;
  readonly ram: number;
  readonly stamp: number;
  readonly lock: number;
  readonly stub: number;
  readonly catalogShuttle: number;
  readonly marketShuttle: number;
  readonly drawer: number;
  /** Cradles loaded so far, and the share of the step the table has made toward the next one. */
  readonly loaded: number;
  readonly unloaded: number;
  readonly step: number;
  /** One entry per upstream call: how far through its round trip on the line (0 to 1), or -1 before or after. */
  readonly beads: readonly number[];
  /** The phase word for the readout, from the same instant as the parts. */
  readonly phase: Phase;
  /** Whether the answer has been filed yet (a stored miss, or a stale answer's background refresh). */
  readonly filed: boolean;
  readonly done: boolean;
}

export type Phase =
  | "sending"
  | "punching"
  | "checking"
  | "answered"
  | "fetching"
  | "stamping"
  | "filing"
  | "returning"
  | "done";

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
/** Eased share of a span [a, b] at time t. */
const span = (t: number, [a, b]: readonly [number, number]) => ease((t - a) / (b - a));
/** Up over [a, b], held, back down over [c, d]. */
const pulse = (t: number, a: number, b: number, c: number, d: number) => span(t, [a, b]) * (1 - span(t, [c, d]));
const between = (from: number, to: number, share: number) => from + (to - from) * share;

/** The upstream round trip, from the moment the plan reaches the splitter. */
function fetchTimes(query: FigureQuery, start: number, carriages: number) {
  const calls = Math.min(query.upstreamCalls, carriages);
  const loadEnd = start + 0.8 + calls * 0.35;
  const market = query.market
    ? {
        out: [start, start + 0.8],
        load: start + 0.8,
        loadEnd,
        bead: [loadEnd, loadEnd + (calls - 1) * TRIP.stagger + TRIP.seconds],
        back: [
          loadEnd + (calls - 1) * TRIP.stagger + TRIP.seconds + 0.1,
          loadEnd + (calls - 1) * TRIP.stagger + TRIP.seconds + 0.8,
        ],
      }
    : null;
  const catalog = query.catalog
    ? {
        out: [start, start + 0.8],
        open: [start + 0.85, start + 1.15],
        close: [start + 1.55, start + 1.85],
        back: [start + 1.9, start + 2.7],
      }
    : null;
  const end = Math.max(market?.back[1] ?? start, catalog?.back[1] ?? start);
  return { calls, market, catalog, end };
}

/** How long a job runs, end to end. */
export function durationOf(job: Job): number {
  return poseTimes(job).end;
}

function poseTimes(job: Job) {
  const { outcome, query } = job;
  if (outcome.kind === "rejected") return { end: 2.5, fetch: null, answer: 0, fileAt: Number.POSITIVE_INFINITY };
  if (outcome.kind === "hit" || outcome.kind === "stale") {
    const fetch = outcome.kind === "stale" ? fetchTimes(query, 4.1, job.carriages) : null;
    const end = Math.max(6, fetch === null ? 0 : fetch.end + 0.6);
    return { end, fetch, answer: 3.85, fileAt: fetch === null ? Number.POSITIVE_INFINITY : fetch.end + 0.3 };
  }
  const fetch = fetchTimes(query, 4.5, job.carriages);
  const answer = fetch.end + 0.1;
  const stored = outcome.stored;
  const back = answer + (stored ? 2 : 1.4);
  return { end: back + 1.6, fetch, answer, fileAt: stored ? answer + 1.6 : Number.POSITIVE_INFINITY };
}

export function poseAt(job: Job, t: number): Pose {
  const { outcome, rackX } = job;
  const times = poseTimes(job);
  const lift = span(t, [0, 0.35]) * (1 - span(t, [times.end - 0.35, times.end]));
  const base = {
    gate: 0,
    ram: 0,
    stamp: 0,
    lock: 0,
    stub: 0,
    catalogShuttle: 0,
    marketShuttle: 0,
    drawer: 0,
    loaded: 0,
    unloaded: 0,
    step: 0,
    beads: [],
    filed: t >= times.fileAt,
    done: t >= times.end,
  };

  if (outcome.kind === "rejected") {
    // The pawl holds the wheel, the gate stays down, and the card goes back to the tray.
    const x =
      t < 1.0
        ? between(STOPS.tray, STOPS.gate, span(t, [0.35, 1.0]))
        : between(STOPS.gate, STOPS.tray, span(t, [1.25, 2.1]));
    const nudge = Math.sin(Math.min(1, Math.max(0, (t - 1) / 0.25)) * Math.PI) * 2.2;
    return {
      ...base,
      card: { x: x + nudge, lift, shown: t < times.end, holes: 0, stamped: false },
      phase: t < 1.0 ? "sending" : t < times.end ? "answered" : "done",
    };
  }

  const gate = pulse(t, 0.95, 1.25, 1.65, 1.95);
  const ram = pulse(t, 1.85, 2.05, 2.1, 2.35);
  const holes = span(t, [2.0, 2.1]);
  let x: number;
  if (t < 1.0) x = between(STOPS.tray, STOPS.gate, span(t, [0.35, 1.0]));
  else if (t < 1.8) x = between(STOPS.gate, STOPS.punch, span(t, [1.15, 1.8]));
  else if (t < 2.35) x = STOPS.punch;
  else x = between(STOPS.punch, rackX, span(t, [2.35, 3.3]));

  if (outcome.kind === "hit" || outcome.kind === "stale") {
    const lock = span(t, [3.3, 3.6]) * (1 - span(t, [4.4, 4.7]));
    const stub = pulse(t, 3.5, 3.85, 3.95, 4.3);
    if (t >= 4.3) x = between(rackX, STOPS.tray, span(t, [4.3, 5.7]));
    const pose = times.fetch === null ? null : fetchPose(times.fetch, t);
    return {
      ...base,
      ...pose,
      gate,
      ram,
      lock,
      stub,
      card: { x, lift, shown: t < times.end - 0.0 && t < 6, holes, stamped: t >= times.answer },
      phase: t < 2.35 ? (t < 1.8 ? "sending" : "punching") : t < 3.3 ? "checking" : t < times.end ? "answered" : "done",
    };
  }

  // A miss: on past the stamp to the splitter, out to the subgraphs, back, stamped, filed if storable, home.
  const answer = times.answer;
  const stored = outcome.stored;
  if (t >= 3.3 && t < answer) x = between(rackX, STOPS.splitter, span(t, [3.4, 4.4]));
  if (t >= answer) {
    const toStamp = between(STOPS.splitter, STOPS.stamp, span(t, [answer, answer + 0.35]));
    x = toStamp;
    if (t >= answer + 0.95) x = between(STOPS.stamp, rackX, span(t, [answer + 0.95, answer + 1.5]));
    const home = answer + (stored ? 2 : 1.5);
    if (t >= home) x = between(rackX, STOPS.tray, span(t, [home, home + 1.3]));
  }
  const stamp = pulse(t, answer + 0.35, answer + 0.55, answer + 0.6, answer + 0.9);
  const lock = stored
    ? pulse(t, 3.3, 3.45, 3.5, 3.65) * 0.25 + pulse(t, answer + 1.5, answer + 1.65, answer + 1.95, answer + 2.1)
    : pulse(t, 3.3, 3.45, 3.5, 3.65) * 0.25;
  const stub = stored ? 1 - span(t, [answer + 1.55, answer + 1.95]) : 0;
  const fetch = times.fetch === null ? null : fetchPose(times.fetch, t);
  const phase: Phase =
    t < 1.8
      ? "sending"
      : t < 2.35
        ? "punching"
        : t < 3.4
          ? "checking"
          : t < answer
            ? "fetching"
            : t < answer + 0.95
              ? "stamping"
              : stored && t < answer + 2
                ? "filing"
                : t < times.end
                  ? "returning"
                  : "done";
  return {
    ...base,
    ...fetch,
    gate,
    ram,
    stamp,
    lock,
    stub: t >= answer + 1.5 && stored ? stub : 0,
    card: { x, lift, shown: t < times.end, holes, stamped: t >= answer + 0.55 },
    phase,
  };
}

function fetchPose(fetch: ReturnType<typeof fetchTimes>, t: number) {
  const { market, catalog, calls } = fetch;
  const catalogShuttle =
    catalog === null ? 0 : span(t, catalog.out as [number, number]) * (1 - span(t, catalog.back as [number, number]));
  const drawer =
    catalog === null ? 0 : pulse(t, catalog.open[0]!, catalog.open[1]!, catalog.close[0]!, catalog.close[1]!);
  if (market === null) return { catalogShuttle, drawer, marketShuttle: 0, loaded: 0, unloaded: 0, step: 0, beads: [] };
  const marketShuttle = span(t, market.out as [number, number]) * (1 - span(t, market.back as [number, number]));
  const sinceLoad = t - market.load;
  const loaded = Math.max(0, Math.min(calls, Math.floor(sinceLoad / 0.35) + (sinceLoad >= 0 ? 1 : 0)));
  // The table steps one cradle after each capsule is loaded.
  let step = 0;
  for (let index = 0; index < calls; index++)
    step += span(t, [market.load + index * 0.35 + 0.1, market.load + index * 0.35 + 0.33]);
  const [b0, b1] = market.bead as [number, number];
  const beads = Array.from({ length: calls }, (_, index) => {
    const share = (t - b0 - index * TRIP.stagger) / TRIP.seconds;
    return share < 0 || share > 1 ? -1 : share;
  });
  const unloaded = span(t, [b1 + 0.1, b1 + 0.4]);
  return { catalogShuttle, drawer, marketShuttle, loaded, unloaded, step, beads };
}
