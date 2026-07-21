/**
 * Escaping for untrusted text placed into notification message formats.
 *
 * Exception summaries, customer identifiers and organization names all
 * originate outside PayRecon's control. Escaping happens here, immediately
 * before interpolation into a specific target format, so that a hostile value
 * cannot inject markup into a message an operator will read and trust.
 *
 * These helpers are the injection defence for this package and are unit-tested
 * directly rather than only through the renderers.
 */

/** Single character, so a truncated string never grows past `max`. */
const ELLIPSIS = "…";

/**
 * Escape text for Slack.
 *
 * Slack specifies exactly three characters, and the order is load-bearing: `&`
 * MUST be replaced first, otherwise the ampersands introduced by the `<` and
 * `>` replacements would themselves be escaped, producing `&amp;lt;`.
 *
 * Nothing else is escaped. Slack renders `&quot;` literally, so escaping quotes
 * here would corrupt ordinary prose.
 */
export function escapeSlackText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape text for interpolation into HTML element content or a double- or
 * single-quoted attribute value.
 *
 * `&` first, for the same reason as above. `"` and `'` are included because the
 * HTML email interpolates values into attributes as well as into text nodes.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Shorten text to at most `max` characters, appending an ellipsis.
 *
 * Always call this BEFORE escaping: escaping expands one character into an
 * entity, so truncating afterwards could cut `&amp;` in half and emit a broken
 * entity that some renderers try to complete.
 *
 * Counts code points rather than UTF-16 units so a cut never splits an astral
 * character into a lone surrogate.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  const characters = [...text];
  if (characters.length <= max) return text;
  return `${characters.slice(0, max - 1).join("")}${ELLIPSIS}`;
}

/**
 * Collapse a value to a single line and remove control characters.
 *
 * Required before a value reaches an email `Subject:` header, where a bare CR
 * or LF would let untrusted text inject additional headers. Also applied to
 * body text so terminal escape sequences cannot reach a console transport.
 */
export function toSingleLine(input: string): string {
  return [...input]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      // C0 controls, DEL, and the C1 range. Newlines and tabs become spaces so
      // the surrounding words stay separated.
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return " ";
      return character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
