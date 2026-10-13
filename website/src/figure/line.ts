/**
 * The one line that leaves the bench: from a flange on the gland behind the carousel it runs back, climbs, passes a
 * clamp on a standoff post, and ends on a boss on the terminal plate that stands beyond the bench. It is the only part
 * of the drawing with a pipe, so it is the part the anatomy audit proves (`figure-audit.ts`): every shape here is
 * recorded as it is drawn, and the painter's keys come from `settle`.
 */
import * as A from "../../vendor/anatomy/audit.mjs";
import { cylinder, dotsSvg, iso, pathOf, slabOf, solidSvg, type Point3 } from "../../vendor/anatomy/iso-kit.ts";
import * as G from "../../vendor/anatomy/lathe.mjs";
import { tubePieces, tubeSvg } from "../../vendor/anatomy/tube.mjs";
import {
  BRIDGE_POST,
  BRIDGE_POST_R,
  CABINET,
  CABINET_Z,
  CAROUSEL,
  GLAND,
  GLAND_H,
  LINE,
  P,
  PLATE,
  PLATE_H,
  TERMINAL,
  TERMINAL_Z,
} from "./layout.ts";

const FLANGE = { r: LINE.r * 1.6, thick: 1.2 } as const;
const CLAMP = { r: LINE.r * 1.55, thick: 2.2 } as const;
const BOSS = { r: 5.2, thick: 2 } as const;
const POST_R = 1.4;

/** Where the line starts (on the gland's back face) and ends (on the terminal boss's face). */
export const LINE_START: Point3 = [LINE.x, GLAND.y, LINE.z];
export const LINE_END: Point3 = [LINE.x, TERMINAL.y + TERMINAL.d + BOSS.thick, LINE.rise];

/** The centreline: straight off the port, a climb in the plane that faces the viewer, then straight to the terminal. */
export const ROUTE: Point3[] = G.fillet(
  [LINE_START, [LINE.x, GLAND.y - 16, LINE.z], [LINE.x, GLAND.y - 40, LINE.rise], LINE_END],
  LINE.r * 3,
  12,
  { P, tube: LINE.r },
);
export const ROUTE_LENGTH = G.pathLength(ROUTE);
/** The clamp sits on the last straight, where the line crosses the back of the bench. */
const CLAMP_ALONG = ROUTE_LENGTH - (LINE.clampY - LINE_END[1]);

/** The route's centreline on screen, for the pulse that runs along it on each upstream call. */
export const ROUTE_PATH = pathOf(ROUTE.map((point) => iso(point, P)));

export interface LineAssembly {
  readonly R: A.Recorder;
  /** Back to front, as `settle` ordered them. */
  readonly svg: string;
}

export function lineAssembly(): LineAssembly {
  const R = A.recorder(P);
  const V = G.viewOf(P);
  const record = (shape: A.Shape) => R.solid(shape);
  const put = (name: string, at: Point3, svg: string, shapes: A.Shape[], bias = 0) =>
    R.put({ name, at, svg, shapes, bias });

  // What the line stands on: the bench plate and the terminal beyond it are fixed.
  record(A.slab(PLATE, -PLATE_H, PLATE_H, { name: "stand.plate" }, 8));
  // The neighbours it passes, recorded so the clearance check sees them: the cabinet and the carousel with its bridge.
  record(A.slab(CABINET, 0, CABINET_Z.cap, { name: "cabinet" }, 4));
  record(A.cylinder(CAROUSEL.x, CAROUSEL.y, CAROUSEL.plinthR, 0, CAROUSEL.z, { name: "carousel" }));
  record(A.cylinder(BRIDGE_POST[0], BRIDGE_POST[1], BRIDGE_POST_R, 0, 23.2, { name: "carousel.bridge-post" }));

  put(
    "line.gland",
    [GLAND.x + GLAND.w / 2, GLAND.y + GLAND.d / 2, GLAND_H / 2],
    solidSvg(slabOf(GLAND, 0, GLAND_H, P, 3, 0.5), { tone: "mid" }) +
      dotsSvg(
        [
          iso([GLAND.x + 2.4, GLAND.y + GLAND.d - 2.4, GLAND_H], P),
          iso([GLAND.x + GLAND.w - 2.4, GLAND.y + GLAND.d - 2.4, GLAND_H], P),
        ],
        { size: 0.45, tone: "mid" },
      ),
    [record(A.slab(GLAND, 0, GLAND_H, { name: "line.gland" }, 3))],
  );

  const terminal = TERMINAL;
  put(
    "stand.terminal",
    [terminal.x + terminal.w / 2, terminal.y + terminal.d / 2, (TERMINAL_Z.from + TERMINAL_Z.to) / 2],
    solidSvg(slabOf(terminal, TERMINAL_Z.from, TERMINAL_Z.to - TERMINAL_Z.from, P, 3, 0.8), { tone: "mid" }) +
      dotsSvg(
        [
          [terminal.x + 3, TERMINAL_Z.from + 3],
          [terminal.x + terminal.w - 3, TERMINAL_Z.from + 3],
          [terminal.x + 3, TERMINAL_Z.to - 3],
          [terminal.x + terminal.w - 3, TERMINAL_Z.to - 3],
        ].map(([x, z]) => iso([x ?? 0, terminal.y + terminal.d, z ?? 0], P)),
        { size: 0.6, tone: "mid" },
      ),
    [record(A.slab(terminal, TERMINAL_Z.from, TERMINAL_Z.to - TERMINAL_Z.from, { name: "stand.terminal" }, 3))],
  );

  // The boss on the terminal's face that the line's far flange bolts to.
  const bossFrame = G.frameAlong([LINE.x, terminal.y + terminal.d + BOSS.thick / 2, LINE.rise], [0, 1, 0]);
  put(
    "line.boss",
    bossFrame.o,
    solidSvg(G.disc(-BOSS.thick / 2, BOSS.thick / 2, BOSS.r, bossFrame, P), { tone: "mid" }) +
      dotsSvg(G.dotsOf(bossFrame, BOSS.thick / 2, BOSS.r - 1.2, 6, P, { all: true }), { size: 0.45, tone: "mid" }),
    [record(A.disc(bossFrame, -BOSS.thick / 2, BOSS.thick / 2, BOSS.r, { name: "line.boss" }))],
  );

  // The standoff that holds the line where it crosses the back of the bench.
  const clampCentre = G.pointAlong(ROUTE, CLAMP_ALONG);
  const postTop = clampCentre[2] - CLAMP.r + 0.1;
  put(
    "line.post-foot",
    [LINE.x, LINE.clampY, 0.8],
    solidSvg(cylinder(LINE.x, LINE.clampY, 3.4, 0, 1.6, P, 28, 0.3), { tone: "lo" }) +
      dotsSvg([iso([LINE.x - 2.4, LINE.clampY, 1.6], P), iso([LINE.x + 2.4, LINE.clampY, 1.6], P)], {
        size: 0.4,
        tone: "mid",
      }),
    [record(A.cylinder(LINE.x, LINE.clampY, 3.4, 0, 1.6, { name: "line.post-foot" }))],
  );
  put(
    "line.post",
    [LINE.x, LINE.clampY, postTop / 2],
    solidSvg(cylinder(LINE.x, LINE.clampY, POST_R, 1.6, postTop - 1.6, P, 18), { tone: "mid", crease: "none" }),
    [record(A.cylinder(LINE.x, LINE.clampY, POST_R, 1.6, postTop - 1.6, { name: "line.post" }))],
  );
  const clampFrame = G.frameAlong(clampCentre, G.tangentAlong(ROUTE, CLAMP_ALONG));
  put(
    "line.clamp",
    clampCentre,
    solidSvg(G.disc(-CLAMP.thick / 2, CLAMP.thick / 2, CLAMP.r, clampFrame, P), { tone: "mid" }),
    [
      record(
        A.disc(clampFrame, -CLAMP.thick / 2, CLAMP.thick / 2, CLAMP.r, { name: "line.clamp", owner: "line.pipe" }),
      ),
    ],
  );

  // The two end flanges, each with its back face on the route's end.
  const flange = (name: string, along: number, sign: 1 | -1) => {
    const tangent = G.tangentAlong(ROUTE, along);
    const centre = G.add3(G.pointAlong(ROUTE, along), G.mul3(tangent, (-sign * FLANGE.thick) / 2));
    const frame = G.frameAlong(centre, tangent);
    const facing = Math.abs(G.dot3(frame.a, V)) > 0.12;
    const bolts = facing
      ? dotsSvg(G.dotsOf(frame, (sign * FLANGE.thick) / 2, FLANGE.r * 0.72, 6, P, { all: true }), {
          size: 0.38,
          tone: "mid",
        })
      : "";
    put(
      name,
      centre,
      solidSvg(G.disc(-FLANGE.thick / 2, FLANGE.thick / 2, FLANGE.r, frame, P), { tone: "hi", crease: "lo" }) + bolts,
      [record(A.disc(frame, -FLANGE.thick / 2, FLANGE.thick / 2, FLANGE.r, { name, owner: "line.pipe" }))],
    );
  };
  flange("line.flange-gland", 0, -1);
  flange("line.flange-terminal", ROUTE_LENGTH, 1);

  // The pipe itself, gapped under each flange and the clamp, in depth-sortable chunks.
  const clampSpan: [number, number] = [CLAMP_ALONG - CLAMP.thick / 2, CLAMP_ALONG + CLAMP.thick / 2];
  const gaps: Array<[number, number]> = [[0, FLANGE.thick], clampSpan, [ROUTE_LENGTH - FLANGE.thick, ROUTE_LENGTH]];
  R.route("line.pipe", ROUTE, LINE.r, { owner: "line.pipe", gaps, rims: [FLANGE.r, FLANGE.r], touch: ["line.clamp"] });
  tubePieces(ROUTE, LINE.r, P, { maxLength: 16, gaps }).forEach((piece, index) =>
    put(`line.pipe:${index}`, piece.mid, tubeSvg(piece, { tone: "hi" }), [
      A.tube(piece.points, piece.radii, { name: "line.pipe", owner: "line.pipe" }),
    ]),
  );

  A.settle(R, P);
  const svg = [...R.items]
    .sort((a, b) => a.key - b.key)
    .map((item) => item.svg ?? "")
    .join("");
  return { R, svg };
}
