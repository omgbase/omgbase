// A unified diff rendered as Markdown — the pure part of <unified-markdown-diff>.
//
// A hunk is an excerpt: it may start inside a fenced code block, at the third
// item of a nested list, at one row of a table. Rendering its lines as Markdown
// on their own would break the construct (the code would read as prose, the
// item would lose its nesting, the row would not be a table). So this module
// never renders the excerpt: it renders the DOCUMENTS — both revisions' full
// text, which the page fetches with `docs_read_at` — and uses the hunk only to
// decide what to show and how to colour it.
//
//   1. `parseUnified` reads the hunks; `alignRows` lays both documents side by
//      side as one sequence of rows — every line of either revision is a row
//      (`ctx` for an unchanged line, `del`/`add` for the others), each knowing
//      its line in the old and/or new text and which hunk, if any, it came from.
//   2. markdown-it parses each revision; its block tokens carry `map` (the
//      source line range), from which `blockTree` builds a tree of blocks:
//      containers (lists, list items, blockquotes) with children, and leaves
//      (paragraphs, headings, fences, tables, frontmatter, …). A block's lines
//      give it a span of rows.
//   3. `pieces` merges the two trees level by level. Blocks of the two sides
//      whose row spans overlap form one cluster — the before and after versions
//      of one element. A cluster whose rows are all `ctx` is unchanged (rendered
//      once, neutral). A cluster with changes and one container on each side of
//      the same kind recurses into their children, so a list keeps its chrome
//      and only the items that changed are coloured. A cluster with changes and
//      one VERBATIM block on each side — a fenced code block, an indented code
//      block, the frontmatter — whose fence lines did not change is rendered
//      once as that code block with its lines coloured individually (removed
//      lines red, added green, the rest neutral): code and YAML lines are
//      independent, and a one-line edit inside a long fence should read as
//      one. A cluster with changes and one TABLE on each side whose header and
//      alignment rows did not change is one table: the header once, the body
//      rows coloured individually (a removed row red, an added row green, so a
//      changed cell is its row twice). ANY other changed cluster is rendered
//      whole, twice: every before block on the removed (red) side, every after
//      block on the added (green) side — a paragraph with one changed word, a
//      heading, an item whose own text changed, a fence whose info string
//      changed, a table whose header changed. Nothing else is coloured a line
//      at a time inside a rendered element.
//   4. Only clusters that touch a hunk's rows are shown (the diff's own three
//      lines of context decide the extent); the rest of the document — and the
//      rest of a container's children — is elided with a `⋯` gap marker. Each
//      level of `merge` emits its own gaps, so an elision that spans levels
//      (the tail of a list, then the paragraph after the list; the leading
//      items of three nested lists) would show one `⋯` per level in a row —
//      `coalesceGaps` keeps ONE per run of consecutive gaps, the shallowest,
//      because vertical space in the feed is at a premium and two markers say
//      nothing one does not. No marker leads or trails the document when the
//      first or last block is shown, and none sits between two shown blocks
//      that are adjacent in the source: a gap is only ever emitted for a
//      cluster that was skipped.
//   5. `renderPieces` turns the pieces into HTML through markdown-it's own
//      renderer over the original tokens (a container's open/close tokens
//      around its rendered children; a leaf's token slice; `html: false` so raw
//      HTML is escaped, images named not fetched, unsafe link schemes dropped by
//      the parser) with `data-kind="add|del"` on the coloured pieces.
//
// Without the full texts (or when they do not match the diff) the two sides are
// reconstructed from the hunks alone — the excerpt — which is the best that can
// be done and is said so (`source: "excerpt"`).

import MarkdownIt from "markdown-it";
import type { MarkdownIt as Md, StateBlock, Token } from "markdown-it";

// ---- the unified diff ------------------------------------------------------------------

export type RowKind = "add" | "del" | "ctx";

export interface HunkLine { kind: RowKind; text: string }

export interface Hunk {
  /** 0-based index of the first old line (for an empty old side, the position between lines). */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunks of a unified diff without file headers (what `docs_diff_unified` emits). */
export function parseUnified(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  if (diff === "") return hunks;
  let current: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const m = HUNK.exec(line);
    if (m) {
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      const a = Number(m[1]);
      const c = Number(m[3]);
      current = { oldStart: oldCount === 0 ? a : a - 1, oldCount, newStart: newCount === 0 ? c : c - 1, newCount, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // text before the first hunk header
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ kind: "del", text: line.slice(1) });
    else current.lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return hunks;
}

/** A text's lines as `docs_diff_unified` counts them: `raw.split("\n")` verbatim, so
 * a text ending in a newline has an empty last line (its hunks say so: a
 * trailing `+` line for a created document's final newline). Empty text → []. */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** The same without that empty last line — `createdDiff`'s model (`@@ -0,0 +1,N @@` over the content's N lines). */
export function dropTrailingEmpty(lines: readonly string[]): string[] {
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : [...lines];
}

/** Do the hunks describe exactly these two texts? (The ctx/del lines at their
 * old positions, the ctx/add lines at their new ones, and the gaps equal.) */
export function consistent(before: readonly string[], after: readonly string[], hunks: readonly Hunk[]): boolean {
  let o = 0;
  let n = 0;
  for (const h of hunks) {
    if (h.oldStart < o || h.newStart < n || h.oldStart - o !== h.newStart - n) return false;
    for (; o < h.oldStart; o++, n++) if (before[o] !== after[n]) return false;
    for (const l of h.lines) {
      if (l.kind !== "add" && before[o++] !== l.text) return false;
      if (l.kind !== "del" && after[n++] !== l.text) return false;
    }
  }
  if (before.length - o !== after.length - n) return false;
  for (; o < before.length; o++, n++) if (before[o] !== after[n]) return false;
  return true;
}

/** The two sides as the hunks alone tell them (the excerpt), with the hunks
 * rebased onto those shorter texts. */
export function sidesFromHunks(hunks: readonly Hunk[]): { before: string[]; after: string[]; hunks: Hunk[] } {
  const before: string[] = [];
  const after: string[] = [];
  const rebased: Hunk[] = [];
  for (const h of hunks) {
    const r: Hunk = { ...h, oldStart: before.length, newStart: after.length };
    for (const l of h.lines) {
      if (l.kind !== "add") before.push(l.text);
      if (l.kind !== "del") after.push(l.text);
    }
    rebased.push(r);
  }
  return { before, after, hunks: rebased };
}

export interface Row {
  kind: RowKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** The hunk this row came from; null for a line outside every hunk. */
  hunk: number | null;
}

/** Both texts as one sequence of rows (requires `consistent`). */
export function alignRows(before: readonly string[], after: readonly string[], hunks: readonly Hunk[]): Row[] {
  const rows: Row[] = [];
  let o = 0;
  let n = 0;
  hunks.forEach((h, i) => {
    for (; o < h.oldStart; o++, n++) rows.push({ kind: "ctx", text: before[o]!, oldLine: o, newLine: n, hunk: null });
    for (const l of h.lines) {
      if (l.kind === "del") rows.push({ kind: "del", text: l.text, oldLine: o++, newLine: null, hunk: i });
      else if (l.kind === "add") rows.push({ kind: "add", text: l.text, oldLine: null, newLine: n++, hunk: i });
      else rows.push({ kind: "ctx", text: l.text, oldLine: o++, newLine: n++, hunk: i });
    }
  });
  for (; o < before.length; o++, n++) rows.push({ kind: "ctx", text: before[o]!, oldLine: o, newLine: n, hunk: null });
  return rows;
}

// ---- the parser --------------------------------------------------------------------------

/** YAML frontmatter as one block: a document starting with `---` up to the
 * next `---` line, rendered as a `yaml` code block instead of a thematic break
 * plus a setext heading. */
function frontmatter(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0) return false;
  const lineText = (i: number) => state.src.slice(state.bMarks[i]! + state.tShift[i]!, state.eMarks[i]!);
  if (lineText(0) !== "---") return false;
  let close = -1;
  for (let i = 1; i < endLine; i++) if (lineText(i) === "---") { close = i; break; }
  if (close < 0) return false;
  if (silent) return true;
  const token = state.push("frontmatter", "code", 0);
  token.map = [0, close + 1];
  token.content = state.getLines(1, close, 0, true);
  token.markup = "---";
  token.info = "yaml";
  state.line = close + 1;
  return true;
}

let shared: Md | null = null;

/** The one parser: CommonMark + tables + strikethrough, no raw HTML (escaped),
 * no images, frontmatter as a block. */
export function markdown(): Md {
  if (shared) return shared;
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  // An image is named, not fetched: nothing in a diff view should reach out to a URL.
  md.renderer.rules.image = (tokens, idx) => `<span class="image">[image: ${md.utils.escapeHtml(tokens[idx]!.content)}]</span>`;
  md.block.ruler.before("table", "frontmatter", frontmatter);
  md.renderer.rules.frontmatter = (tokens, idx) => `<pre class="frontmatter"><code class="language-yaml">${md.utils.escapeHtml(tokens[idx]!.content)}</code></pre>\n`;
  shared = md;
  return md;
}

// ---- blocks ------------------------------------------------------------------------------

/** The block kinds whose children are blocks of their own; everything else is rendered as one piece. */
const CONTAINERS = new Set(["bullet_list", "ordered_list", "list_item", "blockquote"]);
/** The block kinds whose lines are verbatim and independent: a change inside is coloured line by line. */
const VERBATIM = new Set(["fence", "code_block", "frontmatter"]);

export interface Block {
  /** `paragraph`, `heading`, `fence`, `table`, `bullet_list`, `list_item`, `frontmatter`, … */
  type: string;
  /** Source lines [start, end). */
  start: number;
  end: number;
  /** Token indices: the opening token and its matching close (the same for a self-closing token). */
  open: number;
  close: number;
  container: boolean;
  /** The fence string of a `fence` (```` ``` ````, `~~~`), `---` for the frontmatter, "" otherwise. */
  markup: string;
  children: Block[];
}

/** The block tree of a token stream (markdown-it's `map` gives each block its
 * lines). With the source `lines`, a block's range is trimmed of the blank
 * lines markdown-it leaves at the end of a list or an item, so a blank line
 * between two blocks belongs to neither. */
export function blockTree(tokens: readonly Token[], lines?: readonly string[]): Block[] {
  const root: Block = { type: "document", start: 0, end: 0, open: -1, close: -1, container: true, markup: "", children: [] };
  const stack: Block[] = [root];
  const range = (t: Token): [number, number] => {
    const start = t.map?.[0] ?? 0;
    let end = t.map?.[1] ?? 0;
    if (lines) while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end--;
    return [start, end];
  };
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const parent = stack[stack.length - 1]!;
    if (t.nesting === 1) {
      const type = t.type.replace(/_open$/, "");
      const [start, end] = range(t);
      const b: Block = { type, start, end, open: i, close: -1, container: CONTAINERS.has(type), markup: t.markup, children: [] };
      parent.children.push(b);
      if (b.container) { stack.push(b); i++; continue; }
      let depth = 1;
      let j = i + 1;
      while (depth > 0 && j < tokens.length) { depth += tokens[j]!.nesting; j++; }
      b.close = j - 1;
      i = j;
    } else if (t.nesting === -1) {
      const b = stack.pop();
      if (b) b.close = i;
      i++;
    } else {
      const [start, end] = range(t);
      parent.children.push({ type: t.type, start, end, open: i, close: i, container: false, markup: t.markup, children: [] });
      i++;
    }
  }
  return root.children;
}

// ---- pieces ------------------------------------------------------------------------------

export type Mark = "add" | "del" | null;

/** What is shown, in order: whole blocks (coloured or neutral), containers whose children are shown in turn, and gaps. */
export interface VerbatimLine { kind: RowKind; text: string }

/** One body row of a row-level table: the `tr_open`..`tr_close` token slice on its side, its source line, its colour. */
export interface TableRow { side: "before" | "after"; open: number; close: number; text: string; mark: Mark }

export type Piece =
  | { kind: "gap" }
  | { kind: "block"; side: "before" | "after"; block: Block; mark: Mark }
  | { kind: "container"; block: Block; children: Piece[] }
  /** One code block (the after side's) with its lines coloured individually; `before` is its other version. */
  | { kind: "verbatim"; block: Block; before: Block; lines: VerbatimLine[] }
  /** One table (the after side's header) with its body rows coloured individually; `before` is its other version. */
  | { kind: "table"; block: Block; before: Block; rows: TableRow[] };

interface Sides {
  rows: Row[];
  before: readonly string[];
  after: readonly string[];
  /** Row index by old line / by new line. */
  byOld: number[];
  byNew: number[];
  /** Prefix counts over rows: changed rows (add/del) and rows inside a hunk. */
  changed: number[];
  inHunk: number[];
}

function prefix(rows: readonly Row[], test: (r: Row) => boolean): number[] {
  const out = [0];
  for (const r of rows) out.push(out[out.length - 1]! + (test(r) ? 1 : 0));
  return out;
}

function sides(rows: Row[], before: readonly string[], after: readonly string[]): Sides {
  const byOld: number[] = [];
  const byNew: number[] = [];
  rows.forEach((r, i) => {
    if (r.oldLine !== null) byOld[r.oldLine] = i;
    if (r.newLine !== null) byNew[r.newLine] = i;
  });
  return { rows, before, after, byOld, byNew, changed: prefix(rows, (r) => r.kind !== "ctx"), inHunk: prefix(rows, (r) => r.hunk !== null) };
}

/** The lines of a verbatim block that are its content — between the fence lines of a `fence` or the `---` of the frontmatter; all of an indented `code_block` — and the indent to strip. */
function contentRange(b: Block, lines: readonly string[]): { from: number; to: number; indent: number } {
  const indent = /^[ \t]*/.exec(lines[b.start] ?? "")![0].length;
  if (b.type === "code_block") return { from: b.start, to: b.end, indent };
  const last = lines[b.end - 1] ?? "";
  const closed = b.end - 1 > b.start && (b.type === "frontmatter" || (b.markup !== "" && last.trim().startsWith(b.markup)));
  return { from: b.start + 1, to: closed ? b.end - 1 : b.end, indent };
}

/** A changed verbatim cluster's lines, coloured one by one; null when a fence
 * line itself changed (the info string, say) — then the block is shown twice. */
function verbatimLines(s: Sides, c: Cluster, before: Block, after: Block): VerbatimLine[] | null {
  const b = contentRange(before, s.before);
  const a = contentRange(after, s.after);
  const strip = (text: string, indent: number) => text.slice(Math.min(indent, /^[ \t]*/.exec(text)![0].length));
  const out: VerbatimLine[] = [];
  for (let i = c.lo; i <= c.hi; i++) {
    const r = s.rows[i]!;
    const inA = r.newLine !== null && r.newLine >= a.from && r.newLine < a.to;
    const inB = r.oldLine !== null && r.oldLine >= b.from && r.oldLine < b.to;
    if (r.kind === "ctx") { if (inA !== inB) return null; if (inA) out.push({ kind: "ctx", text: strip(r.text, a.indent) }); continue; }
    if (r.kind === "add") { if (!inA) return null; out.push({ kind: "add", text: strip(r.text, a.indent) }); continue; }
    if (!inB) return null;
    out.push({ kind: "del", text: strip(r.text, b.indent) });
  }
  return out;
}

/** A block's rows, inclusive: from its first line's row to its last line's (the rows between — the other side's deletions or additions — included). */
function span(s: Sides, side: "before" | "after", b: Block): [number, number] | null {
  const by = side === "before" ? s.byOld : s.byNew;
  if (b.end <= b.start) return null;
  const lo = by[b.start];
  const hi = by[b.end - 1];
  return lo === undefined || hi === undefined ? null : [lo, hi];
}

const count = (p: readonly number[], lo: number, hi: number) => p[hi + 1]! - p[lo]!;

interface Cluster { lo: number; hi: number; before: Block[]; after: Block[] }

/** Blocks of the two sides grouped by overlapping row spans, in row order. */
function clusters(s: Sides, before: readonly Block[], after: readonly Block[]): Cluster[] {
  const spans: { side: "before" | "after"; block: Block; lo: number; hi: number }[] = [];
  for (const b of before) { const sp = span(s, "before", b); if (sp) spans.push({ side: "before", block: b, lo: sp[0], hi: sp[1] }); }
  for (const b of after) { const sp = span(s, "after", b); if (sp) spans.push({ side: "after", block: b, lo: sp[0], hi: sp[1] }); }
  // A deleted block before an added one at the same position: by lo, deletions first.
  spans.sort((x, y) => x.lo - y.lo || (x.side === y.side ? 0 : x.side === "before" ? -1 : 1));
  const out: Cluster[] = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && sp.lo <= last.hi) {
      last.hi = Math.max(last.hi, sp.hi);
      last[sp.side].push(sp.block);
    } else {
      out.push({ lo: sp.lo, hi: sp.hi, before: [], after: [], [sp.side]: [sp.block] } as Cluster);
    }
  }
  return out;
}

/** A table's body rows by source line: the `tr_open`..`tr_close` slice of each (the header's row excluded). */
function bodyRows(tokens: readonly Token[], b: Block): Map<number, { open: number; close: number }> {
  const out = new Map<number, { open: number; close: number }>();
  let inBody = false;
  for (let i = b.open; i <= b.close; i++) {
    const t = tokens[i]!;
    if (t.type === "tbody_open") inBody = true;
    else if (t.type === "tbody_close") inBody = false;
    else if (inBody && t.type === "tr_open" && t.map) {
      let j = i + 1;
      while (tokens[j]!.type !== "tr_close") j++;
      out.set(t.map[0], { open: i, close: j });
    }
  }
  return out;
}

/** A changed table cluster's body rows, coloured one by one; null when the
 * header or alignment row changed, or a changed line is not a body row —
 * then the table is shown twice. */
function tableRows(s: Sides, c: Cluster, tokens: MarkdownDiff["tokens"], before: Block, after: Block): TableRow[] | null {
  const rowsB = bodyRows(tokens.before, before);
  const rowsA = bodyRows(tokens.after, after);
  const out: TableRow[] = [];
  for (let i = c.lo; i <= c.hi; i++) {
    const r = s.rows[i]!;
    const headA = r.newLine !== null && r.newLine >= after.start && r.newLine < after.start + 2;
    const headB = r.oldLine !== null && r.oldLine >= before.start && r.oldLine < before.start + 2;
    if (headA || headB) { if (r.kind !== "ctx" || headA !== headB) return null; continue; }
    const a = r.newLine === null ? undefined : rowsA.get(r.newLine);
    const b = r.oldLine === null ? undefined : rowsB.get(r.oldLine);
    if (r.kind === "ctx") { if (!a || !b) return null; out.push({ side: "after", ...a, text: r.text, mark: null }); continue; }
    if (r.kind === "add") { if (!a) return null; out.push({ side: "after", ...a, text: r.text, mark: "add" }); continue; }
    if (!b) return null;
    out.push({ side: "before", ...b, text: r.text, mark: "del" });
  }
  return out;
}

/** The pieces for one level: the clusters that touch a hunk, the rest elided. */
function merge(s: Sides, tokens: MarkdownDiff["tokens"], before: readonly Block[], after: readonly Block[]): Piece[] {
  const out: Piece[] = [];
  let gap = false;
  for (const c of clusters(s, before, after)) {
    if (count(s.inHunk, c.lo, c.hi) === 0) { gap = true; continue; }
    if (gap) { out.push({ kind: "gap" }); gap = false; }
    const changed = count(s.changed, c.lo, c.hi) > 0;
    if (!changed) {
      // Unchanged: the after side once, neutral — a container only partly inside the hunk shows just the children that touch it.
      const whole = count(s.inHunk, c.lo, c.hi) === c.hi - c.lo + 1;
      for (const b of c.after) out.push(b.container && !whole ? { kind: "container", block: b, children: merge(s, tokens, pairOf(c.before, b), b.children) } : { kind: "block", side: "after", block: b, mark: null });
      continue;
    }
    const [b, a] = [c.before[0], c.after[0]];
    if (c.before.length === 1 && c.after.length === 1 && b!.type === a!.type) {
      if (b!.container) {
        out.push({ kind: "container", block: a!, children: merge(s, tokens, b!.children, a!.children) });
        continue;
      }
      if (VERBATIM.has(a!.type)) {
        const lines = verbatimLines(s, c, b!, a!);
        if (lines) { out.push({ kind: "verbatim", block: a!, before: b!, lines }); continue; }
      }
      if (a!.type === "table") {
        const rows = tableRows(s, c, tokens, b!, a!);
        if (rows) { out.push({ kind: "table", block: a!, before: b!, rows }); continue; }
      }
    }
    for (const x of c.before) out.push({ kind: "block", side: "before", block: x, mark: "del" });
    for (const x of c.after) out.push({ kind: "block", side: "after", block: x, mark: "add" });
  }
  if (gap) out.push({ kind: "gap" });
  return out;
}

/** One `⋯` per elision, however many levels it spans. `merge` emits a gap per
 * level, so consecutive gaps in reading order — a container's elided tail
 * followed by an elided sibling after it, the leading gaps of nested lists
 * whose first items are all elided — are one run, and a run keeps a single
 * marker: the shallowest (the first of those on a tie), so it sits outside the
 * list chrome rather than as an item of a list that is otherwise not shown. A
 * container left without children is dropped with them. */
export function coalesceGaps(pieces: readonly Piece[]): Piece[] {
  const drop = new Set<Piece>();
  let run: { piece: Piece; depth: number }[] = [];
  const flush = () => {
    const keep = run.reduce<{ piece: Piece; depth: number } | null>((best, g) => (best === null || g.depth < best.depth ? g : best), null);
    for (const g of run) if (g !== keep) drop.add(g.piece);
    run = [];
  };
  const walk = (ps: readonly Piece[], depth: number) => {
    for (const p of ps) {
      if (p.kind === "gap") run.push({ piece: p, depth });
      else if (p.kind === "container") walk(p.children, depth + 1);
      else flush();
    }
  };
  walk(pieces, 0);
  flush();
  const prune = (ps: readonly Piece[]): Piece[] => ps.flatMap<Piece>((p) => {
    if (drop.has(p)) return [];
    if (p.kind !== "container") return [p];
    const children = prune(p.children);
    return children.length === 0 ? [] : [{ ...p, children }];
  });
  return drop.size === 0 ? [...pieces] : prune(pieces);
}

/** For an unchanged after container, the before container it pairs with (same type), so the recursion can keep pairing. */
function pairOf(before: readonly Block[], after: Block): Block[] {
  const b = before.find((x) => x.type === after.type && x.container);
  return b ? b.children : [];
}

export interface MarkdownDiff {
  pieces: Piece[];
  /** Whether both revisions' full texts were used, or the sides were rebuilt from the hunks alone. */
  source: "documents" | "excerpt";
  tokens: { before: Token[]; after: Token[] };
}

/** The pieces of a diff over the two revisions' texts (either may be null:
 * then, or when the texts do not match the diff, the excerpt is used). */
export function markdownDiff(diff: string, before: string | null = null, after: string | null = null): MarkdownDiff {
  const md = markdown();
  let hunks = parseUnified(diff);
  let source: MarkdownDiff["source"] = "documents";
  let b: string[] | null = null;
  let a: string[] | null = null;
  if (before !== null && after !== null) {
    // The server's verbatim split first, then without the trailing empty line (`createdDiff`'s count).
    const verbatim = [splitLines(before), splitLines(after)] as const;
    for (const [x, y] of [verbatim, [dropTrailingEmpty(verbatim[0]), dropTrailingEmpty(verbatim[1])] as const]) {
      if (consistent(x, y, hunks)) { b = x; a = y; break; }
    }
  }
  if (b === null || a === null) {
    ({ before: b, after: a, hunks } = sidesFromHunks(hunks));
    source = "excerpt";
  }
  const s = sides(alignRows(b, a, hunks), b, a);
  const tokens = { before: md.parse(b.join("\n"), {}), after: md.parse(a.join("\n"), {}) };
  return { pieces: hunks.length === 0 ? [] : coalesceGaps(merge(s, tokens, blockTree(tokens.before, b), blockTree(tokens.after, a))), source, tokens };
}

// ---- HTML --------------------------------------------------------------------------------

function clone(t: Token): Token {
  return Object.assign(Object.create(Object.getPrototypeOf(t) as object), t, { attrs: t.attrs ? t.attrs.map((a) => [...a] as [string, string]) : null }) as Token;
}

function withAttr(t: Token, name: string, value: string): Token {
  const c = clone(t);
  c.attrs = [...(c.attrs ?? []).filter(([n]) => n !== name), [name, value]];
  return c;
}

function renderTokens(md: Md, tokens: Token[]): string {
  return md.renderer.render(tokens, md.options, {});
}

/** A list's `start` for an `<ol>` whose first items are elided: the list's own start plus the index of the first item shown. */
function listStart(list: Block, children: readonly Piece[]): number | null {
  const first = children.find((p): p is Exclude<Piece, { kind: "gap" }> => p.kind !== "gap");
  if (!first) return null;
  const index = list.children.indexOf(first.block);
  return index <= 0 ? null : index;
}

/** The pieces as HTML: markdown-it's renderer over the original tokens, `data-kind` on the coloured pieces, one `⋯` line for each gap (never two in a row — `coalesceGaps`). */
export function renderPieces(d: MarkdownDiff, md: Md = markdown()): string {
  const render = (pieces: readonly Piece[], inList: boolean): string => pieces.map((p) => {
    if (p.kind === "gap") return inList ? `<li class="gap">⋯</li>\n` : `<div class="gap">⋯</div>\n`;
    if (p.kind === "verbatim") {
      const info = p.block.type === "frontmatter" ? "yaml" : p.block.type === "fence" ? d.tokens.after[p.block.open]!.info.trim().split(/\s+/)[0] ?? "" : "";
      const cls = [p.block.type === "frontmatter" ? "frontmatter" : "", info ? `language-${md.utils.escapeHtml(info)}` : ""].filter(Boolean);
      const body = p.lines.map((l) => `<span class="line" data-kind="${l.kind}">${md.utils.escapeHtml(l.text)}\n</span>`).join("");
      return `<pre class="verbatim${p.block.type === "frontmatter" ? " frontmatter" : ""}"><code${cls.length ? ` class="${cls.join(" ")}"` : ""}>${body}</code></pre>\n`;
    }
    if (p.kind === "table") {
      const toks = d.tokens.after;
      const headOpen = toks.findIndex((t, i) => i > p.block.open && t.type === "thead_open");
      let headClose = headOpen;
      while (toks[headClose]!.type !== "thead_close") headClose++;
      const rows = p.rows.map((r) => {
        const slice = d.tokens[r.side].slice(r.open, r.close + 1);
        return renderTokens(md, r.mark ? [withAttr(slice[0]!, "data-kind", r.mark), ...slice.slice(1)] : slice);
      }).join("");
      return `<table class="rows">\n${renderTokens(md, toks.slice(headOpen, headClose + 1))}<tbody>\n${rows}</tbody>\n</table>\n`;
    }
    if (p.kind === "block") {
      const toks = d.tokens[p.side];
      const slice = toks.slice(p.block.open, p.block.close + 1);
      if (p.mark === null) return renderTokens(md, slice);
      if (p.block.type === "list_item") return renderTokens(md, [withAttr(slice[0]!, "data-kind", p.mark), ...slice.slice(1)]);
      return `<div class="piece" data-kind="${p.mark}">${renderTokens(md, slice)}</div>\n`;
    }
    const toks = d.tokens.after;
    let open = toks[p.block.open]!;
    if (p.block.type === "ordered_list") {
      const extra = listStart(p.block, p.children);
      if (extra !== null) open = withAttr(open, "start", String(Number(open.attrGet("start") ?? "1") + extra));
    }
    // The opening tag with its real neighbours in sight (markdown-it's newlines depend on them: none before a tight item's text), the children, the closing tag.
    const chrome = (t: Token, i: number) => md.renderer.renderToken([...toks.slice(i - 1, i), t, ...toks.slice(i + 1, i + 2)], i > 0 ? 1 : 0, md.options);
    return chrome(open, p.block.open) + render(p.children, p.block.type === "bullet_list" || p.block.type === "ordered_list") + chrome(toks[p.block.close]!, p.block.close);
  }).join("");
  return render(d.pieces, false);
}

/** The whole thing: a diff and the two revisions → HTML and where the sides came from. */
export function renderMarkdownDiff(diff: string, before: string | null = null, after: string | null = null): { html: string; source: MarkdownDiff["source"] } {
  const d = markdownDiff(diff, before, after);
  return { html: renderPieces(d), source: d.source };
}

/** A flat description of the pieces for tests and debugging: `add paragraph new 3-4`, `container bullet_list new 8-16 [ … ]`, `verbatim fence new 18-23  a| -b|+B`, `table new 24-29  | a |…|-| b |…|+| B |…`, `gap`. */
export function describePieces(pieces: readonly Piece[]): string[] {
  return pieces.map((p) => {
    if (p.kind === "gap") return "gap";
    if (p.kind === "block") return `${p.mark ?? "ctx"} ${p.block.type} ${p.side === "before" ? "old" : "new"} ${p.block.start}-${p.block.end}`;
    if (p.kind === "verbatim") return `verbatim ${p.block.type} new ${p.block.start}-${p.block.end} ${p.lines.map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text).join("|")}`;
    if (p.kind === "table") return `table new ${p.block.start}-${p.block.end} ${p.rows.map((r) => (r.mark ?? " ").replace("add", "+").replace("del", "-") + r.text).join("|")}`;
    return `container ${p.block.type} new ${p.block.start}-${p.block.end} [${describePieces(p.children).join(", ")}]`;
  });
}
