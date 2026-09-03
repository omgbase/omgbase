// Block model — 01-architecture §3.3, 03-reconciliation-spec §1.
//
// As-built note: the design (03 §1) types spans as byte offsets and `raw` as
// Uint8Array. We work in string space instead — mdast/micromark positions are
// offsets into the decoded source string, and byte-identity round-trip follows
// from deterministic UTF-8 encoding of equal strings. Hashing (02 §5) encodes
// UTF-8 at hash time. This keeps offset handling robust and simple.

export type BlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "list_item"
  | "task"
  | "blockquote"
  | "code_fence"
  | "table"
  | "table_row"
  | "thematic_break"
  | "html_block"
  | "frontmatter"
  | "opaque";

/** Half-open [start, end) offsets into the source string. */
export interface Span {
  start: number;
  end: number;
}

export interface RawBlock {
  type: BlockType;
  span: Span;
  /** Exact source slice for this block's content (excludes trailing trivia). */
  raw: string;
  /** Normalized visible text (02 §5.2 — refined in Stage 1). */
  text: string;
  /** Typed attributes: level, ordered, checked, lang, info, … */
  attrs: Record<string, unknown>;
  /** Parser nesting only (lists, list items, blockquotes, tables). */
  children: RawBlock[];
  /** Trailing inter-block trivia attached to this block (03 §2.3). */
  trivia: string;
  /** Authored ^block-ref anchors (Stage 4). */
  anchors: string[];
  /** Extracted outgoing links for edge extraction (Stage 4). */
  outLinks: ExtractedLink[];
}

export interface ExtractedLink {
  kind: "link" | "wikilink" | "image" | "inline_field" | "url";
  target: string;
  anchor?: string;
  field?: string;
}

export interface BlockTree {
  /** The decoded source string this tree was parsed from. */
  source: string;
  /** Bytes before the first block (document-leading trivia, 03 §2.3). */
  leadingTrivia: string;
  /** Top-level blocks in document order (flat containment). */
  children: RawBlock[];
}
