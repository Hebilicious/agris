/**
 * Pretty-printed JSON as coloured tokens, for the live examples' result panel. It walks a value `JSON.parse` returned
 * rather than scanning text, so every token is well formed, and the tokens' text joined together is exactly
 * `JSON.stringify(value, null, 2)`.
 */

export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punctuation" | "space";

export interface JsonToken {
  readonly kind: JsonTokenKind;
  readonly text: string;
}

const INDENT = "  ";

export function jsonTokens(value: unknown): JsonToken[] {
  const tokens: JsonToken[] = [];
  const push = (kind: JsonTokenKind, text: string) => tokens.push({ kind, text });
  const newline = (depth: number) => push("space", `\n${INDENT.repeat(depth)}`);

  const walk = (node: unknown, depth: number): void => {
    if (node === null) push("null", "null");
    else if (typeof node === "boolean") push("boolean", String(node));
    else if (typeof node === "number") push("number", JSON.stringify(node));
    else if (typeof node === "string") push("string", JSON.stringify(node));
    else if (Array.isArray(node)) {
      if (node.length === 0) {
        push("punctuation", "[]");
        return;
      }
      push("punctuation", "[");
      node.forEach((item: unknown, index) => {
        if (index > 0) push("punctuation", ",");
        newline(depth + 1);
        walk(item, depth + 1);
      });
      newline(depth);
      push("punctuation", "]");
    } else if (typeof node === "object") {
      const entries = Object.entries(node);
      if (entries.length === 0) {
        push("punctuation", "{}");
        return;
      }
      push("punctuation", "{");
      entries.forEach(([key, item], index) => {
        if (index > 0) push("punctuation", ",");
        newline(depth + 1);
        push("key", JSON.stringify(key));
        push("punctuation", ":");
        push("space", " ");
        walk(item, depth + 1);
      });
      newline(depth);
      push("punctuation", "}");
    }
    // `JSON.parse` returns nothing else; a value it could not have produced prints as nothing, as `JSON.stringify`
    // drops it.
  };

  walk(value, 0);
  return tokens;
}

/** The tokens' text, which is `JSON.stringify(value, null, 2)`. */
export function jsonTextOf(tokens: readonly JsonToken[]): string {
  return tokens.map((token) => token.text).join("");
}
