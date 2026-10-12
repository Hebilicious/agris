/**
 * The browser side of Fig 1. One loop reads the model and the timeline and writes attributes on the parts the build
 * drew. It runs only while the figure is on screen and something is moving, and goes still under reduced motion.
 */
import { iso, translateAlong, type Point3 } from "../../vendor/anatomy/iso-kit.ts";
import {
  AT,
  CABINET,
  CABINET_FACE,
  CARD,
  CARD_Z,
  CAROUSEL,
  CATALOG_ROD,
  CELL,
  CELLS,
  DRAWER,
  GATE,
  GLAND,
  HOLE,
  LINE,
  MARKET_ROD,
  P,
  PUNCH,
  STAMP,
  TERMINAL,
  TRACK,
  TRAY_FLOOR,
  TRAY_STACK,
  WIDTH,
} from "./layout.ts";

const TRACK_Y = TRACK.y;
import {
  INITIAL_STATE,
  RATE_LIMIT,
  allowanceAt,
  exhaust,
  file,
  hourglassOf,
  readoutOf,
  send,
  windowAt,
  QUERY_KINDS,
  type CachePolicy,
  type ExchangeState,
  type FigureQuery,
  type Outcome,
  type QueryKind,
} from "./model.ts";
import {
  catalogRodSvg,
  cradlesAt,
  drawerBoxSvg,
  escapementSvg,
  marketRodSvg,
  pawlSvg,
  ratchetSvg,
  shankSvg,
  stubSvg,
} from "./parts.ts";
import { durationOf, poseAt, STOPS, type Job, type Pose } from "./timeline.ts";

const SPEEDS = [1, 10, 60] as const;
/**
 * The tour resumes later than the kit's usual 3.6 s: what a reader sent stays in the pigeonholes, and they need time to
 * watch it drain. Once a reader has sent a card the tour never clears the cache again.
 */
const RESUME_AFTER_MS = 9000;
const TOUR_DELAY_MS = 1400;
const HOME_Z = TRAY_FLOOR + (TRAY_STACK - 1) * (CARD.h + 0.1) - CARD_Z;

type TourStep =
  | { readonly send: QueryKind }
  | { readonly flood: true }
  | { readonly speed: number }
  | { readonly wait: number }
  | { readonly reset: true };

/** The idle tour: a miss, a hit, a stale answer, the short and the never-stored windows, names, a flood. */
const TOUR: readonly TourStep[] = [
  { reset: true },
  { speed: 1 },
  { send: "prices" },
  { wait: 0.6 },
  { send: "prices" },
  { speed: 60 },
  { wait: 1.6 },
  { send: "prices" },
  { speed: 1 },
  { send: "orderBook" },
  { send: "names" },
  { send: "search" },
  { speed: 10 },
  { wait: 1.2 },
  { send: "orderBook" },
  { flood: true },
  { speed: 60 },
  { wait: 2.4 },
  { speed: 1 },
  { wait: 1.5 },
];

/** The part drawn lit: the one acting now. */
type Accent = "none" | "card" | "pawl" | "plug" | "drawer" | "cradle" | "line" | "stamp";

/** The pulse's length, in hundredths of the line. */
const PULSE = 9;

function setLit(element: Element | null | undefined, on: boolean) {
  element?.querySelectorAll(".iso-solid").forEach((solid) => solid.toggleAttribute("data-lit", on));
}

export function mountExchange(root: HTMLElement): void {
  const data = root.querySelector<HTMLScriptElement>("script[data-fx]");
  const svg = root.querySelector<SVGSVGElement>("svg");
  const readout = root.querySelector<HTMLElement>("[data-readout]");
  const announce = root.querySelector<HTMLElement>("[data-announce]");
  if (data === null || svg === null || readout === null || announce === null) return;
  const readoutLine: HTMLElement = readout;
  const drawing: SVGSVGElement = svg;
  const announcer: HTMLElement = announce;
  const queries = parseQueries(data.textContent ?? "");
  const byKind = new Map(queries.map((query) => [query.kind, query]));
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const part = (selector: string) => svg.querySelector<SVGGElement>(selector);
  const moving = (name: string) => part(`[data-move="${name}"]`);
  const liveSlot = (name: string) => part(`[data-live="${name}"]`);
  const refs = {
    card: moving("card"),
    gate: moving("gate"),
    ram: moving("ram"),
    stamp: moving("stamp"),
    ramShank: liveSlot("ram-shank"),
    stampShank: liveSlot("stamp-shank"),
    ratchet: liveSlot("ratchet"),
    pawl: liveSlot("pawl"),
    escapement: liveSlot("escapement"),
    catalogShuttle: moving("catalog-shuttle"),
    marketShuttle: moving("market-shuttle"),
    catalogFar: liveSlot("catalog-rod-far"),
    catalogNear: liveSlot("catalog-rod-near"),
    marketFar: liveSlot("market-rod-far"),
    marketNear: liveSlot("market-rod-near"),
    cradles: part("[data-cradles]"),
    stamped: part("[data-card-stamp]"),
    holes: [...svg.querySelectorAll<SVGCircleElement>(".fx-hole")],
  };
  const cradles = [...svg.querySelectorAll<SVGGElement>("[data-cradle]")];
  const capsules = [...svg.querySelectorAll<SVGGElement>("[data-capsule]")];
  const stubs = CELLS.map((_, index) => liveSlot(`stub-${index}`));
  const locks = CELLS.map((_, index) => part(`[data-lock="${index}"] .fx-plug-turn`));
  const lockGroups = CELLS.map((_, index) => part(`[data-lock="${index}"]`));
  const glasses = CELLS.map((_, index) => part(`[data-glass="${index}"]`));
  const drawers = Array.from({ length: DRAWER.rows * DRAWER.columns }, (_, index) => ({
    front: moving(`drawer-${index}`),
    box: liveSlot(`drawer-box-${index}`),
  }));
  const pulses = [...svg.querySelectorAll<SVGPathElement>("[data-pulse]")];
  const stage = root.querySelector<HTMLElement>("[data-stage]");
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-send]")];
  const speedButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-speed]")];

  /* ------------------------------------------------------------ state */

  let model: ExchangeState = INITIAL_STATE;
  let sim = 0;
  let speed: number = SPEEDS[0];
  let job: { job: Job; at: number; end: number; filed: boolean; tableAt: number } | null = null;
  const queue: (QueryKind | "flood")[] = [];
  let tableSteps = 0;
  let wheel = { at: 0, target: 0 };
  const glassShown = CELLS.map(() => ({ fresh: 0, stale: 0 }));
  let lastText = "";
  let accent: Accent = "none";
  let ownScroll = 0;
  let readerScrolledUntil = 0;

  /* ------------------------------------------------------------ writing parts */

  const put = (element: Element | null, transform: string) => {
    if (element === null) return;
    if (transform === "translate(0 0)" || transform === "") element.removeAttribute("transform");
    else if (element.getAttribute("transform") !== transform) element.setAttribute("transform", transform);
  };
  const fill = (element: Element | null, html: string) => {
    if (element !== null && element.innerHTML !== html) element.innerHTML = html;
  };
  const cellOf = (kind: QueryKind) => CELLS.findIndex((cell) => cell.kind === kind);
  const rackXOf = (kind: QueryKind) => {
    const cell = CELLS[cellOf(kind)];
    return cell === undefined ? AT.rack : CELL.x0 + cell.column * CELL.w + HOLE.x + HOLE.w / 2;
  };

  function drawPose(pose: Pose | null, query: FigureQuery | null, tableAt: number) {
    const card = pose?.card ?? { x: STOPS.tray, lift: 0, shown: true, holes: 0, stamped: false };
    const toTrack = Math.min(1, Math.max(0, (card.x - STOPS.tray) / (STOPS.gate - STOPS.tray)));
    const z = HOME_Z * (1 - toTrack) + card.lift * 0.6;
    put(refs.card, translateAlong(P, [card.x, 0, z]));
    refs.card?.toggleAttribute("data-hidden", !card.shown);
    refs.stamped?.toggleAttribute("data-on", card.stamped);
    const bits = query === null ? 0 : Number.parseInt(query.key.slice(0, 4), 16);
    refs.holes.forEach((hole, index) =>
      hole.setAttribute("opacity", ((bits >> index) & 1 ? card.holes : 0).toFixed(2)),
    );

    const gate = pose?.gate ?? 0;
    put(refs.gate, translateAlong(P, [0, 0, gate * GATE.lift]));
    const ram = pose?.ram ?? 0;
    const ramDrop = ram * PUNCH.stroke;
    put(refs.ram, translateAlong(P, [0, 0, -ramDrop]));
    fill(refs.ramShank, shankSvg(PUNCH.x, 40, 1.6, PUNCH.ramZ + 4 - ramDrop, PUNCH.ramTop));
    const stampDrop = (pose?.stamp ?? 0) * STAMP.stroke;
    put(refs.stamp, translateAlong(P, [0, 0, -stampDrop]));
    fill(refs.stampShank, shankSvg(STAMP.x, 40, 1.8, STAMP.headZ + 5 - stampDrop, 32));

    // Shuttles ride their Service Binding rods; each rod is cut where its shuttle is.
    const catalogAt = CATALOG_ROD.from - 3.5 - (pose?.catalogShuttle ?? 0) * (CATALOG_ROD.from - CATALOG_ROD.to - 7);
    put(refs.catalogShuttle, translateAlong(P, [0, catalogAt, 0]));
    fill(refs.catalogFar, catalogRodSvg(catalogAt, "far"));
    fill(refs.catalogNear, catalogRodSvg(catalogAt, "near"));
    const marketAt = MARKET_ROD.from + 3.5 + (pose?.marketShuttle ?? 0) * (MARKET_ROD.to - MARKET_ROD.from - 7);
    put(refs.marketShuttle, translateAlong(P, [marketAt, 0, 0]));
    fill(refs.marketFar, marketRodSvg(marketAt, "far"));
    fill(refs.marketNear, marketRodSvg(marketAt, "near"));

    // The drawer for the query's locale.
    const open = (pose?.drawer ?? 0) * DRAWER.open;
    drawers.forEach((drawer, index) => {
      const amount = query !== null && index === query.locale ? open : 0;
      put(drawer.front, translateAlong(P, [0, amount, 0]));
      fill(drawer.box, drawerBoxSvg(index, amount));
    });

    // The carousel: the table steps one cradle per loaded capsule; capsules ride until their bead is home.
    const steps = tableAt + (pose?.step ?? 0);
    const angle = -(steps * Math.PI * 2) / 6;
    const places = cradlesAt(angle);
    const origin = cradlesAt(0)[0];
    for (const place of places) {
      const element = cradles[place.index];
      if (element === undefined || origin === undefined) continue;
      put(element, translateAlong(P, [place.at[0] - CAROUSEL.x, place.at[1] - CAROUSEL.y, 0]));
    }
    const order = [...places].sort((a, b) => a.depth - b.depth).map((place) => cradles[place.index]);
    if (refs.cradles !== null && order.some((element, index) => refs.cradles?.children[index] !== element)) {
      for (const element of order) if (element !== undefined) refs.cradles.append(element);
    }
    const loaded = pose?.loaded ?? 0;
    const unloaded = pose?.unloaded ?? 0;
    capsules.forEach((capsule, index) => {
      const slot = (((index - tableAt) % 6) + 6) % 6;
      const on = slot < loaded ? 1 - unloaded : 0;
      capsule.setAttribute("opacity", on.toFixed(2));
    });
    fill(refs.escapement, escapementSvg(angle * 2.5));
    // One pulse per upstream call runs out along the line to Pearl Abyss and back.
    const beads = pose?.beads ?? [];
    pulses.forEach((pulse, index) => {
      const share = beads[index] ?? -1;
      if (share < 0) {
        pulse.setAttribute("opacity", "0");
        return;
      }
      const along = 1 - Math.abs(2 * share - 1);
      const fade = Math.min(1, share * 12, (1 - share) * 12);
      pulse.setAttribute("stroke-dasharray", `${PULSE} ${100 + PULSE}`);
      pulse.setAttribute("stroke-dashoffset", (-(along * (100 - PULSE))).toFixed(2));
      pulse.setAttribute("opacity", fade.toFixed(2));
    });

    // The pigeonhole for this card: its lock turns on a hit, its answer slides out and back.
    CELLS.forEach((cell, index) => {
      const mine = query !== null && cell.kind === query.kind;
      const turn = mine ? (pose?.lock ?? 0) : 0;
      locks[index]?.setAttribute("transform", `rotate(${(turn * 90).toFixed(1)})`);
      const stored = cell.kind !== null && model.answers[cell.kind] !== undefined;
      const sliding = mine ? (pose?.stub ?? 0) : 0;
      fill(stubs[index] ?? null, stored || sliding > 0 ? stubSvg(index, 2.6 + sliding * 5) : "");
    });

    // Exactly one part is lit: the one acting now.
    const next = accentOf(pose, query);
    if (next !== accent) {
      accent = next;
      setLit(refs.card, accent === "card");
      setLit(refs.stamp, accent === "stamp");
      capsules.forEach((capsule) => setLit(capsule, accent === "cradle"));
      drawers.forEach((drawer, index) =>
        setLit(drawer.front, accent === "drawer" && query !== null && index === query.locale),
      );
      root.dataset.accent = accent;
    }
    CELLS.forEach((_, index) =>
      lockGroups[index]?.toggleAttribute(
        "data-on",
        accent === "plug" && query !== null && CELLS[index]?.kind === query.kind,
      ),
    );
    fill(refs.pawl, pawlSvg(accent === "pawl"));
    follow(pose, query);
  }

  function accentOf(pose: Pose | null, query: FigureQuery | null): Accent {
    if (pose === null || query === null || job === null) return "none";
    const outcome = job.job.outcome.kind;
    if (outcome === "rejected") return pose.phase === "sending" ? "card" : "pawl";
    if (pose.gate > 0.05 && pose.card.x < STOPS.punch) return "pawl";
    if (pose.stamp > 0.05) return "stamp";
    if (pose.beads.some((share) => share >= 0)) return "line";
    if (pose.loaded > 0 && pose.unloaded < 1 && pose.marketShuttle > 0.5) return "cradle";
    if (pose.drawer > 0.3) return "drawer";
    if (pose.lock > 0.3 && (outcome === "hit" || outcome === "stale")) return "plug";
    return "card";
  }

  /** On a narrow screen the stage scrolls; keep the acting part in view unless the reader has just scrolled it. */
  function follow(pose: Pose | null, query: FigureQuery | null) {
    if (stage === null || stage.scrollWidth <= stage.clientWidth + 1 || Date.now() < readerScrolledUntil) return;
    const focus = focusOf(pose, query);
    const scale = drawing.getBoundingClientRect().width / WIDTH;
    const target = Math.max(
      0,
      Math.min(stage.scrollWidth - stage.clientWidth, iso(focus, P)[0] * scale - stage.clientWidth / 2),
    );
    const current = stage.scrollLeft;
    const next = still.matches ? target : current + (target - current) * 0.08;
    if (Math.abs(next - current) > 0.5) {
      ownScroll = Math.round(next);
      stage.scrollLeft = next;
    }
  }

  function focusOf(pose: Pose | null, query: FigureQuery | null): Point3 {
    if (pose === null || query === null) return [AT.tray, TRACK_Y, 0];
    if (accent === "line") return [LINE.x, (GLAND.y + TERMINAL.y) / 2, LINE.rise];
    if (accent === "cradle") return [CAROUSEL.x, CAROUSEL.y, CAROUSEL.z];
    if (accent === "drawer") return [CABINET.x + CABINET.w / 2, CABINET_FACE, 30];
    if (pose.marketShuttle > 0.2 || pose.catalogShuttle > 0.2) return [AT.splitter + 40, 0, 0];
    return [pose.card.x, TRACK_Y, 0];
  }

  function drawWheel() {
    const angle = -(wheel.at / RATE_LIMIT.limit) * Math.PI * 2;
    fill(refs.ratchet, ratchetSvg(angle));
    fill(refs.pawl, pawlSvg(accent === "pawl"));
  }

  function drawGlasses(dt: number, calm: boolean) {
    let moving = false;
    CELLS.forEach((cell, index) => {
      const element = glasses[index];
      if (cell.kind === null || cell.kind === "search" || element === null || element === undefined) return;
      const query = byKind.get(cell.kind);
      if (query === undefined) return;
      const glass = hourglassOf(model, query, sim);
      const shown = glassShown[index]!;
      const k = calm ? 1 : 1 - Math.exp(-dt / 0.22);
      shown.fresh += (glass.fresh - shown.fresh) * k;
      shown.stale += (glass.stale - shown.stale) * k;
      if (Math.abs(glass.fresh - shown.fresh) < 1e-3) shown.fresh = glass.fresh;
      if (Math.abs(glass.stale - shown.stale) < 1e-3) shown.stale = glass.stale;
      if (
        glass.phase === "fresh" ||
        glass.phase === "stale" ||
        shown.fresh !== glass.fresh ||
        shown.stale !== glass.stale
      )
        moving = true;
      const h = Number(element.dataset.h ?? "0");
      const upper = element.querySelector('[data-sand="upper"]');
      const lower = element.querySelector('[data-sand="lower"]');
      const stream = element.querySelector('[data-sand="stream"]');
      upper?.setAttribute("y", ((h / 2) * (1 - shown.fresh)).toFixed(2));
      upper?.setAttribute("height", ((h / 2) * shown.fresh).toFixed(2));
      lower?.setAttribute("y", (h - (h / 2) * shown.stale).toFixed(2));
      lower?.setAttribute("height", ((h / 2) * shown.stale).toFixed(2));
      stream?.setAttribute("opacity", glass.phase === "fresh" && !calm ? "1" : "0");
      element.dataset.phase = glass.phase;
    });
    return moving;
  }

  function say(text: string) {
    if (text !== lastText) {
      readoutLine.textContent = text;
      lastText = text;
    }
  }

  function readoutFor(pose: Pose, current: Job): string {
    const { query, outcome } = current;
    if (outcome.kind === "rejected")
      return pose.phase === "sending" ? `${query.label} · at the turnstile` : readoutOf(outcome, query);
    if (pose.phase === "sending") return `${query.label} · admitted · ${allowanceAt(model, sim)} left this minute`;
    if (pose.phase === "punching") return `punching key ${query.key}`;
    if (pose.phase === "checking") return `checking pigeonhole ${query.key}`;
    if (outcome.kind === "miss" && pose.phase === "fetching")
      return `MISS · fetching · ${query.upstreamCalls} upstream ${query.upstreamCalls === 1 ? "call" : "calls"}`;
    return readoutOf(outcome, query);
  }

  /* ------------------------------------------------------------ sending */

  function start(kind: QueryKind | "flood") {
    const query = byKind.get(kind === "flood" ? "prices" : kind);
    if (query === undefined) return;
    if (kind === "flood") model = exhaust(model, sim);
    const result = send(model, query, sim);
    model = result.state;
    wheel.target = windowAt(model, sim).used;
    const current: Job = { query, outcome: result.outcome, rackX: rackXOf(query.kind) };
    job = { job: current, at: performance.now() / 1000, end: durationOf(current), filed: false, tableAt: tableSteps };
    announcer.textContent = describe(result.outcome, query);
    setBusy(true);
    if (still.matches) finish();
  }

  function finish() {
    if (job === null) return;
    const { job: current } = job;
    if (!job.filed && fileable(current.outcome)) model = file(model, current.query, sim);
    tableSteps +=
      current.query.market && current.outcome.kind !== "hit" && current.outcome.kind !== "rejected"
        ? Math.min(current.query.upstreamCalls, 6)
        : 0;
    tableSteps %= 6;
    say(readoutOf(current.outcome, current.query));
    job = null;
    drawPose(null, current.query, tableSteps);
    setBusy(false);
    const next = queue.shift();
    if (next !== undefined) start(next);
  }

  const fileable = (outcome: Outcome) => outcome.kind === "stale" || (outcome.kind === "miss" && outcome.stored);

  function request(kind: QueryKind | "flood") {
    if (job === null) start(kind);
    else if (queue.length < 2) queue.push(kind);
    run();
  }

  function setBusy(busy: boolean) {
    root.toggleAttribute("data-busy", busy);
  }

  function setSpeed(next: number) {
    speed = next;
    speedButtons.forEach((button) =>
      button.setAttribute("aria-pressed", String(Number(button.dataset.speed) === next)),
    );
  }

  /* ------------------------------------------------------------ loop */

  let frame = 0;
  let last = 0;
  let visible = false;
  let touring = !still.matches;
  let tourIndex = 0;
  let tourWait = 0;
  let tourStarted = false;
  let readerSent = false;
  let idleTimer = 0;

  function tourTick(dt: number) {
    if (!touring || !tourStarted) return;
    if (tourWait > 0) {
      tourWait -= dt;
      return;
    }
    if (job !== null || queue.length > 0) return;
    const step = TOUR[tourIndex % TOUR.length]!;
    tourIndex += 1;
    if ("reset" in step) {
      if (readerSent) return;
      model = INITIAL_STATE;
      sim = 0;
      wheel.target = 0;
    } else if ("speed" in step) setSpeed(step.speed);
    else if ("wait" in step) tourWait = step.wait;
    else if ("flood" in step) request("flood");
    else request(step.send);
    if (!("wait" in step)) tourWait = 0.5;
  }

  function tick(now: number) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    const calm = still.matches;
    sim += dt * speed;
    tourTick(dt);

    const before = windowAt(model, sim);
    if (before.openedAt !== model.window.openedAt) model = { ...model, window: before };
    wheel.target = windowAt(model, sim).used;
    // One tooth per request snaps round quickly; a flood or a new window turns the wheel slowly enough to follow.
    const far = Math.abs(wheel.target - wheel.at) > 3;
    const k = calm ? 1 : 1 - Math.exp(-dt / (far ? 0.7 : 0.18));
    wheel.at += (wheel.target - wheel.at) * k;
    if (Math.abs(wheel.target - wheel.at) < 0.01) wheel.at = wheel.target;
    drawWheel();

    let active = false;
    if (job !== null) {
      const t = now / 1000 - job.at;
      const pose = poseAt(job.job, Math.min(t, job.end));
      if (pose.filed && !job.filed) {
        model = file(model, job.job.query, sim);
        job.filed = true;
      }
      drawPose(pose, job.job.query, job.tableAt);
      say(readoutFor(pose, job.job));
      if (t >= job.end) finish();
      active = true;
    }
    const draining = drawGlasses(dt, calm);
    const settled = !active && !draining && wheel.at === wheel.target && !touring;
    frame = visible && !settled ? requestAnimationFrame(tick) : 0;
  }

  function run() {
    if (!frame && visible) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  }

  /* ------------------------------------------------------------ input */

  function takeOver() {
    touring = false;
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      touring = !still.matches;
      run();
    }, RESUME_AFTER_MS);
  }

  buttons.forEach((button) =>
    button.addEventListener("click", () => {
      takeOver();
      readerSent = true;
      const kind = button.dataset.send;
      if (kind === "flood") request("flood");
      else if (isQueryKind(kind)) request(kind);
    }),
  );
  speedButtons.forEach((button) =>
    button.addEventListener("click", () => {
      takeOver();
      setSpeed(Number(button.dataset.speed));
      run();
    }),
  );
  // A scroll the script did not make is the reader's: stop following for a while.
  stage?.addEventListener(
    "scroll",
    () => {
      if (Math.abs(stage.scrollLeft - ownScroll) > 2) readerScrolledUntil = Date.now() + 5000;
    },
    { passive: true },
  );
  root.addEventListener("pointerenter", () => {
    touring = false;
    window.clearTimeout(idleTimer);
  });
  root.addEventListener("pointerleave", () => takeOver());
  root.addEventListener("focusin", () => {
    touring = false;
    window.clearTimeout(idleTimer);
  });
  root.addEventListener("focusout", () => takeOver());
  stage?.addEventListener("keydown", (event) => {
    const keys: Record<string, QueryKind | "flood"> = {
      "1": "prices",
      "2": "orderBook",
      "3": "hot",
      "4": "names",
      "5": "search",
      f: "flood",
    };
    const kind = keys[event.key.toLowerCase()];
    if (kind !== undefined) {
      event.preventDefault();
      takeOver();
      readerSent = true;
      request(kind);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      takeOver();
      const index = SPEEDS.findIndex((value) => value === speed);
      const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)))] ?? 1;
      setSpeed(next);
      run();
    }
  });

  new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1];
      visible = entry?.isIntersecting ?? false;
      if (visible && !tourStarted && touring) {
        window.setTimeout(() => {
          tourStarted = true;
          run();
        }, TOUR_DELAY_MS);
      }
      if (visible) run();
    },
    { rootMargin: "120px 0px" },
  ).observe(root);

  still.addEventListener("change", () => {
    touring = !still.matches && touring;
    if (still.matches && job !== null) finish();
  });

  setSpeed(speed);
  drawPose(null, null, 0);
  drawWheel();
  drawGlasses(0, true);
}

function describe(outcome: Outcome, query: FigureQuery): string {
  switch (outcome.kind) {
    case "rejected":
      return `${query.label}: rate limited, 429. Retry after ${outcome.retryAfter} seconds.`;
    case "hit":
      return `${query.label}: served from the cache.`;
    case "stale":
      return `${query.label}: served stale from the cache while it refreshes.`;
    case "miss":
      return outcome.stored
        ? `${query.label}: cache miss, fetched and stored.`
        : `${query.label}: never stored, fetched.`;
  }
}

/* BOUNDARY: the figure's data block is written by the build, but the page reads it as text, so it is checked. */
function parseQueries(text: string): FigureQuery[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new TypeError("The figure's data must be a list of queries");
  return value.map(parseQuery);
}

function parseQuery(entry: unknown): FigureQuery {
  if (!isRecord(entry)) throw new TypeError("A figure query must be an object");
  const { kind, label, key, upstreamCalls, catalog, market, locale, policy } = entry;
  if (!isQueryKind(kind)) throw new TypeError(`Unknown figure query ${String(kind)}`);
  if (typeof label !== "string" || typeof key !== "string")
    throw new TypeError("A figure query needs a label and a key");
  if (typeof upstreamCalls !== "number" || typeof locale !== "number")
    throw new TypeError("A figure query needs counts");
  if (typeof catalog !== "boolean" || typeof market !== "boolean")
    throw new TypeError("A figure query names its subgraphs");
  return { kind, label, key, upstreamCalls, catalog, market, locale, policy: parsePolicy(policy) };
}

function parsePolicy(value: unknown): CachePolicy {
  if (!isRecord(value)) throw new TypeError("A cache policy must be an object");
  if (value.mode === "no-store") return { mode: "no-store" };
  const { maxAge, staleWhileRevalidate, staleIfError } = value;
  if (
    value.mode !== "store" ||
    typeof maxAge !== "number" ||
    typeof staleWhileRevalidate !== "number" ||
    typeof staleIfError !== "number"
  ) {
    throw new TypeError("A stored cache policy needs its three windows");
  }
  return { mode: "store", maxAge, staleWhileRevalidate, staleIfError };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueryKind(value: unknown): value is QueryKind {
  return typeof value === "string" && QUERY_KINDS.some((kind) => kind === value);
}
