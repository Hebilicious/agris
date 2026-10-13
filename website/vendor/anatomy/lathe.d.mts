// Declarations for the parts of lathe.mjs the site uses. Written for this repository, not upstream; see README.md.
import type { Flat, Point3, Projection, SolidPaths } from "./iso-kit.ts";

export interface Frame {
  o: Point3;
  a: Point3;
  u: Point3;
  v: Point3;
}

export function frameAlong(o: Point3, a: Point3): Frame;
export function disc(s0: number, s1: number, r: number, F: Frame, P: Projection, options?: Record<string, unknown>): SolidPaths;
export function fillet(points: Point3[], radius: number, perArc?: number, options?: { P?: Projection; tube?: number; margin?: number }): Point3[];
export function pathLength(points: Point3[]): number;
export function pointAlong(points: Point3[], at: number): Point3;
export function tangentAlong(points: Point3[], at: number): Point3;
export function cut(points: Point3[], from: number, to: number): Point3[];
export function dotsOf(F: Frame, s: number, r: number, count: number, P: Projection, options?: { all?: boolean; fade?: [number, number] }): Array<Flat | [number, number, number]>;
export function circleOf(F: Frame, s: number, r: number, P: Projection, steps?: number): string;
export function viewOf(P: Projection): Point3;
export function add3(a: Point3, b: Point3): Point3;
export function sub3(a: Point3, b: Point3): Point3;
export function mul3(a: Point3, k: number): Point3;
export function dot3(a: Point3, b: Point3): number;
