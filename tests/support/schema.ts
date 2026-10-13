import { Schema, type SchemaAST } from "effect";

/** Decoding refuses any key a schema does not name, except inside an `openStruct`. */
export const STRICT: SchemaAST.ParseOptions = { onExcessProperty: "error" };

/** A struct that admits keys it does not name, even when the value around it is decoded with `STRICT`. */
export const openStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);
