import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSchema, parse, validate } from "graphql";
import {
  canonicalizeGraphqlDocument,
  validatePersistedOperations,
  type PersistedOperationDefinition,
} from "../../../packages/core/dist/protocol/index.js";
import { conflictingSubgraphDescriptions, undocumentedSchemaElements } from "./schema-documentation.js";

const toolRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactRoot = resolve(toolRoot, "artifacts");

async function main(): Promise<void> {
  const clientSdl = await readArtifact("client-schema.graphql");
  const introspection: unknown = JSON.parse(await readArtifact("client-schema.introspection.json"));
  const schema = buildSchema(clientSdl);
  if (!isRecord(introspection) || !("__schema" in introspection)) {
    throw new Error("Client introspection artifact has no __schema");
  }

  const persistedDocuments = new Map([
    ["MarketItemsWithCatalog", await readArtifact("persisted/market-items-with-catalog.graphql")],
  ]);
  const manifest: unknown = JSON.parse(await readArtifact("persisted-operations.json"));
  if (!isRecord(manifest) || !isRecord(manifest.operations)) throw new Error("Persisted manifest has no operations");
  const operations = decodePersistedOperations(manifest.operations);
  if (Object.keys(operations).length !== persistedDocuments.size) {
    throw new Error("Persisted manifest operation count is incorrect");
  }
  for (const [name, persistedDocument] of persistedDocuments) {
    const operation = Object.values(operations).find((candidate) => candidate.name === name);
    if (operation?.document !== canonicalizeGraphqlDocument(parse(persistedDocument))) {
      throw new Error(`Persisted manifest canonical document does not match ${name}`);
    }
    const validationErrors = validate(schema, parse(persistedDocument));
    if (validationErrors.length > 0) {
      throw new Error(
        `Persisted operation ${name} is not valid against the client schema: ${validationErrors.join("; ")}`,
      );
    }
  }
  await validatePersistedOperations(schema, operations);
  if (schema.getQueryType() === undefined) throw new Error("Client schema has no Query root");
  await checkDocumentation(schema);
}

/** The client schema documents every element GraphiQL's docs explorer shows, as the subgraphs wrote it. */
async function checkDocumentation(schema: ReturnType<typeof buildSchema>): Promise<void> {
  const problems = [
    ...undocumentedSchemaElements(schema).map((coordinate) => `${coordinate} has no description`),
    ...conflictingSubgraphDescriptions({
      market: await readArtifact("market-subgraph.graphql"),
      catalog: await readArtifact("catalog-subgraph.graphql"),
    }),
  ];
  if (problems.length > 0) {
    throw new Error(
      `The client schema's documentation is incomplete. Describe each element in its subgraph's Pothos builder, ` +
        `then run \`moon run schema:generate\`:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function decodePersistedOperations(
  value: Readonly<Record<string, unknown>>,
) {
  const operations: Record<string, PersistedOperationDefinition & { readonly name: string }> = {};
  for (const [id, definition] of Object.entries(value)) {
    if (!isRecord(definition) || typeof definition.document !== "string" || typeof definition.name !== "string") {
      throw new Error(`Persisted operation ${id} is invalid`);
    }
    operations[id] = { document: definition.document, name: definition.name };
  }
  return operations;
}

async function readArtifact(relativePath: string): Promise<string> {
  return readFile(resolve(artifactRoot, relativePath), "utf8");
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch(
  /* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
