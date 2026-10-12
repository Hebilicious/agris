// Declarations for the parts of audit.mjs the site uses. Written for this repository, not upstream; see README.md.
import type { Plan, Point3, Projection } from "./iso-kit.ts";
import type { Frame } from "./lathe.mjs";

export interface ShapeMeta {
  name?: string;
  owner?: string;
  touch?: string[];
  ground?: boolean;
  anchor?: boolean;
  fitting?: boolean;
  seated?: boolean;
}

/** A recorded shape; the audit reads its fields, the site only passes it along. */
export interface Shape {
  readonly name?: string;
}

export interface Item {
  key: number;
  name: string;
  svg?: string;
}

export interface Recorder {
  items: Item[];
  put(item: { at?: Point3; bias?: number; key?: number; name?: string; piece?: string; shapes?: Shape[]; svg?: string }): Item;
  solid(shape: Shape): Shape;
  route(
    name: string,
    points: Point3[],
    radius: number,
    options?: { owner?: string; touch?: string[]; gaps?: Array<[number, number]>; rims?: [number, number]; piece?: string },
  ): Shape[];
  nameFor(base: string): string;
}

export function recorder(P: Projection, options?: Record<string, unknown>): Recorder;
export function slab(plan: Plan, z: number, height: number, meta?: ShapeMeta, steps?: number): Shape;
export function cylinder(cx: number, cy: number, r: number, z: number, height: number, meta?: ShapeMeta): Shape;
export function disc(F: Frame, s0: number, s1: number, r: number, meta?: ShapeMeta): Shape;
export function tube(points: Point3[], radius: number | number[], meta?: ShapeMeta): Shape;
export function settle(R: Recorder, P?: Projection): void;
export function auditOrExit(R: Recorder, P?: Projection, options?: { argv?: string[]; crowd?: Array<[string, string]>; cover?: string[] }): unknown;
