import {
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isSpecifiedDirective,
  isSpecifiedScalarType,
  parse,
  type DocumentNode,
  type GraphQLArgument,
  type GraphQLSchema,
} from "graphql";

/**
 * The rules the public schema's documentation follows, so GraphiQL's docs explorer explains every part of it. Each
 * function returns one line per problem, naming the schema coordinate; an empty list means the rule holds.
 */

/** Built-in GraphQL types and directives, and the Federation helpers composition adds, are not Agris's to document. */
function isInternalName(name: string): boolean {
  return name.startsWith("_") || name.startsWith("join__") || name.startsWith("link__");
}

/**
 * The description of every type, field, argument, enum value, input field and directive the schema defines, except
 * the built-in and Federation ones, keyed by schema coordinate (`Type`, `Type.field`, `Type.field(argument:)`,
 * `Enum.VALUE`, `@directive`). An element without a description maps to null.
 */
export function schemaElementDescriptions(schema: GraphQLSchema): ReadonlyMap<string, string | null> {
  const descriptions = new Map<string, string | null>();
  const record = (coordinate: string, description: string | null | undefined) => {
    descriptions.set(coordinate, description ?? null);
  };
  const recordArguments = (owner: string, arguments_: readonly GraphQLArgument[]) => {
    for (const argument of arguments_) record(`${owner}(${argument.name}:)`, argument.description);
  };

  for (const type of Object.values(schema.getTypeMap())) {
    if (isInternalName(type.name) || isSpecifiedScalarType(type)) continue;
    record(type.name, type.description);
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        if (isInternalName(field.name)) continue;
        record(`${type.name}.${field.name}`, field.description);
        recordArguments(`${type.name}.${field.name}`, field.args);
      }
    } else if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) record(`${type.name}.${field.name}`, field.description);
    } else if (isEnumType(type)) {
      for (const value of type.getValues()) record(`${type.name}.${value.name}`, value.description);
    }
  }
  for (const directive of schema.getDirectives()) {
    if (isSpecifiedDirective(directive) || isInternalName(directive.name)) continue;
    record(`@${directive.name}`, directive.description);
    recordArguments(`@${directive.name}`, directive.args);
  }
  return descriptions;
}

/** The coordinates in `schemaElementDescriptions` whose description is missing or only whitespace. */
export function undocumentedSchemaElements(schema: GraphQLSchema): readonly string[] {
  return [...schemaElementDescriptions(schema)]
    .filter(([, description]) => description === null || description.trim() === "")
    .map(([coordinate]) => coordinate);
}

/**
 * Elements that two subgraphs both define with different descriptions. Composition keeps only one of them, so the
 * other would silently disappear from the public schema.
 */
export function conflictingSubgraphDescriptions(subgraphSdls: Readonly<Record<string, string>>): readonly string[] {
  const descriptions = new Map<string, Map<string, string>>();
  const record = (coordinate: string, subgraph: string, description: string | undefined) => {
    if (description === undefined || description.trim() === "") return;
    const bySubgraph = descriptions.get(coordinate) ?? new Map<string, string>();
    bySubgraph.set(subgraph, description);
    descriptions.set(coordinate, bySubgraph);
  };
  for (const [subgraph, sdl] of Object.entries(subgraphSdls)) {
    for (const definition of parse(sdl, { noLocation: true }).definitions) {
      recordDefinition(definition, (coordinate, description) => record(coordinate, subgraph, description));
    }
  }
  const conflicts: string[] = [];
  for (const [coordinate, bySubgraph] of descriptions) {
    if (new Set(bySubgraph.values()).size > 1) {
      conflicts.push(`${coordinate} has different descriptions in ${[...bySubgraph.keys()].join(" and ")}`);
    }
  }
  return conflicts;
}

function recordDefinition(
  definition: DocumentNode["definitions"][number],
  record: (coordinate: string, description: string | undefined) => void,
): void {
  if (!("name" in definition) || definition.name === undefined) return;
  const typeName = definition.name.value;
  if (isInternalName(typeName)) return;
  if ("description" in definition) record(typeName, definition.description?.value);
  if (definition.kind === "EnumTypeDefinition" || definition.kind === "EnumTypeExtension") {
    for (const value of definition.values ?? []) record(`${typeName}.${value.name.value}`, value.description?.value);
  }
  if ("fields" in definition) {
    for (const field of definition.fields ?? []) {
      record(`${typeName}.${field.name.value}`, field.description?.value);
      if ("arguments" in field) {
        for (const argument of field.arguments ?? []) {
          record(`${typeName}.${field.name.value}(${argument.name.value}:)`, argument.description?.value);
        }
      }
    }
  }
}
