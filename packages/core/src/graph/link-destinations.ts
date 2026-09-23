// Link-destination awareness shared by the stale detector (link-health.ts) and
// the repair macro (mutate/macros.ts linksRepair). A "destination" is the exact
// authored target text of a link feature in a block's raw markdown:
//
//   [text](dest)  ![alt](dest)     Markdown link / image  → `dest`
//   [[dest]]  [[dest|alias]]        wikilink               → `dest` (alias kept aside)
//   key:: /dest                     inline field, bare repo path → `/dest`
//
// Inline code spans (`…`) are opaque: a link-shaped string inside backticks is
// prose about a link, not a link, so scanners skip them. Whole `code_fence`
// blocks are the caller's job to exclude (they are their own block type).
//
// The same regexes the edge extractor (extract.ts) and node projector
// (format/markdown.ts) use, so what this module rewrites is exactly what the
// edge index reports as a link.

/** Split an authored destination into its path part and its trailing fragment
 * (`#Heading` / `^ref`, fragment includes the marker). Mirrors extract.ts
 * splitAnchor: a `^` ref wins over a `#` heading when both appear. */
export function splitDestination(dest: string): { path: string; fragment: string } {
  const caret = dest.indexOf("^");
  if (caret >= 0) return { path: dest.slice(0, caret), fragment: dest.slice(caret) };
  const hash = dest.indexOf("#");
  if (hash >= 0) return { path: dest.slice(0, hash), fragment: dest.slice(hash) };
  return { path: dest, fragment: "" };
}

/** Canonical repo-relative path for a link path as authored in a doc living in
 * `docDir` ("" for the root, else "dir/sub/"): `./`/`../` resolve against the
 * doc's directory (mirroring sync/reconciling-ingest resolveRelativePath), and
 * the leading `/` (repo-root anchor) is dropped — this is the path the edge
 * index keys phantoms by. */
export function canonicalLinkPath(path: string, docDir = ""): string {
  if (path.startsWith("./") || path.startsWith("../")) {
    const out: string[] = [];
    for (const p of (docDir + path).split("/")) {
      if (p === "." || p === "") continue;
      if (p === "..") { out.pop(); continue; }
      out.push(p);
    }
    return out.join("/");
  }
  return path.replace(/^\//, "");
}

/** Directory prefix ("" or "a/b/") of a repo-relative doc path. */
export function docDirOf(docPath: string): string {
  const i = docPath.lastIndexOf("/");
  return i < 0 ? "" : docPath.slice(0, i + 1);
}

// Link-feature scanners. Each captures (prefix, dest, suffix) so a rewrite can
// splice a new destination in place and leave everything else byte-identical.
const MD_LINK = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
const WIKILINK = /(!?\[\[)([^\]|]+)((?:\|[^\]]*)?\]\])/g;
const INLINE_FIELD_PATH = /((?:^|\s)[a-z][a-z0-9_]*::[ \t]*)(\/[^\s]+)()/gi;
// Inline code: a backtick run closed by an identical run (CommonMark code span).
const CODE_SPAN = /(`+)[^`][\s\S]*?\1/g;

/**
 * Rewrite link destinations in a block's raw markdown. `replace(dest)` is called
 * once per link feature found outside inline code; it returns the new
 * destination text, or null to leave that link untouched. Bytes outside link
 * destinations are never changed.
 */
export function rewriteLinkDestinations(raw: string, replace: (dest: string) => string | null): string {
  const rewriteSegment = (seg: string): string => {
    const sub = (re: RegExp) => (s: string): string =>
      s.replace(re, (whole: string, pre: string, dest: string, post: string) => {
        const next = replace(dest);
        return next === null ? whole : pre + next + post;
      });
    return sub(INLINE_FIELD_PATH)(sub(WIKILINK)(sub(MD_LINK)(seg)));
  };
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(CODE_SPAN)) {
    const start = m.index ?? 0;
    out += rewriteSegment(raw.slice(last, start)) + m[0];
    last = start + m[0].length;
  }
  return out + rewriteSegment(raw.slice(last));
}
