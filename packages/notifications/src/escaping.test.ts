import { describe, expect, it } from "vitest";
import { escapeHtml, escapeSlackText, toSingleLine, truncate } from "./escaping";

describe("escapeSlackText", () => {
  it("escapes exactly the three characters Slack specifies", () => {
    expect(escapeSlackText("&")).toBe("&amp;");
    expect(escapeSlackText("<")).toBe("&lt;");
    expect(escapeSlackText(">")).toBe("&gt;");
  });

  it("replaces & first, so the other replacements are not double-escaped", () => {
    // If `<` were replaced before `&`, this would come back as "&amp;lt;".
    expect(escapeSlackText("<")).toBe("&lt;");
    expect(escapeSlackText("&<>")).toBe("&amp;&lt;&gt;");
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapes an existing entity's ampersand rather than leaving it live", () => {
    expect(escapeSlackText("&amp;")).toBe("&amp;amp;");
  });

  it("leaves every other character alone", () => {
    expect(escapeSlackText(`"'|*_\`~:@#`)).toBe(`"'|*_\`~:@#`);
    expect(escapeSlackText("")).toBe("");
  });

  it("neutralises Slack link markup in untrusted text", () => {
    expect(escapeSlackText("<https://evil.test|click me>")).toBe(
      "&lt;https://evil.test|click me&gt;",
    );
  });
});

describe("escapeHtml", () => {
  it("escapes ampersand, angle brackets and both quote characters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("replaces & first", () => {
    expect(escapeHtml("&<")).toBe("&amp;&lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("neutralises a script tag", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralises an attribute break-out", () => {
    const escaped = escapeHtml(`" onmouseover="steal()`);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe("&quot; onmouseover=&quot;steal()");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("appends an ellipsis and never exceeds max", () => {
    expect(truncate("abcdefgh", 4)).toBe("abc…");
    expect(truncate("abcdefgh", 4)).toHaveLength(4);
  });

  it("returns an empty string for a non-positive max", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -1)).toBe("");
  });

  it("counts code points, so an astral character is never split", () => {
    // Three code points, six UTF-16 units.
    const emoji = "\u{1F600}\u{1F600}\u{1F600}";
    expect(truncate(emoji, 3)).toBe(emoji);
    expect([...truncate(emoji, 2)]).toEqual(["\u{1F600}", "…"]);
  });
});

describe("toSingleLine", () => {
  it("removes CR and LF, which would otherwise inject email headers", () => {
    const injected = toSingleLine("Subject text\r\nBcc: attacker@evil.test");
    expect(injected).not.toContain("\r");
    expect(injected).not.toContain("\n");
    expect(injected).toBe("Subject text Bcc: attacker@evil.test");
  });

  it("strips control, DEL and C1 characters", () => {
    // Built from char codes rather than literal bytes, because raw control
    // characters in source are easily mangled by editors and formatters.
    const nul = String.fromCharCode(0x00);
    const escape = String.fromCharCode(0x1b);
    const del = String.fromCharCode(0x7f);
    const c1 = String.fromCharCode(0x85);

    // A terminal escape sequence must not survive into a console transport.
    expect(toSingleLine(`a${nul}b${escape}[31mc${del}d`)).toBe("a b [31mc d");
    expect(toSingleLine(`x${c1}y`)).toBe("x y");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(toSingleLine("  a \t\t b  ")).toBe("a b");
  });
});
