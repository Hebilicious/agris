import { test } from "vitest";
import type { ExecutableNativeProperty } from "./manifest.ts";

export interface NativePropertyTestRegistrar {
  (name: string, options: { readonly retry: 0 }, execute: () => void | Promise<void>): void;
}

const vitestRegistrar: NativePropertyTestRegistrar = (name, options, execute) => test(name, options, execute);

export function registerNativeProperties(
  properties: readonly ExecutableNativeProperty[],
  register: NativePropertyTestRegistrar = vitestRegistrar,
): void {
  const ids = new Set<string>();
  for (const property of properties) {
    if (ids.has(property.id)) throw new Error(`Duplicate native Property id: ${property.id}`);
    ids.add(property.id);
  }
  for (const property of properties) register(property.testName, { retry: 0 }, property.execute);
}
