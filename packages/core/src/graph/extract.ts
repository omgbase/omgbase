// Edge extraction, extraction_version x2 (05 §2). A pure function of
// (block content, frontmatter). Produces edge descriptors; the store layer
// resolves targets to node ids and maintains intervals. No identity is
// inherited here — extraction is recomputed fresh at every revision.
//
// x2: code is not prose. `code_fence` blocks yield no edges, and inline code
// spans (`` `…` ``, any backtick-run length) are masked before scanning, so a
// backticked `[[wikilink]]` example, a placeholder `[t](/path)` in a fence, or
// a regex fragment with square brackets no longer mints a `references` edge
// (and links_stale no longer reports them as dangling). There is no persisted
// extraction version — an existing repo re-extracts a document the next time
// that document is ingested (checkpoint/observe/apply), not via rebuild-index.

export const EXTRACTION_VERSION = "x2";

export type DstKind = "document" | "block" | "external" | "collection";
export type Provenance = "link" | "frontmatter" | "inline_field";

export interface ExtractedEdge {
  srcBlock: string | null; // null ⇒ frontmatter-origin
  srcField: string | null; // frontmatter key or inline-field key
  predicate: string; // 'references' | 'embeds' | freeform snake_case
  dstKind: DstKind;
  /** raw target string: a repo path, wikilink name, or URL (store resolves) */
  target: string;
  anchor: string | null; // #Heading or ^ref fragment
  provenance: Provenance;
}

// --- link/inline scanners (operate on a block's raw markdown) ----------------

const MD_LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g; // [t](dest) / ![alt](dest)
const WIKILINK = /(!?)\[\[([^\]]+)\]\]/g; // [[note]] / [[note#H]] / [[note^ref]]
const BARE_URL = /(?<![("[])\bhttps?:\/\/[^\s)>\]]+/g;
const AUTOLINK = /<(https?:\/\/[^>]+)>/g;
const INLINE_FIELD = /(?:^|\s)([a-z][a-z0-9_]*)::\s*(\[\[[^\]]+\]\]|\/[^\s]+|https?:\/\/[^\s]+)/gi;

function splitAnchor(target: string): { path: string; anchor: string | null; anchorKind: "heading" | "ref" | null } {
  const hashIdx = target.indexOf("#");
  const caretIdx = target.indexOf("^");
  if (caretIdx >= 0 && (hashIdx < 0 || caretIdx < hashIdx)) {
    return { path: target.slice(0, caretIdx), anchor: target.slice(caretIdx + 1), anchorKind: "ref" };
  }
  if (hashIdx >= 0) {
    return { path: target.slice(0, hashIdx), anchor: target.slice(hashIdx + 1), anchorKind: "heading" };
  }
  return { path: target, anchor: null, anchorKind: null };
}

function isExternal(dest: string): boolean {
  return /^https?:\/\//.test(dest) || /^[a-z][a-z0-9+.-]*:/i.test(dest) === true && !dest.startsWith("/");
}

function classifyTarget(dest: string): { dstKind: DstKind; target: string; anchor: string | null } {
  if (/^https?:\/\//.test(dest)) return { dstKind: "external", target: normalizeUri(dest), anchor: null };
  const { path, anchor, anchorKind } = splitAnchor(dest);
  // A pure fragment link (#H or ^ref) with empty path targets the same doc; we
  // still emit a document edge with the anchor (store resolves to self).
  const dstKind: DstKind = anchorKind === "ref" ? "block" : "document";
  return { dstKind, target: path, anchor };
}

export function normalizeUri(uri: string): string {
  try {
    const u = new URL(uri);
    u.hash = "";
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return uri;
  }
}

// --- code masking -------------------------------------------------------------

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

// Blank out every non-newline character of `s` so offsets are preserved (node
// projection records spans into the ORIGINAL raw; a length-preserving mask keeps
// those spans valid).
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/**
 * Mask code in a block's raw markdown — fenced code (``` / ~~~, incl. the fence
 * lines, closed by a same-char fence at least as long, or running to the end)
 * and inline code spans (a backtick run of length n closed by the next run of
 * EXACTLY n; an unmatched run stays literal, per CommonMark). Length-preserving:
 * masked characters become spaces, newlines are kept. Container blocks (list,
 * list_item, blockquote) carry their children's raw, so a fence nested in a
 * list item is masked here too. Shared by edge extraction and md:* node
 * projection so nodes and edges agree on what counts as a link.
 */
export function maskCode(raw: string): string {
  if (!raw.includes("`") && !raw.includes("~~~")) return raw;

  // 1. Fenced code blocks, line by line.
  const lines = raw.split("\n");
  let open: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open) {
      const m = FENCE_CLOSE.exec(line);
      lines[i] = blank(line);
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len) open = null;
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    if (m) {
      const fence = m[1]!;
      // A backtick fence's info string may not contain a backtick.
      if (fence[0] === "`" && line.slice(m[0].length).includes("`")) continue;
      open = { ch: fence[0]!, len: fence.length };
      lines[i] = blank(line);
    }
  }
  let out = lines.join("\n");

  // 2. Inline code spans over what remains.
  let i = 0;
  while (i < out.length) {
    if (out[i] !== "`") { i++; continue; }
    let j = i;
    while (j < out.length && out[j] === "`") j++;
    const n = j - i;
    // Find the next backtick run of exactly n.
    let k = j;
    let close = -1;
    while (k < out.length) {
      if (out[k] !== "`") { k++; continue; }
      let e = k;
      while (e < out.length && out[e] === "`") e++;
      if (e - k === n) { close = k; break; }
      k = e;
    }
    if (close < 0) { i = j; continue; }
    out = out.slice(0, i) + blank(out.slice(i, close + n)) + out.slice(close + n);
    i = close + n;
  }
  return out;
}

/** Extract edges from a single block's raw markdown. Code is skipped: a
 *  `code_fence` block yields nothing, and inline code spans are masked. */
export function extractFromBlock(blockId: string, blockType: string, rawInput: string): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
  if (blockType === "code_fence") return edges;
  const raw = maskCode(rawInput);
  const seen = new Set<string>();
  const push = (e: ExtractedEdge): void => {
    const k = `${e.predicate}|${e.target}|${e.anchor ?? ""}|${e.srcField ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(e);
  };

  // Inline fields first (so their targets aren't double-counted as plain links).
  const inlineTargets = new Set<string>();
  for (const m of raw.matchAll(INLINE_FIELD)) {
    const key = m[1]!.toLowerCase();
    const rawTarget = m[2]!;
    inlineTargets.add(rawTarget);
    const wl = /^\[\[([^\]]+)\]\]$/.exec(rawTarget);
    const dest = wl ? wl[1]! : rawTarget;
    const c = classifyTarget(dest);
    push({ srcBlock: blockId, srcField: key, predicate: key, dstKind: c.dstKind, target: c.target, anchor: c.anchor, provenance: "inline_field" });
  }

  // Markdown links and images.
  for (const m of raw.matchAll(MD_LINK)) {
    const isImg = m[1] === "!";
    const dest = m[2]!;
    if (inlineTargets.has(dest)) continue;
    const c = classifyTarget(dest);
    push({ srcBlock: blockId, srcField: null, predicate: isImg ? "embeds" : "references", dstKind: c.dstKind, target: c.target, anchor: c.anchor, provenance: "link" });
  }

  // Wikilinks.
  for (const m of raw.matchAll(WIKILINK)) {
    const isImg = m[1] === "!";
    const inner = m[2]!;
    if (inlineTargets.has(`[[${inner}]]`)) continue;
    const c = classifyTarget(inner);
    push({ srcBlock: blockId, srcField: null, predicate: isImg ? "embeds" : "references", dstKind: c.dstKind, target: c.target, anchor: c.anchor, provenance: "link" });
  }

  // Autolinks + bare URLs → external.
  for (const m of raw.matchAll(AUTOLINK)) push({ srcBlock: blockId, srcField: null, predicate: "references", dstKind: "external", target: normalizeUri(m[1]!), anchor: null, provenance: "link" });
  for (const m of raw.matchAll(BARE_URL)) push({ srcBlock: blockId, srcField: null, predicate: "references", dstKind: "external", target: normalizeUri(m[0]), anchor: null, provenance: "link" });

  void isExternal;
  return edges;
}

// --- frontmatter relation fields --------------------------------------------

// Repo-path or wikilink values under a frontmatter key → doc-grain edges.
export function extractFromFrontmatter(fm: Record<string, unknown>): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
  const consider = (key: string, value: unknown): void => {
    if (typeof value !== "string") return;
    let dest: string | null = null;
    const wl = /^\[\[([^\]]+)\]\]$/.exec(value);
    if (wl) dest = wl[1]!;
    else if (value.startsWith("/")) dest = value;
    if (!dest) return;
    const c = classifyTarget(dest);
    edges.push({ srcBlock: null, srcField: key, predicate: key, dstKind: c.dstKind, target: c.target, anchor: c.anchor, provenance: "frontmatter" });
  };
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) for (const v of value) consider(key, v);
    else consider(key, value);
  }
  return edges;
}
