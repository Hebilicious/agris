import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { generateArtifacts } from "./generate.js";

/**
 * The Moon `generate` target runs this file, because the subgraph builders
 * resolve the Federation plugins through this tool's Vitest aliases. The
 * assertion reports the generation contract: every declared output exists and
 * carries content, so a run that writes nothing cannot pass as a generation.
 * `src/check-generated.test.ts` owns the byte-for-byte comparison against the
 * committed artifacts.
 */
const declaredOutputs = [
  "market-subgraph.graphql",
  "catalog-subgraph.graphql",
  "supergraph.graphql",
  "client-schema.graphql",
  "client-schema.introspection.json",
  "persisted/market-items-with-catalog.graphql",
  "persisted-operations.json",
] as const;

it("writes every declared graph artifact", async () => {
  await generateArtifacts();
  for (const relativePath of declaredOutputs) {
    const artifact = resolve(import.meta.dirname, "../artifacts", relativePath);
    const information = await stat(artifact);
    expect(information.isFile(), relativePath).toBe(true);
    expect(information.size, relativePath).toBeGreaterThan(0);
    expect((await readFile(artifact, "utf8")).trim().length, relativePath).toBeGreaterThan(0);
  }
});
