/**
 * Build-time art for Fig 1: the whole bench as SVG strings, painted back to front, with named slots for the parts the
 * live script moves. Nothing here runs in the browser.
 */
import {
  corners,
  cylinder,
  depthOf,
  dotGrid,
  dotsSvg,
  extrude,
  faceTextSvg,
  fadeLineSvg,
  haloOf,
  insetPlan,
  iso,
  knurl,
  lineOnTop,
  lineSvg,
  pathOf,
  planOutline,
  radialTicks,
  ring,
  segment,
  sideArc,
  sideMatrix,
  sideSeam,
  slabOf,
  solidSvg,
  topTicks,
  translateAlong,
  type Flat,
  type Plan,
  type Point3,
  type SolidPaths,
  type SolidStyle,
} from "../../vendor/anatomy/iso-kit.ts";
import {
  AT,
  BRIDGE_POST,
  CABINET,
  CABINET_FACE,
  CABINET_Z,
  CARD,
  CARD_Z,
  CAROUSEL,
  CATALOG_ROD,
  CELL,
  CELLS,
  DRAWER,
  FOOT_H,
  FUNNEL,
  GATE,
  GLASS,
  HOLE,
  LOCK,
  MARKET_ROD,
  P,
  PLATE,
  PLATE_H,
  PUNCH,
  RACK,
  RACK_FACE,
  RACK_Z,
  SPLITTER,
  STAMP,
  TRACK,
  TRAY,
  TRAY_FLOOR,
  TRAY_STACK,
  TURNSTILE,
  cellOrigin,
} from "./layout.ts";
import {
  capsuleSvg,
  catalogRodSvg,
  cradleSvg,
  cradlesAt,
  drawerBoxSvg,
  drawerPlan,
  escapementSvg,
  holeOpening,
  marketRodSvg,
  ratchetSvg,
  shankSvg,
  pawlSvg,
  PAWL_POST,
  shuttleSvg,
} from "./parts.ts";
import { DEMO, SELF_HOSTED } from "../facts.ts";
import { lineAssembly, ROUTE_PATH } from "./line.ts";
import { durationOf } from "./model.ts";

const S = (paths: SolidPaths, style: SolidStyle = {}) => solidSvg(paths, style);
const L = lineSvg;
const D = dotsSvg;
const at = (point: Point3): Flat => iso(point, P);
const slab = (plan: Plan, z: number, h: number, steps = 3, bevel = 0) => slabOf(plan, z, h, P, steps, bevel);
const cyl = (cx: number, cy: number, r: number, z: number, h: number, steps = 28, bevel = 0) =>
  cylinder(cx, cy, r, z, h, P, steps, bevel);
const screws = (points: Point3[], size = 0.45) => D(points.map(at), { size, tone: "mid" });
const live = (name: string, body: string, extra = "") => `<g data-live="${name}"${extra}>${body}</g>`;
const moving = (name: string, body: string) => `<g data-move="${name}">${body}</g>`;
const byDepth = <T extends { at: Point3 }>(list: T[]) => [...list].sort((a, b) => depthOf(a.at, P) - depthOf(b.at, P));
/** A face-plane quad from four world points. */
const quad = (points: Point3[]) => pathOf(points.map(at), true);

/* ---------------------------------------------------------------- base */

function base(): string {
  const out = [`<path class="iso-halo" d="${haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const { at: foot } of byDepth(corners(PLATE, 24).map(([x, y]) => ({ at: [x, y, 0] as Point3 })))) {
    out.push(S(cyl(foot[0], foot[1], 7.2, -PLATE_H - FOOT_H, 1.6), { tone: "lo" }));
    out.push(S(cyl(foot[0], foot[1], 5.6, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6), { tone: "mid" }));
  }
  out.push(
    S(slab(PLATE, -PLATE_H, PLATE_H, 8, 1.6), { tone: "mid", inner: L(sideSeam(PLATE, -4, P, 8), { tone: "faint" }) }),
  );
  out.push(L(planOutline(insetPlan(PLATE, 4.5), 0, P), { tone: "lo" }));
  const corner = corners(PLATE, 10);
  out.push(L(corner.map(([x, y]) => ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(
    screws(
      corner.map(([x, y]) => [x, y, 0]),
      0.55,
    ),
  );

  // A ruler along the front edge; the maker's plate, a cable channel and the master-card file at the back.
  const strip: Plan = { x: -150, y: 51, w: 246, d: 6, r: 1 };
  out.push(S(slab(strip, 0, 0.6), { tone: "lo", crease: "none" }));
  const ticks = topTicks(strip.x + 3, strip.x + strip.w - 3, 4, 5, strip.y + 0.6, 0.6, [1.8, 3.4], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(
    screws(
      [
        [strip.x + 1.6, strip.y + 3, 0.6],
        [strip.x + strip.w - 1.6, strip.y + 3, 0.6],
      ],
      0.4,
    ),
  );

  out.push(labelPlate({ x: -132, y: -114, w: 58, d: 10, r: 1.5 }, 0));
  out.push(cableChannel());
  out.push(masterCards());
  // Tapped mounting holes on the free back of the bench, every 10 units, for parts not yet bolted down.
  out.push(D(dotGrid(-182, -62, 12, 4, 10, 0, P), { size: 0.5, tone: "lo" }));
  return out.join("");
}

/** A maker's plate: a thin slab with an inset border, three rule lines that stand for its text, and two screws. */
function labelPlate(plan: Plan, z: number): string {
  const top = z + 0.8;
  return [
    S(slab(plan, z, 0.8, 4), { tone: "lo", crease: "none" }),
    L(planOutline(insetPlan(plan, 1.5), top, P, 4), { tone: "faint" }),
    L(
      [0, 1, 2]
        .map((row) =>
          lineOnTop(
            [plan.x + 8, plan.y + plan.d / 2 - 2 + row * 2],
            [plan.x + plan.w * (row === 1 ? 0.5 : 0.76), plan.y + plan.d / 2 - 2 + row * 2],
            top,
            P,
          ),
        )
        .join(""),
      { tone: "lo", free: true },
    ),
    screws([
      [plan.x + 3.4, plan.y + plan.d / 2, top],
      [plan.x + plan.w - 3.4, plan.y + plan.d / 2, top],
    ]),
  ].join("");
}

/** A cable channel milled along the back of the bench: a closed slot, darker inside. */
function cableChannel(): string {
  const slot: Plan = { x: PLATE.x + 12, y: PLATE.y + 7, w: 300, d: 4, r: 2 };
  return `<path class="fx-cavity" d="${planOutline(slot, 0, P, 4)}"/>` + L(planOutline(slot, 0, P, 4), { tone: "lo" });
}

/**
 * The master-card file: punched cards kept for persisted operations, which a client names by SHA-256 id instead of
 * sending the query (`GET /graphql?id=`).
 */
function masterCards(): string {
  const box: Plan = { x: -186, y: -100, w: 34, d: 26, r: 1.5 };
  const out = [S(slab(box, 0, 2, 3, 0.4), { tone: "lo" })];
  out.push(S(slab({ x: box.x, y: box.y, w: box.w, d: 1.4, r: 0.4 }, 2, 9, 2), { tone: "mid" }));
  out.push(S(slab({ x: box.x, y: box.y + 1.4, w: 1.4, d: box.d - 2.8, r: 0.3 }, 2, 9, 2), { tone: "mid" }));
  for (let card = 0; card < 6; card++) {
    const y = box.y + 4 + card * 3.4;
    const tall = card === 2 ? 11 : 9;
    out.push(
      S(slab({ x: box.x + 3, y, w: box.w - 6, d: 0.6, r: 0 }, 2, tall, 1), {
        tone: card === 2 ? "hi" : "lo",
        crease: "none",
      }),
    );
  }
  out.push(
    S(slab({ x: box.x + box.w - 1.4, y: box.y + 1.4, w: 1.4, d: box.d - 2.8, r: 0.3 }, 2, 9, 2), { tone: "mid" }),
  );
  out.push(S(slab({ x: box.x, y: box.y + box.d - 1.4, w: box.w, d: 1.4, r: 0.4 }, 2, 6, 2), { tone: "mid" }));
  out.push(
    screws(
      [
        [box.x + 3, box.y + box.d - 0.7, 8],
        [box.x + box.w - 3, box.y + box.d - 0.7, 8],
      ],
      0.4,
    ),
  );
  return out.join("");
}

/** A hold-down dog: a small clamp screwed to the bench that pins a cabinet's plinth. */
function holdDown(x: number, y: number, w: number, d: number): string {
  const plan: Plan = { x, y, w, d, r: 1 };
  return S(slab(plan, 0, 2.4, 2, 0.3), { tone: "mid" }) + screws([[x + w / 2, y + d / 2, 2.4]], 0.5);
}

/* ---------------------------------------------------------------- track and tray */

const BED: Plan = { x: TRACK.from, y: TRACK.y - TRACK.bed / 2, w: TRACK.to - TRACK.from, d: TRACK.bed, r: 0.8 };
const BACK_LIP: Plan = { x: TRACK.from, y: BED.y - TRACK.lip, w: BED.w, d: TRACK.lip, r: 0.6 };
const FRONT_LIP: Plan = { x: TRACK.from, y: BED.y + BED.d, w: BED.w, d: TRACK.lip, r: 0.6 };
const LIP_RIVETS = [-156, -124, -92, -58, -26, 6, 38, 72];

function trackBack(): string {
  return [
    S(slab(BACK_LIP, 0, TRACK.lipH, 2, 0.3), { tone: "mid" }),
    screws(
      LIP_RIVETS.map((x) => [x, BACK_LIP.y + TRACK.lip / 2, TRACK.lipH]),
      0.4,
    ),
    S(slab(BED, 0, TRACK.bedH, 2), { tone: "lo", crease: "none" }),
    fadeLineSvg([at([BED.x + 0.3, TRACK.y, TRACK.bedH]), at([BED.x + BED.w - 0.3, TRACK.y, TRACK.bedH])], {
      fade: [0, 8],
      tone: "faint",
    }),
  ].join("");
}

function trackFront(): string {
  return [
    S(slab(FRONT_LIP, 0, TRACK.lipH, 2, 0.3), { tone: "mid" }),
    screws(
      LIP_RIVETS.map((x) => [x, FRONT_LIP.y + TRACK.lip / 2, TRACK.lipH]),
      0.4,
    ),
  ].join("");
}

const WALL = 1.6;
const TRAY_WALL_H = 7;

function trayBack(): string {
  const out = [S(slab(TRAY, 0, TRAY_FLOOR, 3, 0.4), { tone: "lo" })];
  out.push(S(slab({ x: TRAY.x, y: TRAY.y, w: TRAY.w, d: WALL, r: 0.6 }, TRAY_FLOOR, TRAY_WALL_H, 2), { tone: "mid" }));
  out.push(
    S(slab({ x: TRAY.x, y: TRAY.y + WALL, w: WALL, d: TRAY.d - WALL * 2, r: 0.4 }, TRAY_FLOOR, TRAY_WALL_H, 2), {
      tone: "mid",
    }),
  );
  // The stack of blank cards waiting to be sent.
  for (let index = 0; index < TRAY_STACK - 1; index++) {
    out.push(S(cardPaths(AT.tray, TRAY_FLOOR + index * (CARD.h + 0.1)), { tone: "lo", crease: "faint" }));
  }
  return out.join("");
}

function trayFront(): string {
  const right = TRAY.x + TRAY.w - WALL;
  return [
    S(slab({ x: right, y: TRAY.y + WALL, w: WALL, d: 5, r: 0.4 }, TRAY_FLOOR, TRAY_WALL_H, 2), { tone: "mid" }),
    S(slab({ x: right, y: TRAY.y + TRAY.d - WALL - 5, w: WALL, d: 5, r: 0.4 }, TRAY_FLOOR, TRAY_WALL_H, 2), {
      tone: "mid",
    }),
    S(slab({ x: TRAY.x, y: TRAY.y + TRAY.d - WALL, w: TRAY.w, d: WALL, r: 0.6 }, TRAY_FLOOR, TRAY_WALL_H - 2, 2), {
      tone: "mid",
    }),
    screws(
      [
        [TRAY.x + 3, TRAY.y + TRAY.d - WALL / 2, TRAY_FLOOR + TRAY_WALL_H - 2],
        [TRAY.x + TRAY.w - 3, TRAY.y + TRAY.d - WALL / 2, TRAY_FLOOR + TRAY_WALL_H - 2],
      ],
      0.4,
    ),
  ].join("");
}

/** A punched card with its top-left corner cut, lying flat at `x` on the track's centre line. */
export function cardPaths(x: number, z: number): SolidPaths {
  const { w, d } = CARD;
  const x0 = x - w / 2;
  const y0 = TRACK.y - d / 2;
  const ring: [number, number][] = [
    [x0 + 2.4, y0],
    [x0 + w, y0],
    [x0 + w, y0 + d],
    [x0, y0 + d],
    [x0, y0 + 2.4],
  ];
  return extrude(ring, z, CARD.h, P);
}

/** The travelling card at the track's origin, with its holes and its stamp, which the live script shows in turn. */
function travellingCard(): string {
  const z = CARD_Z + CARD.h;
  const holes: Flat[] = [];
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 7; column++) holes.push(at([-6.6 + column * 2.2, TRACK.y - 1.6 + row * 3.2, z]));
  }
  const stamp: Plan = { x: -7.4, y: TRACK.y + 2.4, w: 9, d: 2.6, r: 0.4 };
  return [
    `<path class="iso-halo fx-card-shadow" d="${slab(insetPlan({ x: -CARD.w / 2, y: TRACK.y - CARD.d / 2, w: CARD.w, d: CARD.d, r: 0.6 }, 1), CARD_Z, 0.1).fill}"/>`,
    S(cardPaths(0, CARD_Z), { tone: "hi", crease: "lo" }),
    L(
      lineOnTop([-CARD.w / 2 + 1.2, TRACK.y - CARD.d / 2 + 1.4], [CARD.w / 2 - 1.2, TRACK.y - CARD.d / 2 + 1.4], z, P),
      { tone: "lo" },
    ),
    `<g data-card-holes>${holes.map(([hx, hy], index) => `<circle class="fx-hole" data-bit="${index}" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="0.55"/>`).join("")}</g>`,
    `<g data-card-stamp>${L(planOutline(stamp, z, P, 2), { tone: "lit" })}${L(lineOnTop([stamp.x + 1.4, stamp.y + 1.3], [stamp.x + stamp.w - 1.4, stamp.y + 1.3], z, P), { tone: "lit", free: true })}</g>`,
  ].join("");
}

/* ---------------------------------------------------------------- intake turnstile */

const TURN_BASE: Plan = { x: TURNSTILE.x - 9, y: TURNSTILE.y - 9, w: 25, d: 17, r: 2 };

function turnstileBack(): string {
  const { x, y, postR, top } = TURNSTILE;
  const out = [S(slab(TURN_BASE, 0, 3, 3, 0.5), { tone: "mid" })];
  out.push(screws(corners(TURN_BASE, 2.4).map(([sx, sy]) => [sx, sy, 3])));
  out.push(S(cyl(x, y, postR + 1.2, 3, 2.4, 28, 0.3), { tone: "mid" }));
  out.push(
    S(cyl(x, y, postR, 5.4, top - 5.4), {
      tone: "mid",
      crease: "none",
      inner: L(sideArc(x, y, postR, 18, P, 16), { tone: "faint" }),
    }),
  );
  out.push(S(cyl(PAWL_POST[0], PAWL_POST[1], 1.4, 3, top + 0.6, 16), { tone: "mid", crease: "none" }));
  // A self-hosted gateway limits no visitor by default, so the turnstile counts the shared demo's limit.
  out.push(live("ratchet", ratchetSvg(0, DEMO.clientRateLimit.limit)));
  out.push(S(cyl(x, y, 3.2, top + TURNSTILE.wheelH, 1.6, 24, 0.3), { tone: "mid" }));
  out.push(screws([[x, y, top + TURNSTILE.wheelH + 1.6]], 0.55));
  out.push(live("pawl", pawlSvg(false)));
  return out.join("");
}

/** The gate arm across the track, built down; it lifts to let an admitted card through. */
function gateArm(): string {
  const { x, y } = TURNSTILE;
  const arm: Plan = { x: x - 1.8, y: y + 2.5, w: 3.6, d: TRACK.y + TRACK.bed / 2 + TRACK.lip + 3 - y - 2.5, r: 1 };
  return [
    S(cyl(x, y, TURNSTILE.postR + 1.3, GATE.z - 0.4, GATE.h + 0.8, 28, 0.3), { tone: "mid" }),
    S(slab(arm, GATE.z, GATE.h, 3, 0.4), { tone: "mid" }),
    S(cyl(x, arm.y + arm.d - 1.8, 2.2, GATE.z - 0.6, GATE.h + 1.2, 18, 0.3), { tone: "hi" }),
  ].join("");
}

/* ---------------------------------------------------------------- card punch */

const PUNCH_BASE: Plan = { x: PUNCH.x - 12, y: 11, w: 24, d: 17, r: 2 };
const PUNCH_COLUMN: Plan = { x: PUNCH.x - 6, y: 14, w: 12, d: 10, r: 1.5 };
const PUNCH_HEAD: Plan = { x: PUNCH.x - 7, y: 15, w: 14, d: 31, r: 2 };
const PUNCH_HEAD_Z = PUNCH.ramTop;

function punchBack(): string {
  return [
    S(slab(PUNCH_BASE, 0, 7, 3, 0.6), { tone: "mid" }),
    screws(corners(PUNCH_BASE, 2.6).map(([x, y]) => [x, y, 7])),
    S(slab(PUNCH_COLUMN, 7, PUNCH_HEAD_Z - 7, 3, 0.5), {
      tone: "mid",
      inner: L(sideSeam(PUNCH_COLUMN, 20, P, 3), { tone: "faint" }),
    }),
    // The die the card lies on while it is punched, set into the bed.
    S(slab({ x: PUNCH.x - 6, y: TRACK.y - 5, w: 12, d: 10, r: 0.6 }, TRACK.bedH, 0.3, 2), {
      tone: "lo",
      crease: "none",
    }),
  ].join("");
}

function punchFront(): string {
  const knob: [number, number] = [PUNCH.x, TRACK.y];
  const top = PUNCH_HEAD_Z + 8;
  return [
    live("ram-shank", shankSvg(PUNCH.x, TRACK.y, 1.6, PUNCH.ramZ + 4, PUNCH_HEAD_Z)),
    moving(
      "ram",
      S(cyl(PUNCH.x, TRACK.y, PUNCH.ramR, PUNCH.ramZ, 4, 24, 0.3), { tone: "hi" }) +
        S(cyl(PUNCH.x, TRACK.y, 1.4, PUNCH.ramZ - 2.2, 2.2, 16), { tone: "mid", crease: "none" }),
    ),
    S(slab(PUNCH_HEAD, PUNCH_HEAD_Z, 8, 4, 0.8), {
      tone: "mid",
      inner: L(sideSeam(PUNCH_HEAD, PUNCH_HEAD_Z + 3, P, 4), { tone: "faint" }),
    }),
    screws([
      [PUNCH.x - 4, PUNCH_HEAD.y + 3, top],
      [PUNCH.x + 4, PUNCH_HEAD.y + 3, top],
    ]),
    S(cyl(knob[0], knob[1], 4, top, 3.6, 32, 0.4), { tone: "mid" }),
    L(knurl(knob[0], knob[1], 4, top, top + 3.6, 36, P), { tone: "lo" }),
    L(lineOnTop([knob[0] - 2.4, knob[1]], [knob[0] + 3, knob[1]], top + 3.6, P), { tone: "hi" }),
    screws([[knob[0], knob[1], top + 3.6]], 0.5),
  ].join("");
}

/* ---------------------------------------------------------------- gauge */

const GAUGE_TOP = 22;
const PILLAR_BACK: Plan = { x: AT.gauge - 4, y: BACK_LIP.y - 8, w: 8, d: 8, r: 1 };
const PILLAR_FRONT: Plan = { x: AT.gauge - 4, y: FRONT_LIP.y + TRACK.lip, w: 8, d: 6, r: 1 };
const CROSSBAR: Plan = {
  x: AT.gauge - 5,
  y: PILLAR_BACK.y - 1,
  w: 10,
  d: PILLAR_FRONT.y + PILLAR_FRONT.d + 1 - (PILLAR_BACK.y - 1),
  r: 1.5,
};
/** The three fences: the public depth, field and alias limits (`PUBLIC_DOCUMENT_LIMITS`). Each hangs from the crossbar; a card must clear all three. */
const FENCES = [
  { y: TRACK.y - 5, bottom: 13 },
  { y: TRACK.y - 0.6, bottom: 10.5 },
  { y: TRACK.y + 3.8, bottom: 8 },
];

function gaugeBack(): string {
  return [
    S(slab(insetPlan(PILLAR_BACK, -1.6), 0, 1.6, 3), { tone: "lo" }),
    S(slab(PILLAR_BACK, 1.6, GAUGE_TOP - 1.6, 3, 0.4), { tone: "mid" }),
  ].join("");
}

function gaugeFront(): string {
  const out = [
    S(slab(insetPlan(PILLAR_FRONT, -1.6), 0, 1.6, 3), { tone: "lo" }),
    S(slab(PILLAR_FRONT, 1.6, GAUGE_TOP - 1.6, 3, 0.4), { tone: "mid" }),
  ];
  const face = PILLAR_FRONT.y + PILLAR_FRONT.d;
  for (let z = GAUGE_TOP - 2; z > 3; z -= 2) {
    const big = Math.round(z) % 10 === 0;
    out.push(
      L(
        segment([PILLAR_FRONT.x + PILLAR_FRONT.w, face - 0.6, z], [PILLAR_FRONT.x + PILLAR_FRONT.w, face - 0.6, z], P),
        { tone: "lo" },
      ),
    );
    out.push(
      L(segment([PILLAR_FRONT.x + 0.6, face, z], [PILLAR_FRONT.x + (big ? 3.6 : 2.2), face, z], P), {
        tone: big ? "mid" : "lo",
      }),
    );
  }
  for (const fence of FENCES) {
    out.push(
      S(slab({ x: AT.gauge - 3, y: fence.y, w: 6, d: 1.2, r: 0.3 }, fence.bottom, GAUGE_TOP - fence.bottom, 2), {
        tone: "hi",
        crease: "lo",
      }),
    );
  }
  out.push(S(slab(CROSSBAR, GAUGE_TOP, 5, 3, 0.6), { tone: "mid" }));
  out.push(
    screws([
      [AT.gauge, CROSSBAR.y + 2.6, GAUGE_TOP + 5],
      [AT.gauge, CROSSBAR.y + CROSSBAR.d - 2.6, GAUGE_TOP + 5],
    ]),
  );
  return out.join("");
}

/* ---------------------------------------------------------------- pigeonhole rack */

const CAVITY = "fx-cavity";

function rack(): string {
  const out: string[] = [];
  const plinth = insetPlan(RACK, -2);
  out.push(S(slab(plinth, 0, RACK_Z.plinth, 4, 0.5), { tone: "lo" }));
  out.push(
    S(slab(RACK, RACK_Z.plinth, RACK_Z.top - RACK_Z.plinth, 4, 0.8), {
      tone: "mid",
      inner: L(sideSeam(RACK, CELL.z0 + CELL.h, P, 4), { tone: "faint" }),
    }),
  );
  out.push(S(slab(plinth, RACK_Z.top, RACK_Z.cornice - RACK_Z.top, 4, 0.8), { tone: "mid" }));
  out.push(
    screws(
      corners(plinth, 3).map(([x, y]) => [x, y, RACK_Z.cornice]),
      0.5,
    ),
  );
  out.push(L(planOutline(insetPlan(plinth, 5.5), RACK_Z.cornice, P, 4), { tone: "faint" }));
  out.push(labelPlate({ x: -26, y: RACK.y + RACK.d / 2 - 5, w: 52, d: 10, r: 1.5 }, RACK_Z.cornice));
  // Hold-downs: the far one is painted before the rack, the near one after.
  out.unshift(holdDown(plinth.x - 6, -14, 6, 10));
  out.push(holdDown(plinth.x + plinth.w, -14, 6, 10));

  // Cell rules on the face, edge to edge.
  const face = RACK_FACE;
  const rules: string[] = [];
  for (let column = 1; column < 3; column++) {
    const x = CELL.x0 + column * CELL.w;
    rules.push(segment([x, face, RACK_Z.plinth], [x, face, RACK_Z.top], P));
  }
  out.push(L(rules.join(""), { tone: "faint" }));

  CELLS.forEach((spec, index) => {
    const [cx, cz] = cellOrigin(spec.row, spec.column);
    if (spec.kind === null) {
      out.push(tagPlate(cx, cz));
      return;
    }
    out.push(hole(index, cx, cz, spec.kind === "search"));
    out.push(lockPlug(index, cx, cz, spec.kind === "search"));
    out.push(hourglass(index, cx, cz, spec.kind === "search"));
  });
  return out.join("");
}

function hole(index: number, cx: number, cz: number, blanked: boolean): string {
  const x0 = cx + HOLE.x;
  const x1 = x0 + HOLE.w;
  const z0 = cz + HOLE.z;
  const z1 = z0 + HOLE.h;
  const back = RACK_FACE - HOLE.depth;
  const opening = holeOpening(index);
  const out = [`<path class="${CAVITY}" d="${opening}"/>`];
  out.push(`<clipPath id="fx-hole-${index}"><path d="${opening}"/></clipPath>`);
  out.push(
    `<g clip-path="url(#fx-hole-${index})">` +
      `<path class="iso-shade" data-shade="2" d="${quad([
        [x0, back, z0],
        [x1, back, z0],
        [x1, RACK_FACE, z0],
        [x0, RACK_FACE, z0],
      ])}"/>` +
      `<path class="iso-shade" data-shade="1" d="${quad([
        [x0, back, z0],
        [x0, RACK_FACE, z0],
        [x0, RACK_FACE, z1],
        [x0, back, z1],
      ])}"/>` +
      L(segment([x0, back, z0], [x1, back, z0], P), { tone: "faint" }) +
      L(segment([x0, back, z0], [x0, back, z1], P), { tone: "faint" }) +
      `</g>`,
  );
  out.push(L(opening, { tone: "lo" }));
  if (blanked) {
    // `searchItems` is never stored, so its pigeonhole is blanked off with a screwed cover.
    const cover: Plan = { x: x0 - 1.2, y: RACK_FACE, w: HOLE.w + 2.4, d: 0.8, r: 0.3 };
    out.push(S(slab(cover, z0 - 1.2, HOLE.h + 2.4, 2), { tone: "mid", crease: "faint" }));
    out.push(
      screws(
        [
          [x0 + 1, RACK_FACE + 0.8, z0 + HOLE.h / 2],
          [x1 - 1, RACK_FACE + 0.8, z0 + HOLE.h / 2],
        ],
        0.5,
      ),
    );
    return out.join("");
  }
  // The stored answer, clipped where it lies inside the face.
  const front: Point3[] = [
    [x0, RACK_FACE, z0],
    [x1, RACK_FACE, z0],
    [x1, RACK_FACE + 30, z0],
    [x0, RACK_FACE + 30, z0],
    [x0, RACK_FACE, z1],
    [x1, RACK_FACE, z1],
    [x1, RACK_FACE + 30, z1],
    [x0, RACK_FACE + 30, z1],
  ];
  out.push(`<clipPath id="fx-stub-${index}"><path d="${hull(front.map(at))}"/></clipPath>`);
  out.push(`<g clip-path="url(#fx-stub-${index})">${live(`stub-${index}`, "", ` data-cell="${index}"`)}</g>`);
  return out.join("");
}

/**
 * The lock plug over each pigeonhole: its keyway turns only for a card punched with the same key. The blanked
 * pigeonhole's plug has no keyway, since no key ever opens it.
 */
function lockPlug(index: number, cx: number, cz: number, blanked: boolean): string {
  const x = cx + LOCK.x;
  const z = cz + LOCK.z;
  const face = sideMatrix([x, RACK_FACE], z, P, "left");
  const keyway = blanked
    ? ""
    : `<path class="fx-slot" d="M0 -1.5V1.5"/><circle class="fx-keyhole" cy="-0.6" r="0.55"/>`;
  return (
    `<g transform="${face}" class="fx-lock" data-lock="${index}">` +
    `<circle class="fx-plug" r="${LOCK.r}"/>` +
    `<circle class="fx-plug-ring" r="${LOCK.r - 0.8}"/>` +
    `<g class="fx-plug-turn">${keyway}</g>` +
    `</g>`
  );
}

/** The hourglass window: upper bulb the fresh window, lower bulb the stale-while-revalidate window. */
const GLASS_PATH = (w: number, h: number) => {
  const half = w / 2;
  const neck = 0.45;
  const mid = h / 2;
  return `M${-half} 0H${half}C${half} ${h * 0.3} ${neck + 0.2} ${mid - 1.4} ${neck} ${mid}C${neck + 0.2} ${mid + 1.4} ${half} ${h * 0.7} ${half} ${h}H${-half}C${-half} ${h * 0.7} ${-neck - 0.2} ${mid + 1.4} ${-neck} ${mid}C${-neck - 0.2} ${mid - 1.4} ${-half} ${h * 0.3} ${-half} 0Z`;
};

function hourglass(index: number, cx: number, cz: number, blanked: boolean): string {
  const x = cx + GLASS.x + GLASS.w / 2;
  const top = cz + GLASS.z + GLASS.h;
  const w = GLASS.w - 1.6;
  const h = GLASS.h - 3.2;
  const face = sideMatrix([x, RACK_FACE], top, P, "left");
  const upper = `fx-upper-${index}`;
  const lower = `fx-lower-${index}`;
  const glass = GLASS_PATH(w, h);
  const sand = blanked
    ? ""
    : `<clipPath id="${upper}"><rect x="${-w / 2}" y="0" width="${w}" height="${h / 2}"/></clipPath>` +
      `<clipPath id="${lower}"><rect x="${-w / 2}" y="${h / 2}" width="${w}" height="${h / 2}"/></clipPath>` +
      `<g clip-path="url(#fx-glass-${index})">` +
      `<rect class="fx-sand" data-sand="upper" clip-path="url(#${upper})" x="${-w / 2}" y="${h / 2}" width="${w}" height="0"/>` +
      `<rect class="fx-sand" data-sand="lower" clip-path="url(#${lower})" x="${-w / 2}" y="${h}" width="${w}" height="0"/>` +
      `<path class="fx-stream" data-sand="stream" d="M0 ${h / 2 - 0.4}V${h - 0.6}"/>` +
      `</g>`;
  return (
    `<g transform="${face}" class="fx-glass" data-glass="${index}" data-h="${h}">` +
    `<rect class="fx-window" x="${-GLASS.w / 2}" y="0" width="${GLASS.w}" height="${GLASS.h}" rx="0.8"/>` +
    `<g transform="translate(0 1.6)">` +
    `<clipPath id="fx-glass-${index}"><path d="${glass}"/></clipPath>` +
    `<path class="fx-glass-fill" d="${glass}"/>` +
    sand +
    `<path class="fx-glass-edge" d="${glass}"/>` +
    `</g>` +
    `<path class="fx-cap" d="M${-GLASS.w / 2 + 0.4} 1.2H${GLASS.w / 2 - 0.4}M${-GLASS.w / 2 + 0.4} ${GLASS.h - 1.2}H${GLASS.w / 2 - 0.4}"/>` +
    `</g>`
  );
}

/** The sixth cell carries the one engraved label: how long a stored answer may still be served if a refresh fails. */
function tagPlate(cx: number, cz: number): string {
  const plate: Plan = { x: cx + 3, y: RACK_FACE, w: CELL.w - 6, d: 0.8, r: 0.4 };
  const z0 = cz + 9;
  const z1 = z0 + 10;
  const text = sideMatrix([plate.x + plate.w / 2, RACK_FACE + 0.8], z0 + 6.4, P, "left");
  const text2 = sideMatrix([plate.x + plate.w / 2, RACK_FACE + 0.8], z0 + 3.4, P, "left");
  return [
    S(slab(plate, z0, z1 - z0, 2, 0.3), { tone: "mid", crease: "faint" }),
    faceTextSvg(text, "STALE-IF-ERROR", { size: 2.1, tone: "mid", anchor: "middle" }),
    faceTextSvg(text2, durationOf(SELF_HOSTED.cacheFreshness.staleIfErrorSeconds).toUpperCase(), {
      size: 2.1,
      tone: "lo",
      anchor: "middle",
    }),
    screws(
      [
        [plate.x + 1.6, RACK_FACE + 0.8, z1 - 1.6],
        [plate.x + plate.w - 1.6, RACK_FACE + 0.8, z1 - 1.6],
      ],
      0.45,
    ),
  ].join("");
}

/* ---------------------------------------------------------------- stamp */

const STAMP_BASE: Plan = { x: STAMP.x - 10, y: 15, w: 20, d: 14, r: 2 };
const STAMP_COLUMN: Plan = { x: STAMP.x - 5, y: 17, w: 10, d: 9, r: 1.5 };
const STAMP_ARM: Plan = { x: STAMP.x - 6, y: 18, w: 12, d: 29, r: 2 };
const STAMP_ARM_Z = 32;

function stampBack(): string {
  return [
    S(slab(STAMP_BASE, 0, 5, 3, 0.5), { tone: "mid" }),
    screws(corners(STAMP_BASE, 2.4).map(([x, y]) => [x, y, 5])),
    S(slab(STAMP_COLUMN, 5, STAMP_ARM_Z - 5, 3, 0.4), {
      tone: "mid",
      inner: L(sideSeam(STAMP_COLUMN, 16, P, 3), { tone: "faint" }),
    }),
    // The ink pad the stamp returns to.
    S(slab({ x: STAMP.x + 9, y: 31, w: 9, d: 7, r: 1 }, 0, 2.4, 2, 0.3), { tone: "lo" }),
  ].join("");
}

function stampFront(): string {
  const head: Plan = { x: STAMP.x - 5.5, y: TRACK.y - 4.5, w: 11, d: 9, r: 1 };
  return [
    live("stamp-shank", shankSvg(STAMP.x, TRACK.y, 1.8, STAMP.headZ + 5, STAMP_ARM_Z)),
    moving(
      "stamp",
      S(slab(insetPlan(head, 1), STAMP.headZ - 1, 1, 2), { tone: "lo", crease: "none" }) +
        S(slab(head, STAMP.headZ, 5, 3, 0.5), { tone: "hi", crease: "lo" }),
    ),
    S(slab(STAMP_ARM, STAMP_ARM_Z, 6, 4, 0.7), {
      tone: "mid",
      inner: L(sideSeam(STAMP_ARM, STAMP_ARM_Z + 2.4, P, 4), { tone: "faint" }),
    }),
    screws([
      [STAMP.x, STAMP_ARM.y + 3, STAMP_ARM_Z + 6],
      [STAMP.x, TRACK.y, STAMP_ARM_Z + 6],
    ]),
  ].join("");
}

/* ---------------------------------------------------------------- splitter, rods and shuttles */

function splitter(): string {
  const top = 11;
  const out = [S(slab(SPLITTER, 0, top, 3, 0.6), { tone: "mid" })];
  out.push(L(planOutline(insetPlan(SPLITTER, 2.4), top, P, 3), { tone: "faint" }));
  // The diverter on top: a wedge that points the plan both ways.
  out.push(
    S(
      extrude(
        [
          [SPLITTER.x + 4, TRACK.y - 3],
          [SPLITTER.x + 11, TRACK.y - 7],
          [SPLITTER.x + 12.5, TRACK.y + 1],
          [SPLITTER.x + 5, TRACK.y + 4],
        ],
        top,
        2.2,
        P,
        { bevel: 0.3 },
      ),
      { tone: "hi", crease: "lo" },
    ),
  );
  out.push(screws(corners(SPLITTER, 2).map(([x, y]) => [x, y, top])));
  return out.join("");
}

function catalogRod(): string {
  return [
    live("catalog-rod-far", catalogRodSvg(CATALOG_ROD.from - 3.5, "far")),
    moving("catalog-shuttle", shuttleSvg("y")),
    live("catalog-rod-near", catalogRodSvg(CATALOG_ROD.from - 3.5, "near")),
  ].join("");
}

function marketRod(): string {
  return [
    live("market-rod-far", marketRodSvg(MARKET_ROD.from + 3.5, "far")),
    moving("market-shuttle", shuttleSvg("x")),
    live("market-rod-near", marketRodSvg(MARKET_ROD.from + 3.5, "near")),
  ].join("");
}

const FEEDER: Plan = { x: MARKET_ROD.to, y: MARKET_ROD.y - 7, w: 9, d: 14, r: 1.5 };

function feeder(): string {
  return [
    S(slab(FEEDER, 0, 12, 3, 0.5), { tone: "mid" }),
    L(planOutline(insetPlan(FEEDER, 2), 12, P, 3), { tone: "faint" }),
    screws([
      [FEEDER.x + 4.5, FEEDER.y + 3, 12],
      [FEEDER.x + 4.5, FEEDER.y + FEEDER.d - 3, 12],
    ]),
  ].join("");
}

/* ---------------------------------------------------------------- catalog cabinet */

function cabinet(): string {
  const plinth = insetPlan(CABINET, -1.5);
  const out = [
    holdDown(plinth.x - 6, CABINET.y + 14, 6, 10),
    S(slab(plinth, 0, CABINET_Z.plinth, 4, 0.5), {
      tone: "lo",
      inner: L(sideSeam(plinth, 3, P, 4), { tone: "faint" }),
    }),
    S(slab(CABINET, CABINET_Z.plinth, CABINET_Z.top - CABINET_Z.plinth, 4, 0.8), {
      tone: "mid",
      inner: L(sideSeam(CABINET, DRAWER.z0 - 1, P, 4), { tone: "faint" }),
    }),
    S(slab(plinth, CABINET_Z.top, CABINET_Z.cap - CABINET_Z.top, 4, 0.8), { tone: "mid" }),
    screws(
      corners(plinth, 3).map(([x, y]) => [x, y, CABINET_Z.cap]),
      0.5,
    ),
    L(planOutline(insetPlan(plinth, 5), CABINET_Z.cap, P, 4), { tone: "faint" }),
    labelPlate({ x: CABINET.x + 7, y: CABINET.y + CABINET.d / 2 - 5, w: 52, d: 10, r: 1.5 }, CABINET_Z.cap),
    holdDown(plinth.x + plinth.w, CABINET.y + 14, 6, 10),
    // The socket the catalog rod ends on.
    S(slab({ x: CATALOG_ROD.x - 4, y: CABINET_FACE + 1.5, w: 8, d: 1.2, r: 0.6 }, 2, 8, 2), { tone: "mid" }),
  ];
  // Drawers bottom row first, then left to right, so an open drawer paints over the one beneath it.
  const order = Array.from({ length: DRAWER.rows * DRAWER.columns }, (_, index) => index).sort((a, b) => {
    const pa = drawerPlan(a);
    const pb = drawerPlan(b);
    return pa.row - pb.row || pa.column - pb.column;
  });
  for (const index of order) out.push(drawer(index));
  return out.join("");
}

function drawer(index: number): string {
  const { x, z } = drawerPlan(index);
  const front: Plan = { x, y: CABINET_FACE, w: DRAWER.w, d: DRAWER.front, r: 0.6 };
  const y = CABINET_FACE + DRAWER.front;
  const mid = x + DRAWER.w / 2;
  const holder = quad([
    [mid - 4.6, y, z + DRAWER.h - 2],
    [mid + 4.6, y, z + DRAWER.h - 2],
    [mid + 4.6, y, z + DRAWER.h - 4.6],
    [mid - 4.6, y, z + DRAWER.h - 4.6],
  ]);
  const pull: Plan = { x: mid - 3, y, w: 6, d: 1.3, r: 0.6 };
  const body =
    S(slab(front, z, DRAWER.h, 2, 0.3), { tone: "mid" }) +
    L(holder, { tone: "lo" }) +
    S(slab(pull, z + 2.2, 1.8, 2), { tone: "hi", crease: "lo" }) +
    screws(
      [
        [mid - 4.6, y, z + DRAWER.h - 3.3],
        [mid + 4.6, y, z + DRAWER.h - 3.3],
      ],
      0.35,
    );
  return live(`drawer-box-${index}`, drawerBoxSvg(index, 0)) + moving(`drawer-${index}`, body);
}

/* ---------------------------------------------------------------- market carousel and the line */

const FUNNEL_POST: [number, number] = [CAROUSEL.x - 19, CAROUSEL.y + 19];

function carouselBack(): string {
  const { x, y, plinthR, r, z } = CAROUSEL;
  const ticks = radialTicks(x, y, plinthR - 0.4, 36, 6, 4, [1, 1.9], P);
  return [
    S(cyl(x, y, plinthR, 0, 4, 72, 0.5), { tone: "lo" }),
    L(ticks.minor, { tone: "lo" }),
    L(ticks.major, { tone: "mid" }),
    S(cyl(x, y, r, 4, z - 4, 72, 0.6), { tone: "mid", inner: L(sideArc(x, y, r, 6, P, 48), { tone: "faint" }) }),
    L(ring(x, y, r - 2.4, z, P, 64), { tone: "faint" }),
    // The bridge over the back of the table carries the escapement pallet.
    S(cyl(BRIDGE_POST[0], BRIDGE_POST[1], 2.2, 0, 21.4, 20), { tone: "mid", crease: "none" }),
  ].join("");
}

/** Where the bridge ends over the escapement wheel, and the pallet's arbor hangs. */
const ARBOR: [number, number] = [CAROUSEL.x + 4.4, CAROUSEL.y - 8.4];

function carouselHub(): string {
  const { x, y, z } = CAROUSEL;
  const bridge = extrude(
    [
      [BRIDGE_POST[0] - 2.2, BRIDGE_POST[1]],
      [BRIDGE_POST[0] + 2.2, BRIDGE_POST[1]],
      [ARBOR[0] + 1.8, ARBOR[1]],
      [ARBOR[0] - 1.8, ARBOR[1]],
    ],
    21.4,
    1.8,
    P,
    { bevel: 0.3 },
  );
  // The pallet: an anchor whose two arms take turns stopping a tooth.
  const pallet = extrude(
    [
      [ARBOR[0] - 1, ARBOR[1] - 0.6],
      [ARBOR[0] + 1, ARBOR[1] - 0.6],
      [ARBOR[0] + 1.4, ARBOR[1] + 2.2],
      [ARBOR[0] - 3.4, ARBOR[1] + 2.4],
    ],
    17.2,
    1.2,
    P,
  );
  return [
    S(cyl(x, y, 4.6, z, 9, 32, 0.4), { tone: "mid" }),
    live("escapement", escapementSvg(0)),
    S(cyl(x, y, 2.8, 18.8, 1.6, 24, 0.3), { tone: "mid" }),
    screws([[x, y, 20.4]], 0.5),
    S(pallet, { tone: "hi", crease: "lo" }),
    S(cyl(ARBOR[0], ARBOR[1], 0.9, 18.4, 3, 16), { tone: "mid", crease: "none" }),
    S(bridge, { tone: "mid" }),
    S(cyl(ARBOR[0], ARBOR[1], 1.8, 21.4, 1.8, 20, 0.3), { tone: "mid" }),
    screws([
      [BRIDGE_POST[0], BRIDGE_POST[1], 23.2],
      [ARBOR[0], ARBOR[1], 23.2],
    ]),
  ].join("");
}

function cradles(): string {
  const slots = [...cradlesAt(0)]
    .sort((a, b) => a.depth - b.depth)
    .map(
      ({ index, at: place }) =>
        `<g data-cradle="${index}" transform="${translateAlong(P, [place[0] - CAROUSEL.x, place[1] - CAROUSEL.y, 0])}">${cradleSvg()}<g data-capsule="${index}" class="fx-capsule" opacity="0">${capsuleSvg()}</g></g>`,
    )
    .join("");
  return `<g data-cradles>${slots}</g>`;
}

function funnel(): string {
  const { x, y, z } = FUNNEL;
  const arm = extrude(
    [
      [FUNNEL_POST[0] - 1.6, FUNNEL_POST[1] - 1.6],
      [FUNNEL_POST[0] + 1.6, FUNNEL_POST[1] + 1.6],
      [x - 3.4, y + 2.4],
      [x - 4.6, y - 1.2],
    ],
    z + 10.6,
    1.8,
    P,
    { bevel: 0.3 },
  );
  return [
    S(cyl(FUNNEL_POST[0], FUNNEL_POST[1], 2, 0, z + 12.4, 20), { tone: "mid", crease: "none" }),
    S(cyl(FUNNEL_POST[0], FUNNEL_POST[1], 3.2, 0, 2.4, 24, 0.3), { tone: "lo" }),
    S(cyl(x, y, 1.8, z, 6, 20), { tone: "mid", crease: "none" }),
    S(cyl(x, y, 3.4, z + 6, 3, 28, 0.3), { tone: "mid" }),
    S(arm, { tone: "mid" }),
    S(cyl(x, y, 5.8, z + 9, 3.6, 40, 0.5), { tone: "hi", crease: "lo" }),
    L(ring(x, y, 4.6, z + 12.6, P, 40), { tone: "lo" }),
    live("funnel-card", ""),
  ].join("");
}

/** The line to Pearl Abyss, its parts in the order the audit settled, and the pulse that runs along it. */
function exitLine(): string {
  const pulses = [0, 1, 2].map(
    (index) => `<path class="fx-pulse" data-pulse="${index}" d="${ROUTE_PATH}" pathLength="100" opacity="0"/>`,
  );
  return lineAssembly().svg + pulses.join("");
}

/* ---------------------------------------------------------------- assembly */

/** The convex hull of screen points, as a closed path. */
function hull(points: Flat[]): string {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Flat, a: Flat, b: Flat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: Flat[]) => {
    const out: Flat[] = [];
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, point) <= 0) out.pop();
      out.push(point);
    }
    return out.slice(0, -1);
  };
  return pathOf([...build(sorted), ...build([...sorted].reverse())], true);
}

/** The card's resting offset: the top of the stack in the tray. */
export const CARD_HOME = translateAlong(P, [AT.tray, 0, TRAY_FLOOR + (TRAY_STACK - 1) * (CARD.h + 0.1) - CARD_Z]);

/** The whole drawing, back to front. */
export function figureBody(): string {
  return [
    base(),
    // The back row: the two cabinets and what stands behind the track.
    cabinet(),
    rack(),
    exitLine(),
    carouselBack(),
    carouselHub(),
    cradles(),
    catalogRod(),
    splitter(),
    turnstileBack(),
    punchBack(),
    gaugeBack(),
    stampBack(),
    marketRod(),
    feeder(),
    funnel(),
    trayBack(),
    trackBack(),
    // The card, between everything behind the track and everything over or in front of it.
    `<g data-move="card" class="fx-card" transform="${CARD_HOME}">${travellingCard()}</g>`,
    trayFront(),
    trackFront(),
    moving("gate", gateArm()),
    gaugeFront(),
    punchFront(),
    stampFront(),
  ].join("");
}
