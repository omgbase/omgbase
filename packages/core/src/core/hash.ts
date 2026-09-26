import { createHash } from "node:crypto";

// Hashing & canonical serialization — 02 §5.
// Content hashes are sha256 of UTF-8 bytes, stored as 32-byte buffers and
// displayed truncated to 16 hex chars.

export function sha256(input: string | Uint8Array): Buffer {
  const h = createHash("sha256");
  h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return h.digest();
}

export function hashHex(input: string | Uint8Array): string {
  return sha256(input).toString("hex");
}

/** Display form: first 16 hex chars (02 §1). */
export function shortHash(hash: Buffer | string): string {
  const hex = typeof hash === "string" ? hash : hash.toString("hex");
  return hex.slice(0, 16);
}

/** raw_hash — sha256 of the exact raw source bytes (02 §1). */
export function rawHash(raw: string): Buffer {
  return sha256(raw);
}

// Normalized text (02 §5.2): per-line trim + internal whitespace-run collapse,
// drop blank lines, NFC. Inline Markdown characters are preserved as content.
export function normalizeText(raw: string): string {
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter((line) => line.length > 0)
    .join(" ")
    .normalize("NFC");
}

// Visible text (spec/format §4.1, block model 0.2). `text` is what a reader
// sees: block-level Markdown syntax removed, inline syntax kept, whitespace
// normalized. Two shapes of block:
//
//   leaf       paragraph, heading, code_fence, html_block, thematic_break,
//              frontmatter, opaque, table_row, and a childless list_item/task —
//              text is computed from `raw` by normalizeVisibleText().
//   container  list, blockquote, table, and a list_item/task WITH children —
//              text is the children's texts joined by one space, empties skipped
//              (their own markers never appear because no child's raw has them).
//
// Both need tree context: how many blockquote ancestors a block has (its `raw`
// keeps the `> ` prefixes of continuation lines — §3 "nested raw is a source
// slice") and whether an item folded its lone paragraph. visibleText() is the
// one entry point for anything that has a tree; normalizeVisibleText() is the
// leaf rule for callers that only have (raw, type) at a known depth.

/** The minimal tree shape visibleText() needs; RawBlock, TreeInputBlock and FlatSource all satisfy it. */
export interface VisibleTextBlock {
  type: string;
  raw: string;
  children: readonly VisibleTextBlock[];
}

/** Container blocks compose their text from children (spec/format §4.1). */
export function isTextContainer(type: string, hasChildren: boolean): boolean {
  return type === "list" || type === "blockquote" || type === "table" || ((type === "list_item" || type === "task") && hasChildren);
}

/** Blockquote depth of a block's children given the block's own depth. */
export function childQuoteDepth(type: string, quoteDepth: number): number {
  return type === "blockquote" ? quoteDepth + 1 : quoteDepth;
}

/** Container rule: children's texts in order, joined by one space, empties skipped. */
export function joinVisibleTexts(texts: readonly string[]): string {
  return texts.filter((t) => t.length > 0).join(" ");
}

/**
 * `text` for a block in its tree. `quoteDepth` is the number of blockquote
 * ancestors of `block` itself (0 at the top level).
 */
export function visibleText(block: VisibleTextBlock, quoteDepth = 0): string {
  if (isTextContainer(block.type, block.children.length > 0)) {
    const inner = childQuoteDepth(block.type, quoteDepth);
    return joinVisibleTexts(block.children.map((c) => visibleText(c, inner)));
  }
  return normalizeVisibleText(block.raw, block.type, quoteDepth);
}

const LINE_ENDING = /\r\n|\r|\n/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE_MARKER = /^[ \t]*> ?/;

// A `|` is escaped iff preceded by an odd number of backslashes (GFM: `\|` is
// content, `\\|` is an escaped backslash followed by a delimiter).
function isEscapedAt(line: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

// table_row: one leading `|`, one trailing unescaped `|` (each with surrounding
// spaces/tabs), then every remaining unescaped `|` becomes a space.
function stripTableRow(line: string): string {
  let s = line.replace(/^[ \t]*\|/, "");
  const trimmedEnd = s.replace(/[ \t]+$/, "");
  if (trimmedEnd.endsWith("|") && !isEscapedAt(trimmedEnd, trimmedEnd.length - 1)) s = trimmedEnd.slice(0, -1);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += s[i] === "|" && !isEscapedAt(s, i) ? " " : s[i];
  }
  return out;
}

/**
 * Leaf rule (spec/format §4.1 steps 1–7): strip up to `quoteDepth` blockquote
 * markers from every line after the first, then the kind's own syntax, then
 * normalize whitespace (trim each line with the JS trim set, collapse `[ \t]+`,
 * drop empty lines, join with one space, NFC). Inline syntax is content.
 * Call this only for leaves — containers go through visibleText().
 */
export function normalizeVisibleText(raw: string, type: string, quoteDepth = 0): string {
  let lines = raw.split(LINE_ENDING);

  // 1. Blockquote markers on continuation lines (the first line starts at content).
  if (quoteDepth > 0) {
    for (let i = 1; i < lines.length; i++) {
      let line = lines[i]!;
      for (let q = 0; q < quoteDepth; q++) {
        const m = QUOTE_MARKER.exec(line);
        if (!m) break;
        line = line.slice(m[0].length);
      }
      lines[i] = line;
    }
  }

  // 2. Kind syntax.
  switch (type) {
    case "heading": {
      if (lines.length > 1) {
        lines.pop(); // setext: content lines + the underline
      } else {
        // ATX: the opening run (which may be the whole line), then a closing
        // run of `#` that is the entire remainder or follows a space/tab.
        lines[0] = (lines[0] ?? "").replace(/^ {0,3}#{1,6}[ \t]*/, "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "");
      }
      break;
    }
    case "frontmatter":
      lines = lines.slice(1, -1);
      break;
    case "code_fence": {
      const open = FENCE_OPEN.exec(lines[0] ?? "");
      if (open) {
        lines = lines.slice(1);
        const fence = open[1]!;
        const closer = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`);
        if (lines.length > 0 && closer.test(lines[lines.length - 1]!)) lines.pop();
      }
      break;
    }
    case "list_item":
    case "task": {
      lines[0] = (lines[0] ?? "").replace(/^[ \t]*([-*+]|[0-9]+[.)])[ \t]+/, "").replace(/^\[[ xX]\][ \t]+/, "");
      break;
    }
    case "table_row":
      lines = lines.map(stripTableRow);
      break;
    case "thematic_break":
      lines = [];
      break;
    default:
      break; // paragraph, html_block, opaque: nothing
  }

  // 3–7.
  return normalizeText(lines.join("\n"));
}

/** norm_hash — sha256 of the normalized text (02 §1, §5.2). */
export function normHash(normalizedText: string): Buffer {
  return sha256(normalizedText);
}

// Canonical attrs JSON: object with lexicographically sorted keys, no
// whitespace (02 §5.1). Values are emitted with JSON.stringify (stable for
// scalars/arrays/nested objects we use).
export function canonicalAttrs(attrs: Record<string, unknown>): string {
  const keys = Object.keys(attrs).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(attrs[k])}`);
  return `{${parts.join(",")}}`;
}

function canonicalValue(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalValue).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(obj[k])}`).join(",")}}`;
}

// Tree-node entry (02 §5.1): positional array
//   [block_id, raw_hash_hex, child_tree_hash_hex|null, type, attrs_canonical_json, trivia_hash_hex|null]
export interface TreeEntry {
  blockId: string;
  rawHashHex: string;
  childTreeHashHex: string | null;
  type: string;
  attrs: Record<string, unknown>;
  triviaHashHex: string | null;
}

/** Canonical serialization of a tree node's entries (UTF-8, no whitespace). */
export function serializeTreeEntries(entries: TreeEntry[]): string {
  const rows = entries.map((e) =>
    [
      JSON.stringify(e.blockId),
      JSON.stringify(e.rawHashHex),
      e.childTreeHashHex === null ? "null" : JSON.stringify(e.childTreeHashHex),
      JSON.stringify(e.type),
      canonicalAttrs(e.attrs),
      e.triviaHashHex === null ? "null" : JSON.stringify(e.triviaHashHex),
    ].join(","),
  );
  return `[${rows.map((r) => `[${r}]`).join(",")}]`;
}

/** Tree-node hash: sha256 over the canonical entries serialization (02 §5.1). */
export function treeHash(entries: TreeEntry[]): Buffer {
  return sha256(serializeTreeEntries(entries));
}
