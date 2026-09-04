// Edge extraction, extraction_version x1 (05 §2). A pure function of
// (block content, frontmatter). Produces edge descriptors; the store layer
// resolves targets to node ids and maintains intervals. No identity is
// inherited here — extraction is recomputed fresh at every revision.

export const EXTRACTION_VERSION = "x1";

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

/** Extract edges from a single block's raw markdown. */
export function extractFromBlock(blockId: string, blockType: string, raw: string): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
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

  void blockType; void isExternal;
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
