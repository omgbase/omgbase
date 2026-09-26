// Block-tree ⇄ fixture bridge for spec/format (README §5). Two pure pieces:
//
//   toFixtureExpect(tree)   the reference's BlockTree → the fixture `expect`
//                           shape (byte spans, raw_hash, the seven block fields)
//   validateFixtureFile()   the shape check a runner applies before trusting a
//                           cases/*.json file
//
// Nothing here parses Markdown; the converter only re-expresses what
// parseTree produced so the fixture can be compared across implementations.
import type { BlockTree, RawBlock } from "../../src/core/parse/types.js";
import { hashHex } from "../../src/core/hash.js";

// ---- fixture shape -----------------------------------------------------------

/** The seven fields every block carries, nested or not, in the order fixtures emit them. */
export const FIXTURE_BLOCK_KEYS = ["type", "span", "text", "attrs", "trivia", "raw_hash", "children"] as const;

/** The keys a case may carry; `notes` is optional prose, everything else is required. */
export const FIXTURE_CASE_KEYS = ["name", "notes", "source", "expect"] as const;

export type FixtureAttr = boolean | number | string;

export interface FixtureBlock {
  type: string;
  /** [start, end) byte offsets into the UTF-8 encoding of the case source. */
  span: [number, number];
  text: string;
  attrs: Record<string, FixtureAttr>;
  /** Inter-block bytes after this block; "" for nested blocks. */
  trivia: string;
  /** sha256 of the UTF-8 bytes of `raw`, 64 lowercase hex characters. */
  raw_hash: string;
  children: FixtureBlock[];
}

export interface FixtureExpect {
  leading_trivia: string;
  blocks: FixtureBlock[];
}

export interface FixtureCase {
  name: string;
  notes?: string;
  source: string;
  expect: FixtureExpect;
}

export interface FixtureFile {
  suite: string;
  format: "markdown";
  cases: FixtureCase[];
}

// ---- UTF-16 index → UTF-8 byte offset ----------------------------------------

/**
 * Byte offset of every code-unit index of `s` (length + 1 entries, so the
 * end-of-string index resolves too). One pass over the string; a surrogate
 * pair contributes 4 bytes at the index after the pair, and the index between
 * its two halves maps to the pair's start (no span ever lands there). A lone
 * surrogate counts 3 bytes, matching what Buffer.from(s, "utf8") emits (U+FFFD).
 */
export function byteOffsetTable(s: string): Uint32Array {
  const table = new Uint32Array(s.length + 1);
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    table[i] = bytes;
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
      i += 1;
    } else if (c < 0x800) {
      bytes += 2;
      i += 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        table[i + 1] = bytes;
        bytes += 4;
        i += 2;
      } else {
        bytes += 3; // lone high surrogate → U+FFFD
        i += 1;
      }
    } else {
      bytes += 3; // BMP ≥ U+0800, or a lone surrogate → U+FFFD
      i += 1;
    }
  }
  table[s.length] = bytes;
  return table;
}

// ---- BlockTree → expect --------------------------------------------------------

function toFixtureBlock(block: RawBlock, table: Uint32Array, nested: boolean): FixtureBlock {
  const start = table[block.span.start];
  const end = table[block.span.end];
  if (start === undefined || end === undefined) {
    throw new Error(`span [${block.span.start}, ${block.span.end}) is outside the source`);
  }
  return {
    type: block.type,
    span: [start, end],
    text: block.text,
    attrs: fixtureAttrs(block.attrs),
    trivia: nested ? "" : block.trivia,
    raw_hash: hashHex(block.raw),
    children: block.children.map((c) => toFixtureBlock(c, table, true)),
  };
}

/** Attribute values are booleans, integers or strings (README §3); anything else is a reference bug. */
function fixtureAttrs(attrs: Record<string, unknown>): Record<string, FixtureAttr> {
  const out: Record<string, FixtureAttr> = {};
  for (const key of Object.keys(attrs).sort()) {
    const v = attrs[key];
    if (typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isInteger(v))) {
      out[key] = v;
    } else {
      throw new Error(`attr ${key} has a non-fixture value: ${String(v)}`);
    }
  }
  return out;
}

/** Convert a parsed tree into the fixture `expect` object (README §5). Pure; O(|source| + blocks). */
export function toFixtureExpect(tree: BlockTree): FixtureExpect {
  const table = byteOffsetTable(tree.source);
  return {
    leading_trivia: tree.leadingTrivia,
    blocks: tree.children.map((b) => toFixtureBlock(b, table, false)),
  };
}

// ---- validation ----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HEX64 = /^[0-9a-f]{64}$/;

function validateBlock(at: string, b: unknown, nested: boolean, problems: string[]): void {
  if (!isRecord(b)) {
    problems.push(`${at}: block is not an object`);
    return;
  }
  const keys = Object.keys(b).sort();
  const want = [...FIXTURE_BLOCK_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    problems.push(`${at}: block must have exactly the fields ${FIXTURE_BLOCK_KEYS.join(", ")} (got ${keys.join(", ")})`);
  }
  if (typeof b.type !== "string" || b.type === "") problems.push(`${at}: \`type\` must be a non-empty string`);
  const span = b.span;
  if (
    !Array.isArray(span) ||
    span.length !== 2 ||
    !span.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0) ||
    (span[0] as number) > (span[1] as number)
  ) {
    problems.push(`${at}: \`span\` must be [start, end] with 0 <= start <= end`);
  }
  if (typeof b.text !== "string") problems.push(`${at}: \`text\` must be a string`);
  if (!isRecord(b.attrs)) problems.push(`${at}: \`attrs\` must be an object`);
  else {
    for (const [k, v] of Object.entries(b.attrs)) {
      const ok = typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isInteger(v));
      if (!ok) problems.push(`${at}: attr \`${k}\` must be a boolean, integer or string`);
    }
  }
  if (typeof b.trivia !== "string") problems.push(`${at}: \`trivia\` must be a string`);
  else if (nested && b.trivia !== "") problems.push(`${at}: nested block must have "trivia": ""`);
  if (typeof b.raw_hash !== "string" || !HEX64.test(b.raw_hash)) {
    problems.push(`${at}: \`raw_hash\` must be 64 lowercase hex characters`);
  }
  if (!Array.isArray(b.children)) problems.push(`${at}: \`children\` must be an array`);
  else b.children.forEach((c, i) => validateBlock(`${at}.children[${i}]`, c, true, problems));
}

/**
 * Validate a parsed `cases/<suite>.json`; returns the problems found (empty = valid).
 * `file` is the file name (with `.json`); the suite must equal its stem.
 */
export function validateFixtureFile(file: string, doc: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${file}: not an object`];
  const stem = file.replace(/\.json$/, "");
  if (doc.suite !== stem) problems.push(`${file}: \`suite\` must equal the file stem '${stem}' (got ${JSON.stringify(doc.suite)})`);
  if (doc.format !== "markdown") problems.push(`${file}: \`format\` must be "markdown"`);
  const extra = Object.keys(doc).filter((k) => !["suite", "format", "cases"].includes(k));
  if (extra.length > 0) problems.push(`${file}: unknown top-level keys ${extra.join(", ")}`);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
    return [...problems, `${file}: \`cases\` must be a non-empty array`];
  }
  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const unknown = Object.keys(c).filter((k) => !(FIXTURE_CASE_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) problems.push(`${at}: unknown case keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);
    if (typeof c.source !== "string") problems.push(`${at}: \`source\` must be a string`);
    if (!isRecord(c.expect)) {
      problems.push(`${at}: missing \`expect\``);
      return;
    }
    const e = c.expect;
    const extraExpect = Object.keys(e).filter((k) => !["leading_trivia", "blocks"].includes(k));
    if (extraExpect.length > 0) problems.push(`${at}: unknown expect keys ${extraExpect.join(", ")}`);
    if (typeof e.leading_trivia !== "string") problems.push(`${at}: \`expect.leading_trivia\` must be a string`);
    if (!Array.isArray(e.blocks)) problems.push(`${at}: \`expect.blocks\` must be an array`);
    else e.blocks.forEach((b, j) => validateBlock(`${at}.blocks[${j}]`, b, false, problems));
  });
  return problems;
}
