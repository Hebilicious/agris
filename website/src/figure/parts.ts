/**
 * Parts whose shape changes as the figure runs. The build draws each at rest; the live script calls the same function
 * with the current value and writes the result, so the moving picture is the static art at another value.
 */
import {
  cylinder,
  depthOf,
  extrude,
  iso,
  lineOnTop,
  onTop,
  sideArc,
  pathOf,
  slabOf,
  solidSvg,
  lineSvg,
  type Plane,
  type Point3,
} from "../../vendor/anatomy/iso-kit.ts";
import {
  CABINET_FACE,
  CAROUSEL,
  CATALOG_ROD,
  CELL,
  CELLS,
  DRAWER,
  HOLE,
  MARKET_ROD,
  P,
  RACK_FACE,
  ROD,
  SHUTTLE,
  TURNSTILE,
  cellOrigin,
} from "./layout.ts";

const TAU = Math.PI * 2;

/** A saw-toothed ring: each tooth rises slowly and drops sharply, the way a ratchet only turns one way. */
function sawRing(cx: number, cy: number, outer: number, inner: number, teeth: number, angle: number): Plane[] {
  const ring: Plane[] = [];
  for (let tooth = 0; tooth < teeth; tooth++) {
    const at = angle + (tooth / teeth) * TAU;
    const next = angle + ((tooth + 0.92) / teeth) * TAU;
    ring.push([cx + inner * Math.cos(at), cy + inner * Math.sin(at)]);
    ring.push([cx + outer * Math.cos(next), cy + outer * Math.sin(next)]);
    ring.push([cx + inner * Math.cos(next + (0.04 / teeth) * TAU), cy + inner * Math.sin(next + (0.04 / teeth) * TAU)]);
  }
  return ring;
}

/** The turnstile's ratchet wheel at an angle: a solid disc with its saw teeth cut into the top, one per request. */
export function ratchetSvg(angle: number, teeth: number): string {
  const { x, y, top, wheelR, wheelH } = TURNSTILE;
  const z = top + wheelH;
  const wheel = cylinder(x, y, wheelR, top, wheelH, P, 72, 0.4);
  const saw = onTop(sawRing(x, y, wheelR - 0.5, wheelR - 1.9, teeth, angle), z, P, true);
  const index = lineOnTop(
    [x + 3.4 * Math.cos(angle), y + 3.4 * Math.sin(angle)],
    [x + (wheelR - 1.9) * Math.cos(angle), y + (wheelR - 1.9) * Math.sin(angle)],
    z,
    P,
  );
  return (
    solidSvg(wheel, {
      tone: "mid",
      inner: lineSvg(sideArc(x, y, wheelR, top + wheelH / 2, P, 48), { tone: "faint" }),
    }) +
    lineSvg(saw, { tone: "lo" }) +
    lineSvg(index, { tone: "lit" })
  );
}

/** The carousel's escapement wheel: a disc with fifteen teeth that let the table step one cradle at a time. */
export function escapementSvg(angle: number): string {
  const { x, y } = CAROUSEL;
  const teeth = 15;
  const star: Plane[] = [];
  for (let tooth = 0; tooth < teeth; tooth++) {
    const at = angle + (tooth / teeth) * TAU;
    star.push([x + 5.2 * Math.cos(at), y + 5.2 * Math.sin(at)]);
    star.push([x + 6.6 * Math.cos(at + 0.14), y + 6.6 * Math.sin(at + 0.14)]);
    star.push([x + 5.6 * Math.cos(at + 0.32), y + 5.6 * Math.sin(at + 0.32)]);
  }
  return (
    solidSvg(cylinder(x, y, 7, 17, 1.8, P, 56, 0.3), { tone: "mid" }) +
    lineSvg(onTop(star, 18.8, P, true), { tone: "lo" })
  );
}

/** Where each of the six cradles stands when the table has turned `angle` radians, in the order to paint them. */
export function cradlesAt(angle: number): { index: number; at: Point3; depth: number }[] {
  return Array.from({ length: 6 }, (_, index) => {
    const turn = angle + Math.PI / 2 + (index * TAU) / 6;
    const at: Point3 = [
      CAROUSEL.x + CAROUSEL.cradleR * Math.cos(turn),
      CAROUSEL.y + CAROUSEL.cradleR * Math.sin(turn),
      CAROUSEL.z,
    ];
    return { index, at, depth: depthOf(at, P) };
  });
}

/** One cradle drawn at the carousel's centre; the live script moves each copy to its place with a translate. */
export function cradleSvg(): string {
  const { x, y, z, cradleSize } = CAROUSEL;
  const cup = cylinder(x, y, cradleSize, z, 3.6, P, 28, 0.4);
  const bore = pathOf(
    Array.from({ length: 28 }, (_, step) =>
      iso([x + 2.5 * Math.cos((step / 28) * TAU), y + 2.5 * Math.sin((step / 28) * TAU), z + 3.6], P),
    ),
    true,
  );
  return solidSvg(cup, { tone: "mid" }) + lineSvg(bore, { tone: "lo" });
}

/** The carriage a cradle carries to Pearl Abyss: a capsule standing in the cup. */
export function capsuleSvg(): string {
  const { x, y, z } = CAROUSEL;
  return solidSvg(cylinder(x, y, 2.2, z + 2.2, 4.4, P, 24, 0.3), { tone: "hi" });
}

/** The answer card lying in a pigeonhole, sticking `out` units out of the face (0 when filed flush). */
export function stubSvg(cell: number, out: number): string {
  const spec = CELLS[cell];
  if (spec === undefined) return "";
  const [cx, cz] = cellOrigin(spec.row, spec.column);
  const z = cz + HOLE.z;
  const plan = { x: cx + HOLE.x + 1.5, y: RACK_FACE - HOLE.depth + 2, w: HOLE.w - 3, d: HOLE.depth - 2 + out, r: 0.5 };
  return solidSvg(slabOf(plan, z, 0.9, P, 2), { tone: "hi", crease: "lo" });
}

/** The screen polygon of a pigeonhole's opening, which clips what lies inside it. */
export function holeOpening(cell: number): string {
  const spec = CELLS[cell];
  if (spec === undefined) return "";
  const [cx, cz] = cellOrigin(spec.row, spec.column);
  const x0 = cx + HOLE.x;
  const z0 = cz + HOLE.z;
  const corners: Point3[] = [
    [x0, RACK_FACE, z0],
    [x0 + HOLE.w, RACK_FACE, z0],
    [x0 + HOLE.w, RACK_FACE, z0 + HOLE.h],
    [x0, RACK_FACE, z0 + HOLE.h],
  ];
  return pathOf(
    corners.map((point) => iso(point, P)),
    true,
  );
}

/** The two Service Binding rods, cut where their shuttle rides so the near piece paints over it. */
export function catalogRodSvg(at: number, side: "far" | "near"): string {
  const { x, from, to } = CATALOG_ROD;
  const y0 = side === "far" ? to : at + SHUTTLE.long / 2;
  const y1 = side === "far" ? at - SHUTTLE.long / 2 : from;
  if (y1 - y0 < 0.2) return "";
  return solidSvg(
    slabOf({ x: x - ROD.r, y: y0, w: ROD.r * 2, d: y1 - y0, r: ROD.r - 0.2 }, ROD.z - ROD.r, ROD.r * 2, P, 3),
    {
      tone: "mid",
      crease: "none",
    },
  );
}

export function marketRodSvg(at: number, side: "far" | "near"): string {
  const { y, from, to } = MARKET_ROD;
  const x0 = side === "far" ? from : at + SHUTTLE.long / 2;
  const x1 = side === "far" ? at - SHUTTLE.long / 2 : to;
  if (x1 - x0 < 0.2) return "";
  return solidSvg(
    slabOf({ x: x0, y: y - ROD.r, w: x1 - x0, d: ROD.r * 2, r: ROD.r - 0.2 }, ROD.z - ROD.r, ROD.r * 2, P, 3),
    {
      tone: "mid",
      crease: "none",
    },
  );
}

/** A shuttle that rides a rod, drawn at the rod's origin; the live script translates it along. */
export function shuttleSvg(axis: "x" | "y"): string {
  const plan =
    axis === "y"
      ? { x: CATALOG_ROD.x - SHUTTLE.wide / 2, y: -SHUTTLE.long / 2, w: SHUTTLE.wide, d: SHUTTLE.long, r: 1 }
      : { x: -SHUTTLE.long / 2, y: MARKET_ROD.y - SHUTTLE.wide / 2, w: SHUTTLE.long, d: SHUTTLE.wide, r: 1 };
  const centre: Plane = axis === "y" ? [CATALOG_ROD.x, 0] : [0, MARKET_ROD.y];
  const top = SHUTTLE.z + SHUTTLE.h;
  const screws = [-1, 1].map((side) =>
    iso(axis === "y" ? [centre[0] + side * 2, centre[1], top] : [centre[0], centre[1] + side * 2, top], P),
  );
  return (
    solidSvg(slabOf(plan, SHUTTLE.z, SHUTTLE.h, P, 3, 0.5), { tone: "mid" }) +
    `<g class="iso-dots" data-tone="mid">${screws.map(([sx, sy]) => `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="0.45"/>`).join("")}</g>`
  );
}

/** Where a drawer sits on the cabinet's face: row 0 at the bottom, column 0 at the left. */
export function drawerPlan(index: number) {
  const row = DRAWER.rows - 1 - Math.floor(index / DRAWER.columns);
  const column = index % DRAWER.columns;
  const x = DRAWER.x0 + column * (DRAWER.w + DRAWER.gap);
  const z = DRAWER.z0 + row * (DRAWER.h + DRAWER.gap);
  return { x, z, row, column };
}

/** The box of an open drawer, the part in front of the face: floor, far side, index cards, near side. */
export function drawerBoxSvg(index: number, open: number): string {
  if (open < 0.2) return "";
  const { x, z } = drawerPlan(index);
  const y = CABINET_FACE;
  const side = (sx: number) => slabOf({ x: sx, y, w: 0.9, d: open, r: 0 }, z + 1, DRAWER.h - 3.4, P, 1);
  const floor = slabOf({ x: x + 0.9, y, w: DRAWER.w - 1.8, d: open, r: 0 }, z + 1, 0.8, P, 1);
  const cards = Array.from({ length: Math.max(0, Math.floor(open / 2.4)) }, (_, card) =>
    solidSvg(
      slabOf({ x: x + 2, y: y + 1.2 + card * 2.4, w: DRAWER.w - 4, d: 0.5, r: 0 }, z + 1.8, DRAWER.h - 4.6, P, 1),
      {
        tone: "lo",
        crease: "none",
      },
    ),
  );
  return [
    solidSvg(floor, { tone: "lo", crease: "none" }),
    solidSvg(side(x), { tone: "mid", crease: "none" }),
    ...cards,
    solidSvg(side(x + DRAWER.w - 0.9), { tone: "mid", crease: "none" }),
  ].join("");
}

/** A tool shank from the underside of its arm down to the tool, whatever the stroke. */
export function shankSvg(cx: number, cy: number, r: number, bottom: number, top: number): string {
  if (top - bottom < 0.1) return "";
  return solidSvg(cylinder(cx, cy, r, bottom, top - bottom, P, 20), { tone: "mid", crease: "none" });
}

/** The post the pawl pivots on, beside the ratchet wheel. */
export const PAWL_POST: [number, number] = [TURNSTILE.x + 12.6, TURNSTILE.y - 5.4];

/** The pawl that rides the wheel's teeth; lit when the allowance is spent and it holds the wheel. */
export function pawlSvg(holding: boolean): string {
  const [px, py] = PAWL_POST;
  const z = TURNSTILE.top + 0.6;
  const arm = extrude(
    [
      [px - 1.1, py - 1.1],
      [px + 1.1, py + 1.1],
      [px - 3.6, py + 6.2],
      [px - 5.2, py + 5.1],
    ],
    z,
    1.8,
    P,
  );
  return (
    solidSvg(arm, { tone: holding ? "hi" : "mid", lit: holding }) +
    solidSvg(cylinder(px, py, 1.9, z + 1.8, 0.8, P, 16), { tone: "mid" })
  );
}

export const CELL_COUNT = CELLS.length;
export { CELL };
