/**
 * JSON for a `<script type="application/json">` block. `JSON.stringify` alone leaves `</script>` and `<!--` intact, so
 * a string holding either would end the block early; escaping `<`, `>` and `&` as `\u` sequences keeps the text inert
 * in HTML and parses back to the same value. The line and paragraph separators (U+2028, U+2029) are escaped too, for
 * readers that treat the block as script source.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const UNSAFE = new RegExp(`[<>&${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "g");

const escapeOf = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(UNSAFE, escapeOf);
}
