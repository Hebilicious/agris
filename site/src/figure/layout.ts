/**
 * Where everything stands on the bench, in world units (about one pixel at scale 1): x along the bench, y toward the
 * front, z up. Both the build-time art and the live script read these, so a moving part always lands where the static
 * art left room for it.
 */
import { fitProjection, type Plan, type Point3, type Projection } from "../../vendor/anatomy/iso-kit.ts";

export const WIDTH = 640;
export const HEIGHT = 312;
export const AZIMUTH = 60;

/** The bench: a cast plate on four feet. */
export const PLATE: Plan = { x: -200, y: -124, w: 396, d: 186, r: 10 };
export const PLATE_H = 12;
export const FOOT_H = 5;

/** The card track along the front of the bench. Cards lie on the bed between two lips. */
export const TRACK = { from: -164, to: 84, y: 40, bed: 14, lip: 2.2, lipH: 3.4, bedH: 1.2 } as const;
export const CARD = { w: 18, d: 11, h: 0.8 } as const;
/** Height of a card's underside on the track bed. */
export const CARD_Z = TRACK.bedH;

/** The client's tray, where cards start and come back to. */
export const TRAY: Plan = { x: -195, y: 27, w: 28, d: 26, r: 2 };
export const TRAY_FLOOR = 2;
export const TRAY_STACK = 4;

/** Station centres along the track. */
export const AT = {
  tray: -181,
  turnstile: -140,
  punch: -106,
  gauge: -74,
  rack: 0,
  stamp: 60,
  splitter: 80,
} as const;

/** Intake turnstile: a post behind the track carrying a 60-tooth ratchet wheel and a pawl. */
export const TURNSTILE = { x: AT.turnstile, y: 20, postR: 4, top: 26, wheelR: 12, wheelH: 2.6, teeth: 60 } as const;
/** The gate arm over the track: down blocks a card, up lets it pass. */
export const GATE = { z: 2.6, h: 2.6, lift: 9 } as const;

/** The card punch: a column behind the track, a head over it and a ram that comes down. */
export const PUNCH = { x: AT.punch, ramR: 3, ramZ: 9, ramTop: 33, stroke: 6.6 } as const;

/** The pigeonhole rack: six cells on its front face, two rows of three. */
export const RACK: Plan = { x: -44, y: -32, w: 88, d: 46, r: 2 };
export const RACK_FACE = RACK.y + RACK.d;
export const RACK_Z = { plinth: 4, top: 64, cornice: 68 } as const;
export const CELL = { w: 28, h: 29, x0: -42, z0: 5 } as const;
/** Pigeonhole openings within a cell (cell-local x from its left, z from its bottom), and how deep they go. */
export const HOLE = { x: 2, w: 12.5, z: 6, h: 8, depth: 12 } as const;
/** The hourglass window within a cell. */
export const GLASS = { x: 16, w: 10, z: 2.2, h: 25.4 } as const;
/** The lock plug above each opening. */
export const LOCK = { x: 8.2, z: 20, r: 3 } as const;

/** Cells, row-major from the top left: which card each one answers. `null` is the stale-if-error tag plate. */
export const CELLS = [
  { row: 0, column: 0, kind: "prices" },
  { row: 0, column: 1, kind: "orderBook" },
  { row: 0, column: 2, kind: "hot" },
  { row: 1, column: 0, kind: "names" },
  { row: 1, column: 1, kind: "search" },
  { row: 1, column: 2, kind: null },
] as const;

export const cellOrigin = (row: number, column: number): [number, number] => [
  CELL.x0 + column * CELL.w,
  CELL.z0 + (1 - row) * CELL.h,
];

/** The stamp that marks every answer with its Cache-Control. */
export const STAMP = { x: AT.stamp, headZ: 12, stroke: 10 } as const;

/** The splitter at the end of the track, and the two Service Binding rods it drives. */
export const SPLITTER: Plan = { x: 86, y: 30, w: 16, d: 20, r: 2 };
export const ROD = { r: 2, z: 6 } as const;
/** The catalog rod runs back along −y at this x; the market rod runs along +x at this y. */
export const CATALOG_ROD = { x: 94, from: 30, to: -66.5 } as const;
export const MARKET_ROD = { y: 40, from: 102, to: 134 } as const;
export const SHUTTLE = { long: 7, wide: 7.4, z: 2.6, h: 7 } as const;

/** The catalog: a card-index cabinet of 12 drawers, one per locale, on a plinth. */
export const CABINET: Plan = { x: 62, y: -112, w: 66, d: 44, r: 2 };
export const CABINET_FACE = CABINET.y + CABINET.d;
export const CABINET_Z = { plinth: 11, top: 59, cap: 62 } as const;
export const DRAWER = { columns: 3, rows: 4, w: 19, h: 10.6, gap: 1.8, x0: 64.6, z0: 13, front: 1.6, open: 9 } as const;

/** The market: an escapement carousel with one cradle per carriage, under a merge funnel. */
export const CAROUSEL = { x: 166, y: 22, r: 22, plinthR: 24, cradleR: 15.5, cradleSize: 3.8, z: 8 } as const;
/** The post that carries the escapement bridge, clear of the plinth: centre distance at least plinth + post radius. */
export const BRIDGE_POST: [number, number] = [CAROUSEL.x + 8, CAROUSEL.y - 26];
export const BRIDGE_POST_R = 2.2;
/** The funnel stands over the loading position at the front of the carousel. */
export const FUNNEL = { x: 166, y: 22 + 15.5, z: 19 } as const;

/** The gland behind the carousel where the line to Pearl Abyss starts. */
export const GLAND: Plan = { x: 176, y: -26, w: 12, d: 12, r: 1.5 };
export const GLAND_H = 15;

/**
 * The one line that leaves the bench: from the gland's back face it climbs and runs back off the bench to a terminal
 * plate standing beyond it, at the edge of the drawing.
 */
export const LINE = { r: 2.2, x: GLAND.x + GLAND.w / 2, z: 8, rise: 34, clampY: -104, terminalY: -158 } as const;
export const TERMINAL: Plan = { x: LINE.x - 15, y: LINE.terminalY - 4, w: 30, d: 4, r: 1.2 };
export const TERMINAL_Z = { from: 10, to: 56 } as const;

export const P: Projection = fitProjection(
  [
    [PLATE.x, PLATE.y + PLATE.d, -PLATE_H - FOOT_H],
    [PLATE.x, PLATE.y, -PLATE_H - FOOT_H],
    [PLATE.x + PLATE.w, PLATE.y + PLATE.d, -PLATE_H - FOOT_H],
    [PLATE.x + PLATE.w, PLATE.y, -PLATE_H - FOOT_H],
    [PLATE.x, PLATE.y, 0],
    [RACK.x, RACK.y, RACK_Z.cornice],
    [CABINET.x, CABINET.y, CABINET_Z.cap],
    [TERMINAL.x, TERMINAL.y, TERMINAL_Z.to],
    [TERMINAL.x + TERMINAL.w, TERMINAL.y, TERMINAL_Z.to],
    [TERMINAL.x + TERMINAL.w, TERMINAL.y + TERMINAL.d, TERMINAL_Z.from],
  ] satisfies Point3[],
  WIDTH,
  HEIGHT,
  { pad: 10, azimuth: AZIMUTH },
);
