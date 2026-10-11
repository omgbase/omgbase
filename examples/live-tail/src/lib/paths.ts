// Path and attribute forms across surface versions (the subset of graph-ui's
// lib/paths.ts this demo needs). Since surface 2.0 every path the server
// returns is `/`-rooted (spec/surface §1 "Paths"). A query hit is `{ id, path,
// ...projection }` under every version (§1.4), so `hitId`/`hitPath` are
// version-free; what differs by version is the LANGUAGE: on a 3.0 server the
// engine attributes are bare (`path`, `title`, `updated_at` — §1.2; `$` belongs
// to OQX alone) where 2.x spelled them `$path`/`$title`/`$updated_at`, so every
// query this page generates goes through `attr`. The other tool results are
// read per version by lib/shapes.ts.

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

/** A query hit's id (`id` under every surface version), else null. */
export function hitId(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.id;
  return typeof v === "string" ? v : null;
}

/** A query hit's document path as returned (rooted since 2.0), else null. */
export function hitPath(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.path;
  return typeof v === "string" ? v : null;
}

/** Does the server spell the engine attributes bare in the language (surface
 * ≥ 3.0: `path`, `title`, `updated_at`), where 1.x/2.x had `$path`/`$title`/
 * `$updated_at`? An unknown version is taken as 2.x. */
export function bareAttributes(surface: string | null): boolean {
  return (surfaceMajor(surface) ?? 1) >= 3;
}

/** A document attribute as the connected server's language spells it:
 * `attr("3.0", "title")` → `title`, `attr("2.0", "title")` → `$title`. */
export function attr(surface: string | null, name: "id" | "path" | "title" | "updated_at"): string {
  return bareAttributes(surface) ? name : `$${name}`;
}

/** Does the server take the 3.0 argument names (`spec/surface` §4 "Arguments":
 * a `docs_*` tool addresses its document by `id` or `path`; `doc` is gone, and
 * no tool takes a foreign `doc_id`/`doc_path`)? Before 3.0 every document
 * argument was `doc` (id-or-path). An unknown version is taken as 2.x. */
export function bareArguments(surface: string | null): boolean {
  return (surfaceMajor(surface) ?? 1) >= 3;
}

const DOC_ID = /^d_[0-9a-z]{1,7}$/;

/** A document ref (an id or a path) as the arguments a `docs_*` tool takes on
 * the connected server: `{ id }` / `{ path }` on ≥ 3.0, `{ doc }` before. The
 * unified diff's document is one of these too (`docs_diff_unified { id? | path?
 * }` on 3.0, `diff_unified { doc }` before — `diffUnifiedTool`). */
export function docLocator(surface: string | null, doc: string): Record<string, string> {
  if (!bareArguments(surface)) return { doc };
  return DOC_ID.test(doc) ? { id: doc } : { path: doc };
}

/** The unified-diff tool's name on the connected server (spec/surface §3–§4):
 * `docs_diff_unified` on ≥ 3.0 — a `docs_*` tool, its document `id`/`path` —
 * and `diff_unified` before (its document `doc`). An unknown version is taken
 * as 2.x, like the arguments. */
export function diffUnifiedTool(surface: string | null): "docs_diff_unified" | "diff_unified" {
  return bareArguments(surface) ? "docs_diff_unified" : "diff_unified";
}

/** The `/`-rooted form: exactly one leading slash. Idempotent. */
export function rooted(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}
