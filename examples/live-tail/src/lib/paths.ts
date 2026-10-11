// Path and hit-envelope forms across surface versions (the subset of
// graph-ui's lib/paths.ts this demo needs). Since surface 2.0 every path the
// server returns is `/`-rooted (spec/surface §1 "Paths"); since 3.0 a query
// hit is `{ $id, $path, ...projection }` where 2.x spelled `{ id, path }`
// (§1.4), and every other tool result spells a row the same way (lib/shapes.ts
// reads those by the server's version). The server a user points this page at
// may be either, so a hit's identity is read through `hitId`/`hitPath`, never
// `.id`/`.path`. Projected keys (`$title`, `$updated_at`) are spelled the same
// under both.

/** What a server without a `version` tool is taken to be. */
export const LEGACY_SURFACE = "1.x";

/** The `version` tool's `specs.surface` ("major.minor"), else `LEGACY_SURFACE`. */
export function surfaceOf(versionResult: unknown): string {
  const surface = (versionResult as { specs?: { surface?: unknown } } | null | undefined)?.specs?.surface;
  return typeof surface === "string" && /^\d+\.\d+$/.test(surface) ? surface : LEGACY_SURFACE;
}

/** The major version number of a `"major.minor"` surface, 1 for `LEGACY_SURFACE`
 * and anything unparsable, null when the version is not known yet. */
export function surfaceMajor(surface: string | null): number | null {
  if (surface === null) return null;
  const m = /^(\d+)\./.exec(surface);
  return m ? Number(m[1]) : 1;
}

/** A query hit's id: `$id` (surface ≥ 3.0) else `id` (1.x/2.x), else null. */
export function hitId(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.$id ?? hit?.id;
  return typeof v === "string" ? v : null;
}

/** A query hit's document path as returned: `$path` (≥ 3.0) else `path`, else null. */
export function hitPath(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.$path ?? hit?.path;
  return typeof v === "string" ? v : null;
}

/** The `/`-rooted form: exactly one leading slash. Idempotent. */
/** Does the server take the 3.0 argument names (`spec/surface` §4 "Arguments":
 * a `docs_*` tool addresses its document by `id` or `path`, a foreign
 * reference by `doc_id`/`doc_path`; `doc` is gone)? Before 3.0 every document
 * argument was `doc` (id-or-path). An unknown version is taken as 2.x. */
export function bareArguments(surface: string | null): boolean {
  return (surfaceMajor(surface) ?? 1) >= 3;
}

const DOC_ID = /^d_[0-9a-z]{1,7}$/;

/** A document ref (an id or a path) as the arguments a `docs_*` tool takes on
 * the connected server: `{ id }` / `{ path }` on ≥ 3.0, `{ doc }` before. */
export function docLocator(surface: string | null, doc: string): Record<string, string> {
  if (!bareArguments(surface)) return { doc };
  return DOC_ID.test(doc) ? { id: doc } : { path: doc };
}

/** The same document as a FOREIGN reference (`diff_unified`): `{ doc_id }` /
 * `{ doc_path }` on ≥ 3.0, `{ doc }` before. */
export function docForeign(surface: string | null, doc: string): Record<string, string> {
  if (!bareArguments(surface)) return { doc };
  return DOC_ID.test(doc) ? { doc_id: doc } : { doc_path: doc };
}

export function rooted(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}
