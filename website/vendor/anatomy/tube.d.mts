// Declarations for the parts of tube.mjs the site uses. Written for this repository, not upstream; see README.md.
import type { Point3, Projection } from "./iso-kit.ts";

export interface TubePiece {
  mid: Point3;
  points: Point3[];
  radii: number[];
}

export interface TubeOptions {
  maxLength?: number;
  spacing?: number;
  breaks?: number[];
  gaps?: Array<[number, number]>;
  caps?: boolean | [boolean, boolean];
  stripes?: boolean | "auto";
  rings?: { pitch?: number; twist?: number; cross?: boolean; fade?: [number, number]; tone?: string } | null;
}

export function tubePieces(points: Point3[], radius: number | ((t: number) => number), P: Projection, options?: TubeOptions): TubePiece[];
export function tubeSvg(piece: TubePiece, options?: { tone?: string }): string;
export function crossingsOf(points: Point3[], centre: Point3, axis: Point3, radius: number): number[];
