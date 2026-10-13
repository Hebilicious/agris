import { expect, it } from "vitest";

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateArtifacts } from "./generate.js";

const artifactRoot = resolve(fileURLToPath(new URL("../artifacts", import.meta.url)));
const temporaryArtifactRoot = resolve(fileURLToPath(new URL("../.artifacts/generated", import.meta.url)));
const artifactPaths = [
  "market-subgraph.graphql",
  "catalog-subgraph.graphql",
  "supergraph.graphql",
  "client-schema.graphql",
  "client-schema.introspection.json",
  "persisted/market-items-with-catalog.graphql",
  "persisted-operations.json",
  "gateway-schemas.ts",
] as const;

it("keeps generated schema artifacts deterministic", async () => {
  await mkdir(temporaryArtifactRoot, { recursive: true });
  const generatedRoot = await mkdtemp(resolve(temporaryArtifactRoot, "generated-"));
  try {
    await generateArtifacts(generatedRoot);
    for (const relativePath of artifactPaths) {
      const expected = await readFile(resolve(artifactRoot, relativePath), "utf8");
      const generated = await readFile(resolve(generatedRoot, relativePath), "utf8");
      expect(generated, relativePath).toBe(expected);
    }
    expect(await readdir(resolve(generatedRoot, "persisted"))).toEqual(["market-items-with-catalog.graphql"]);
  } finally {
    await rm(generatedRoot, { recursive: true, force: true });
  }
});
