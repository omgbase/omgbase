// Frontmatter entries (spec/mutate §11.3 "Frontmatter entries", 3.6). The
// effect planner's `set`/`unset frontmatter.<key>` edits ONE entry of a
// document's frontmatter and leaves every other byte alone. To do that the
// `frontmatter` block's raw (fences included) is cut into an ordered list of
// PARTS — the opening fence line, one part per top-level YAML entry (with the
// lines that continue it and the comment lines that lead it), the trailing
// comment/blank lines, the closing fence — by a LEXICAL, line-based rule, not
// a YAML parse: it is total (every frontmatter the store holds, valid YAML or
// not, splits), byte-exact (the parts concatenate back to the raw, always) and
// identical in both engines; what a line *means* is the properties layer's
// business. Where the rule and YAML disagree (a pathological document) the
// edit may touch a wider or narrower run of lines than a YAML parser would,
// but never loses a byte of the other entries.
//
// Storage is untouched: a revision's frontmatter stays one blob (spec/store
// 15.0). The parts are the planner's view of the bytes, computed from
// `frontmatter_raw` when a frontmatter key is set or unset.

/** One part: `key` is the entry's key (`null` for a fence, the lines before the first entry, the trailing lines) and `bytes` its text, line endings included. */
export interface FrontmatterPart {
  key: string | null;
  bytes: string;
}

/** Split text into lines, each keeping its own line ending (`\n` or `\r\n`); the last line has none. `""` → `[""]`. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** A line without its line ending. */
function content(line: string): string {
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
}

/** The line ending of `line` (`"\r\n"`, `"\n"`, or `""` when it has none). */
export function lineEndingOf(line: string): string {
  return line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
}

/** A blank line (empty, or spaces and tabs only). */
export function isBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(content(line));
}

/** A comment line — `#` in column 0. (An indented `#` is content: a block scalar's line, for one.) */
export function isCommentLine(line: string): boolean {
  return content(line).startsWith("#");
}

/** A LEAD line: blank or comment — the lines that travel with the entry that follows them. */
function isLeadLine(line: string): boolean {
  return isBlankLine(line) || isCommentLine(line);
}

// Characters that cannot begin a plain YAML key (flow indicators, anchors,
// aliases, tags, block scalar indicators, directives, reserved).
const NOT_A_PLAIN_KEY_START = new Set(["[", "]", "{", "}", ",", "&", "*", "!", "|", ">", "%", "@", "`"]);

/**
 * The entry boundary: the key of a column-0 line that opens a top-level
 * mapping entry, or `null` when the line does not. A line opens an entry when
 * it is not blank, not a comment, not a sequence item (`-` followed by a
 * space, a tab or the end of the line), not an explicit key or value
 * indicator (`?` / `:` the same way), not a document marker (`---` / `...`
 * followed by whitespace or the end of the line), and reads as `<key>:`
 * followed by a space, a tab or the end of the line — the key either
 * - quoted: a `"…"` string (`\` escapes the next character) or a `'…'` string
 *   (`''` is a literal quote), closed on the same line, then optional spaces/
 *   tabs, then the colon; the key is the content with `\\` → `\`, `\"` → `"`
 *   (double) or `''` → `'` (single) undone and every other escape kept as
 *   written; or
 * - plain: the text before the FIRST `:` that is followed by a space, a tab or
 *   the end of the line, trailing spaces/tabs trimmed — non-empty, not
 *   starting with a flow indicator, an anchor/alias/tag/block-scalar/
 *   directive/reserved character (`[ ] { } , & * ! | > % @ \``) and not
 *   containing ` #` or `\t#` (a comment would start there).
 * Anything else — an indented line, a flow collection's continuation, a block
 * scalar's content — is a continuation of the entry above it.
 */
export function entryKeyOf(line: string): string | null {
  const c = content(line);
  if (c.length === 0) return null;
  const c0 = c[0]!;
  if (c0 === " " || c0 === "\t" || c0 === "#") return null;
  if (c0 === '"' || c0 === "'") return quotedKey(c, c0);
  const c1 = c.length > 1 ? c[1]! : "";
  const wsOrEnd = (ch: string): boolean => ch === "" || ch === " " || ch === "\t";
  if ((c0 === "-" || c0 === "?" || c0 === ":") && wsOrEnd(c1)) return null;
  if ((c.startsWith("---") || c.startsWith("...")) && wsOrEnd(c.length > 3 ? c[3]! : "")) return null;
  if (NOT_A_PLAIN_KEY_START.has(c0)) return null;
  const m = /^(.*?):(?:[ \t]|$)/.exec(c);
  if (!m) return null;
  const key = m[1]!.replace(/[ \t]+$/, "");
  if (key.length === 0 || / #|\t#/.test(key)) return null;
  return key;
}

function quotedKey(c: string, quote: string): string | null {
  let i = 1;
  let close = -1;
  if (quote === '"') {
    while (i < c.length) {
      const ch = c[i]!;
      if (ch === "\\") i += 2;
      else if (ch === '"') {
        close = i;
        break;
      } else i++;
    }
  } else {
    while (i < c.length) {
      if (c[i] === "'") {
        if (c[i + 1] === "'") i += 2;
        else {
          close = i;
          break;
        }
      } else i++;
    }
  }
  if (close < 0) return null;
  if (!/^[ \t]*:(?:[ \t]|$)/.test(c.slice(close + 1))) return null;
  const inner = c.slice(1, close);
  return quote === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'");
}

/**
 * The frontmatter block's raw (fences included, no trailing line ending) → its
 * parts, in order. The parts always concatenate back to `raw` byte for byte:
 * every line of the raw lands in exactly one part.
 *
 * - part 0 is the opening fence line with its line ending, key `null`;
 * - the last part is the closing fence line (no line ending), key `null`;
 * - between them, the body lines: every line before the first entry line is
 *   one part with key `null` (comments, blank lines, or — when no line opens
 *   an entry: a bare scalar, a sequence — the whole body); then one part per
 *   entry, from the first of the lead lines (blank / column-0 comment)
 *   immediately preceding its key line (never reaching back past the
 *   previous entry's key line) through the line before the next entry's
 *   lead, the last entry ending before the trailing lead run; the trailing
 *   lead run (blank / comment lines after the last entry's content) is one
 *   part with key `null`.
 *
 * A raw with fewer than two lines (not a frontmatter block) is one part.
 */
export function splitFrontmatterRaw(raw: string): FrontmatterPart[] {
  const lines = splitLines(raw);
  if (lines.length < 2) return [{ key: null, bytes: raw }];
  const open = lines[0]!;
  const close = lines[lines.length - 1]!;
  const body = lines.slice(1, -1);
  const parts: FrontmatterPart[] = [{ key: null, bytes: open }];

  const entryAt: (string | null)[] = body.map(entryKeyOf);
  const entryIdx: number[] = [];
  entryAt.forEach((k, i) => {
    if (k !== null) entryIdx.push(i);
  });

  if (entryIdx.length === 0) {
    if (body.length > 0) parts.push({ key: null, bytes: body.join("") });
    parts.push({ key: null, bytes: close });
    return parts;
  }

  // Where each entry's part starts: its lead run, bounded by the previous
  // entry's key line; the first entry starts at its key line (the lines
  // before it are the leading null part).
  const starts = entryIdx.map((i, n) => {
    if (n === 0) return i;
    const floor = entryIdx[n - 1]! + 1;
    let j = i;
    while (j - 1 >= floor && isLeadLine(body[j - 1]!)) j--;
    return j;
  });
  // The trailing null part: the lead run after the last entry's key line.
  let tail = body.length;
  const lastKey = entryIdx[entryIdx.length - 1]!;
  while (tail - 1 > lastKey && isLeadLine(body[tail - 1]!)) tail--;

  if (starts[0]! > 0) parts.push({ key: null, bytes: body.slice(0, starts[0]!).join("") });
  entryIdx.forEach((i, n) => {
    const end = n + 1 < starts.length ? starts[n + 1]! : tail;
    parts.push({ key: entryAt[i]!, bytes: body.slice(starts[n]!, end).join("") });
  });
  if (tail < body.length) parts.push({ key: null, bytes: body.slice(tail).join("") });
  parts.push({ key: null, bytes: close });
  return parts;
}

/** The inverse of {@link splitFrontmatterRaw}: the parts' bytes concatenated. */
export function joinFrontmatterParts(parts: readonly FrontmatterPart[]): string {
  return parts.map((p) => p.bytes).join("");
}

/**
 * The frontmatter block's raw and its trailing trivia, out of a document's
 * `frontmatter_raw` (`raw + docs.frontmatter_trivia`, spec/mutate §2): the
 * closing fence is the first line after the opening one that is `---`
 * followed only by spaces/tabs (the format layer's rule); the raw ends with
 * that line's content, the trivia is everything after. `null` when no closing
 * fence is found (not a frontmatter the format layer would have produced).
 */
export function splitFrontmatterTrivia(frontmatterRaw: string): { raw: string; trivia: string } | null {
  const lines = splitLines(frontmatterRaw);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^---[ \t]*$/.test(content(line))) {
      const upto = lines.slice(0, i).join("") + content(line);
      return { raw: upto, trivia: frontmatterRaw.slice(upto.length) };
    }
  }
  return null;
}

/** The lines of a part that LEAD its key line (blank / column-0 comment lines), as one string; `""` for a part without a key. */
export function leadOf(part: FrontmatterPart): string {
  if (part.key === null) return "";
  const lines = splitLines(part.bytes);
  let n = 0;
  while (n < lines.length - 1 && isLeadLine(lines[n]!)) n++;
  return lines.slice(0, n).join("");
}
