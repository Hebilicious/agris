import assert from "node:assert/strict";

import {
  buildASTSchema,
  Kind,
  parse,
  print,
  visit,
  type DocumentNode,
  type GraphQLSchema,
  type StringValueNode,
} from "graphql";

import { clientSchemaSdl } from "../../tools/schema/artifacts/gateway-schemas.ts";
import {
  conflictingSubgraphDescriptions,
  undocumentedSchemaElements,
} from "../../tools/schema/src/schema-documentation.ts";
import { noStepArguments, step, type ExecutableFeatureManifest, type StepDefinition } from "../support/manifest.ts";

interface SchemaDocumentationWorld {
  schema?: GraphQLSchema;
  subgraphSdls?: Readonly<Record<string, string>>;
  problems?: readonly string[];
}

/** One element of each kind GraphiQL's docs explorer shows, by its schema coordinate. */
const UNDOCUMENTED = [
  "MarketOrder",
  "Market.region",
  "Market.items(ids:)",
  "MarketRegion.EU",
  "MarketCategoryInput.sub",
];

/** Federation helpers a supergraph carries; they are composition's, not Agris's, and carry no description. */
const FEDERATION_HELPERS = `
  scalar join__FieldSet
  type _Service { sdl: String }
`;

/**
 * The committed client schema with the description of each named element replaced: `null` removes it. Every other
 * element keeps the text the subgraphs wrote, so a check that names only these elements found every gap there is.
 */
function clientSchemaWith(descriptions: Readonly<Record<string, string | null>>, extraSdl = ""): GraphQLSchema {
  const document = parse(`${clientSchemaSdl}\n${extraSdl}`, { noLocation: true });
  const describe = (coordinate: string, current: StringValueNode | undefined): StringValueNode | undefined => {
    if (!(coordinate in descriptions)) return current;
    const replacement = descriptions[coordinate];
    return replacement === null || replacement === undefined ? undefined : { kind: Kind.STRING, value: replacement };
  };
  const edited: DocumentNode = visit(document, {
    ObjectTypeDefinition: (node) => ({
      ...node,
      description: describe(node.name.value, node.description),
      fields: node.fields?.map((field) => ({
        ...field,
        description: describe(`${node.name.value}.${field.name.value}`, field.description),
        arguments: field.arguments?.map((argument) => ({
          ...argument,
          description: describe(
            `${node.name.value}.${field.name.value}(${argument.name.value}:)`,
            argument.description,
          ),
        })),
      })),
    }),
    InputObjectTypeDefinition: (node) => ({
      ...node,
      fields: node.fields?.map((field) => ({
        ...field,
        description: describe(`${node.name.value}.${field.name.value}`, field.description),
      })),
    }),
    EnumTypeDefinition: (node) => ({
      ...node,
      values: node.values?.map((value) => ({
        ...value,
        description: describe(`${node.name.value}.${value.name.value}`, value.description),
      })),
    }),
  });
  return buildASTSchema(edited);
}

const steps: readonly StepDefinition<SchemaDocumentationWorld>[] = [
  step(
    "a schema whose type, field, argument, enum value and input field each include one without a description",
    noStepArguments,
    (world) => {
      world.schema = clientSchemaWith(
        Object.fromEntries(UNDOCUMENTED.map((coordinate) => [coordinate, null])),
        FEDERATION_HELPERS,
      );
    },
  ),
  step("its documentation is checked", noStepArguments, (world) => {
    assert.ok(world.schema);
    world.problems = undocumentedSchemaElements(world.schema);
  }),
  step("the check names exactly those five elements", noStepArguments, (world) => {
    assert.deepEqual([...(world.problems ?? [])].sort(), [...UNDOCUMENTED].sort());
  }),
  step(
    "it does not ask for descriptions of the built-in scalars or the Federation helpers",
    noStepArguments,
    (world) => {
      for (const internal of ["Int", "String", "Boolean", "ID", "join__FieldSet", "_Service", "_Service.sdl"]) {
        assert.ok(!(world.problems ?? []).includes(internal), internal);
      }
    },
  ),
  step(
    "a market and a catalog subgraph that describe ItemLocale differently and Query the same way",
    noStepArguments,
    (world) => {
      const subgraph = (localeDescription: string) =>
        print(
          parse(`
            """The read-only root."""
            type Query { """A field.""" ping: ItemLocale }
            """${localeDescription}"""
            enum ItemLocale { """English.""" EN }
          `),
        );
      world.subgraphSdls = {
        market: subgraph("The language of item names."),
        catalog: subgraph("The locale item names are given in."),
      };
    },
  ),
  step("their descriptions are compared", noStepArguments, (world) => {
    assert.ok(world.subgraphSdls);
    world.problems = conflictingSubgraphDescriptions(world.subgraphSdls);
  }),
  step("the check names ItemLocale and nothing else", noStepArguments, (world) => {
    assert.deepEqual(world.problems, ["ItemLocale has different descriptions in market and catalog"]);
  }),
];

export const schemaDocumentationFeature: ExecutableFeatureManifest<SchemaDocumentationWorld> = {
  id: "schema-documentation",
  uri: "tests/features/schema-documentation.feature",
  createWorld: () => ({}),
  steps,
};
