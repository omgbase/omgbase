// Paths, the hit envelope and the surface gate (the subset of graph-ui's
// lib/paths.ts this demo needs). The demo speaks omgbase surface 3.0
// (spec/surface): every path the server returns is `/`-rooted (§1 "Paths"), a
// query hit is `{ id, path, ...projection }` (§1.4), the engine attributes are
// bare names in the language (§1.2 — `path`, `title`, `updated_at`; `$`
// belongs to OQX alone), and a `docs_*` tool addresses its document by `id` or
// `path` (§4 "Arguments"). The connected server's version comes from the
// `version` tool's `specs.surface` and is checked once per connection
// (`surfaceProblem`): an older server gets a loud, friendly error.

/** The surface major this demo is written against. */
export const REQUIRED_SURFACE_MAJOR = 3;

/** The `version` tool's `specs.surface` ("major.minor"), or null when the
 * result does not carry one (no `version` tool, a gateway hiding it, an error body). */
export function surfaceOf(versionResult: unknown): string | null {
  const surface = (versionResult as { specs?: { surface?: unknown } } | null | undefined)?.specs?.surface;
  return typeof surface === "string" && /^\d+\.\d+$/.test(surface) ? surface : null;
}

/** The major number of a `"major.minor"` surface; null for anything else (including null). */
export function surfaceMajor(surface: string | null): number | null {
  const m = surface === null ? null : /^(\d+)\.\d+$/.exec(surface);
  return m ? Number(m[1]) : null;
}

/** Null when the server speaks a surface this demo understands (≥ 3.0); else
 * the message to show instead of connecting. */
export function surfaceProblem(surface: string | null): string | null {
  const major = surfaceMajor(surface);
  if (major !== null && major >= REQUIRED_SURFACE_MAJOR) return null;
  return `this demo needs omgbase surface ≥ ${REQUIRED_SURFACE_MAJOR}.0 — the server reports ${surface ?? "no surface version (no `version` tool)"}`;
}

/** A query hit's id, else null. */
export function hitId(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.id;
  return typeof v === "string" ? v : null;
}

/** A query hit's document path as returned (`/`-rooted), else null. */
export function hitPath(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.path;
  return typeof v === "string" ? v : null;
}

const DOC_ID = /^d_[0-9a-z]{1,7}$/;

/** A document ref (an id or a path) as the argument a `docs_*` tool takes
 * (spec/surface §4 "Arguments"): `{ id }` for a `d_…` id, `{ path }` otherwise
 * — `docs_history`, `docs_diff_unified` and `docs_read_at` alike. */
export function docLocator(doc: string): Record<string, string> {
  return DOC_ID.test(doc) ? { id: doc } : { path: doc };
}

/** The `/`-rooted form: exactly one leading slash. Idempotent. */
export function rooted(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}
