/**
 * Where each station of Fig 1 sits, as a world-space box, so the page can show a label when a reader points at or
 * taps a part. The build projects each box to its outline on screen; the outlines are invisible until hovered or
 * focused. The words for each part live with the page, which reads its numbers from `src/facts.ts`.
 */
import { depthOf, iso, pathOf, type Flat, type Point3 } from "../../vendor/anatomy/iso-kit.ts";
import { CABINET, CAROUSEL, P, RACK, SPLITTER, STAMP, TERMINAL, TRAY, TURNSTILE, PUNCH, AT } from "./layout.ts";

export type HotspotId =
  | "tray"
  | "file"
  | "turnstile"
  | "punch"
  | "gauge"
  | "rack"
  | "stamp"
  | "splitter"
  | "cabinet"
  | "carousel"
  | "line";

/** A box from its low corner to its high corner: `[x0, y0, z0, x1, y1, z1]`. */
type Box = readonly [number, number, number, number, number, number];

const BOXES: Readonly<Record<HotspotId, Box>> = {
  tray: [TRAY.x, TRAY.y, 0, TRAY.x + TRAY.w, TRAY.y + TRAY.d, 9],
  file: [-186, -100, 0, -152, -74, 11],
  turnstile: [TURNSTILE.x - 10, TURNSTILE.y - 12, 0, TURNSTILE.x + 16, 50, TURNSTILE.top + 4],
  punch: [PUNCH.x - 12, 11, 0, PUNCH.x + 12, 46, PUNCH.ramTop + 12],
  gauge: [AT.gauge - 6, 26, 0, AT.gauge + 6, 56, 27],
  rack: [RACK.x - 2, RACK.y - 2, 0, RACK.x + RACK.w + 2, RACK.y + RACK.d + 2, 68],
  stamp: [STAMP.x - 10, 15, 0, STAMP.x + 10, 47, 38],
  splitter: [SPLITTER.x, SPLITTER.y, 0, SPLITTER.x + SPLITTER.w, SPLITTER.y + SPLITTER.d, 14],
  cabinet: [CABINET.x - 2, CABINET.y - 2, 0, CABINET.x + CABINET.w + 2, CABINET.y + CABINET.d + 2, 62],
  carousel: [CAROUSEL.x - 25, CAROUSEL.y - 28, 0, CAROUSEL.x + 25, CAROUSEL.y + 25, 33],
  line: [TERMINAL.x, TERMINAL.y, 0, TERMINAL.x + TERMINAL.w, -14, 58],
};

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

export interface Hotspot {
  readonly id: HotspotId;
  /** The box's outline on screen, in the drawing's coordinates. */
  readonly path: string;
}

/** Every hotspot, back to front, so a nearer part takes the pointer where two outlines overlap. */
export function hotspots(): readonly Hotspot[] {
  return (Object.entries(BOXES) as [HotspotId, Box][])
    .map(([id, [x0, y0, z0, x1, y1, z1]]) => {
      const corners: Point3[] = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
      const centre: Point3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
      return { id, path: hull(corners.map((corner) => iso(corner, P))), depth: depthOf(centre, P) };
    })
    .sort((a, b) => a.depth - b.depth)
    .map(({ id, path }) => ({ id, path }));
}
