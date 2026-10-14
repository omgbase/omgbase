// The document body rendered as Markdown, with each block of the rendering
// carrying its omgbase block id — so a block is a stable anchor (`id="b_…"`)
// and shows its id on hover.
//
// `docs_read { include_ids: true }` returns the block ids in pre-order with a
// `parents` map, but no spans. markdown-it's block tokens carry `map` (source
// line ranges). The two trees are the same block model — a top-level CommonMark
// block is a top-level omgbase block, a list's items are its children — so the
// ids are PAIRED positionally level by level (`pairBlocks`): the n-th top-level
// token takes the n-th top-level id; a list's item tokens take the list's child
// ids; a list item's own text is the item itself in the store (there is no
// paragraph child), so its paragraph tokens are skipped when the counts differ.
// A level whose counts do not agree is left without anchors (counted in
// `unmatched`) rather than guessed.
//
// Each pairing is then VERIFIED with the `hashes` map: a block's hash is the
// sha256 of its raw source, and the raw is exactly the token's lines (trailing
// blank lines dropped — markdown-it attributes a list's trailing blank line to
// the list), so a candidate that hashes to the id's hash is certain
// (`data-verified="true"`) and one that does not is shown but marked
// (`data-verified="false"`). Nothing is fetched to do this; it is the ids map
// put to its documented use (the hashes are the CAS tokens).
//
// Rendering: markdown-it with `html: false` (raw HTML escaped), images named
// not fetched, external links opened in a new tab, a tiny inline rule for
// `[[wikilinks]]` (rendered as `<a data-wiki>`; the page resolves one with a
// query), and a `/`-rooted link kept as it is for the page to open in place.

import MarkdownIt from "markdown-it";
import type { MarkdownIt as Md, StateInline, Token } from "markdown-it";
import type { BlockIds } from "./document.ts";

// ---- the parser ---------------------------------------------------------------------------

function wikilink(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || /[\n[\]]/.test(inner)) return false;
  if (!silent) {
    const t = state.push("wikilink", "a", 0);
    t.content = inner;
  }
  state.pos = end + 2;
  return true;
}

let shared: Md | null = null;

/** The one parser: CommonMark + tables + strikethrough, no raw HTML, no fetched images, wikilinks. */
export function markdown(): Md {
  if (shared) return shared;
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.renderer.rules.image = (tokens, idx) => `<span class="image">[image: ${md.utils.escapeHtml(tokens[idx]!.content)}]</span>`;
  md.inline.ruler.before("link", "wikilink", wikilink);
  md.renderer.rules.wikilink = (tokens, idx) => {
    const [target, alias] = tokens[idx]!.content.split("|") as [string, string?];
    const t = md.utils.escapeHtml(target.trim());
    return `<a class="wikilink" href="#wiki:${encodeURIComponent(target.trim())}" data-wiki="${t}">${md.utils.escapeHtml((alias ?? target).trim())}</a>`;
  };
  const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = String(tokens[idx]!.attrGet("href") ?? "");
    if (/^https?:\/\//i.test(href)) {
      tokens[idx]!.attrSet("target", "_blank");
      tokens[idx]!.attrSet("rel", "noopener");
    } else if (isDocHref(href)) {
      tokens[idx]!.attrSet("data-doc", docHrefPath(href));
    }
    return defaultLink(tokens, idx, options, env, self);
  };
  shared = md;
  return md;
}

/** A link the page opens in place: a `/`-rooted or relative path (not a URL scheme, not a bare `#anchor`). */
export function isDocHref(href: string): boolean {
  if (!href || href.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  return true;
}

/** The document path a link names (`/a.md#x` → `/a.md`; a relative `b.md` is left relative — the page roots it against the current document). */
export function docHrefPath(href: string): string {
  return href.split("#")[0]!;
}

// ---- the block tree -----------------------------------------------------------------------

/** Containers whose children are blocks of their own in BOTH trees. */
const CONTAINERS = new Set(["bullet_list", "ordered_list", "list_item", "blockquote"]);

export interface MdBlock {
  /** `heading`, `paragraph`, `fence`, `bullet_list`, `list_item`, `table`, `tr`, … */
  type: string;
  /** Index of the opening (or self-closing) token. */
  open: number;
  /** Source lines [start, end). */
  start: number;
  end: number;
  children: MdBlock[];
}

/** markdown-it's block tokens as a tree (a table's rows — thead's and tbody's `tr`s flattened — are its children). */
export function mdBlockTree(tokens: readonly Token[]): MdBlock[] {
  const root: MdBlock = { type: "document", open: -1, start: 0, end: 0, children: [] };
  const stack: MdBlock[] = [root];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const parent = stack[stack.length - 1]!;
    if (t.nesting === 1) {
      const type = t.type.replace(/_open$/, "");
      const [start, end] = t.map ?? [0, 0];
      if (type === "table") {
        const b: MdBlock = { type, open: i, start, end, children: [] };
        let j = i + 1;
        while (j < tokens.length && tokens[j]!.type !== "table_close") {
          const tr = tokens[j]!;
          if (tr.type === "tr_open" && tr.map) b.children.push({ type: "tr", open: j, start: tr.map[0], end: tr.map[1], children: [] });
          j++;
        }
        parent.children.push(b);
        i = j + 1;
        continue;
      }
      const b: MdBlock = { type, open: i, start, end, children: [] };
      parent.children.push(b);
      if (CONTAINERS.has(type)) { stack.push(b); i++; continue; }
      // A non-container open (heading, paragraph, …): skip to its close.
      let depth = 1;
      let j = i + 1;
      while (depth > 0 && j < tokens.length) { depth += tokens[j]!.nesting; j++; }
      i = j;
    } else if (t.nesting === -1) {
      stack.pop();
      i++;
    } else {
      if (t.map && t.level === (stack.length - 1) * 1 && t.type !== "inline") {
        parent.children.push({ type: t.type, open: i, start: t.map[0], end: t.map[1], children: [] });
      } else if (t.map && t.type !== "inline" && parent.type !== "document") {
        parent.children.push({ type: t.type, open: i, start: t.map[0], end: t.map[1], children: [] });
      }
      i++;
    }
  }
  return root.children;
}

/** The store's tree from `include_ids`: parent id (null = top level) → its children in pre-order. */
export function childrenOf(ids: BlockIds): Map<string | null, string[]> {
  const out = new Map<string | null, string[]>();
  for (const id of ids.ids) {
    const parent = ids.parents[id] ?? null;
    const list = out.get(parent);
    if (list) list.push(id);
    else out.set(parent, [id]);
  }
  return out;
}

export interface Anchor {
  id: string;
  /** The opening token's index. */
  open: number;
  type: string;
  start: number;
  end: number;
}

export interface Pairing {
  anchors: Anchor[];
  /** Store blocks that got no anchor (a level whose counts disagreed). */
  unmatched: number;
}

/** Pair markdown-it's blocks with the store's ids, level by level (the rule in the header). */
export function pairBlocks(md: readonly MdBlock[], ids: BlockIds): Pairing {
  const children = childrenOf(ids);
  const anchors: Anchor[] = [];
  let unmatched = 0;
  const countUnder = (id: string): number => (children.get(id) ?? []).reduce((n, c) => n + 1 + countUnder(c), 0);
  const pair = (blocks: readonly MdBlock[], storeIds: readonly string[], parentType: string): void => {
    let mds = blocks;
    // A list item's own text is the item in the store: its paragraph tokens are not children there.
    if (mds.length !== storeIds.length && parentType === "list_item") mds = mds.filter((b) => b.type !== "paragraph");
    if (mds.length !== storeIds.length) {
      unmatched += storeIds.reduce((n, id) => n + 1 + countUnder(id), 0);
      return;
    }
    mds.forEach((b, i) => {
      const id = storeIds[i]!;
      anchors.push({ id, open: b.open, type: b.type, start: b.start, end: b.end });
      pair(b.children, children.get(id) ?? [], b.type);
    });
  };
  pair(md, children.get(null) ?? [], "document");
  return { anchors, unmatched };
}

/** A block's raw as the store hashes it: its source lines, trailing blank lines dropped, joined by `\n`. */
export function candidateRaw(lines: readonly string[], start: number, end: number): string {
  let e = Math.min(end, lines.length);
  while (e > start + 1 && (lines[e - 1] ?? "").trim() === "") e--;
  return lines.slice(start, e).join("\n");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The raws a block may have been hashed from: its lines as they are and —
 * for a block nested in a blockquote — the same with the `>` marker (and one
 * space) stripped from the FIRST line only: the format layer's raw of a quoted
 * paragraph keeps the marker on every continuation line but not on the first
 * (observed on the alchemy corpus: `"One becomes two…\n> fourth."`). */
export function candidateRaws(lines: readonly string[], start: number, end: number): string[] {
  const raw = candidateRaw(lines, start, end);
  const out = [raw];
  const stripped = raw.replace(/^(\s*>\s?)+/, "");
  if (stripped !== raw) out.push(stripped);
  return out;
}

/** Each anchor's verdict: does one of its candidate raws hash to the id's stored hash? (No hash on record ⇒ false.) */
export async function verifyAnchors(anchors: readonly Anchor[], lines: readonly string[], hashes: Readonly<Record<string, string>>): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  await Promise.all(anchors.map(async (a) => {
    const expected = hashes[a.id];
    if (expected === undefined) { out.set(a.id, false); return; }
    const digests = await Promise.all(candidateRaws(lines, a.start, a.end).map(sha256Hex));
    out.set(a.id, digests.includes(expected));
  }));
  return out;
}

// ---- rendering -----------------------------------------------------------------------------

export interface Rendered {
  html: string;
  /** Anchors placed, with their verdicts. */
  anchors: { id: string; type: string; verified: boolean }[];
  /** Store blocks without an anchor. */
  unmatched: number;
  /** Anchors whose raw did not hash to the stored hash. */
  unverified: number;
}

/** The body rendered, every paired block carrying `id`, `data-block` and `data-verified`. */
export async function renderBody(body: string, ids: BlockIds | null): Promise<Rendered> {
  const md = markdown();
  const tokens = md.parse(body, {});
  if (!ids) return { html: md.renderer.render(tokens, md.options, {}), anchors: [], unmatched: 0, unverified: 0 };
  const lines = body.split("\n");
  const { anchors, unmatched } = pairBlocks(mdBlockTree(tokens), ids);
  const verdicts = await verifyAnchors(anchors, lines, ids.hashes);
  let unverified = 0;
  for (const a of anchors) {
    const t = tokens[a.open]!;
    const ok = verdicts.get(a.id) === true;
    if (!ok) unverified++;
    t.attrSet("id", a.id);
    t.attrSet("data-block", a.id);
    t.attrSet("data-verified", ok ? "true" : "false");
  }
  return {
    html: md.renderer.render(tokens, md.options, {}),
    anchors: anchors.map((a) => ({ id: a.id, type: a.type, verified: verdicts.get(a.id) === true })),
    unmatched,
    unverified,
  };
}

/** The anchors line under a rendering: `20 blocks anchored` / `18 of 20 blocks anchored (2 unverified)`. */
export function anchorsSummary(r: Pick<Rendered, "anchors" | "unmatched" | "unverified">): string | null {
  const total = r.anchors.length + r.unmatched;
  if (total === 0) return null;
  const head = r.unmatched === 0 ? `${total} block${total === 1 ? "" : "s"} anchored` : `${r.anchors.length} of ${total} blocks anchored`;
  return r.unverified > 0 ? `${head} (${r.unverified} unverified)` : head;
}
