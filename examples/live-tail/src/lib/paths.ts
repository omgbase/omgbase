// Paths, the hit envelope, the surface gate and the engine's NAMES (the subset
// of graph-ui's lib/paths.ts this demo needs). The demo speaks omgbase surface
// 5.0 (spec/surface §1.2, "underscore = engine"): every path the server returns
// is `/`-rooted (§1 "Paths"), a query hit is `{ _id, _path, ...projection }`
// (§1.4), the engine attributes are `_`-prefixed in the language (`_path`,
// `_title`, `_updated_at`; a bare name is the user's authored key; `$` belongs
// to OQX alone), and a `docs_*` tool addresses its document by `_id` or `_path`
// (§4 "Arguments"). A 3.x/4.x server spells the same names bare (`path`,
// `title`, `updated_at`; `{ id }`/`{ path }`): the connected server's version
// comes from the `version` tool's `specs.surface`, is checked once per
// connection (`surfaceProblem`: an older server gets a loud, friendly error)
// and picks the spelling (`namesFor`) everything the page GENERATES uses —
// what the page READS accepts both (`hitId`, lib/shapes.ts).

/** The surface major this demo is written against (the oldest it speaks). */
export const REQUIRED_SURFACE_MAJOR = 3;

/** The first surface whose engine names are `_`-prefixed (spec/surface 5.0 §1.2). */
export const UNDERSCORE_SURFACE_MAJOR = 5;

/** The spelling of the engine names the page generates — in a query, a tool
 * argument — for one surface family. */
export interface EngineNames {
  /** 5: "underscore = engine" (surface ≥ 5.0); 4: the bare 3.x/4.x names. */
  major: 4 | 5;
  id: "_id" | "id";
  path: "_path" | "path";
  /** The computed title attribute. */
  title: "_title" | "title";
  updated_at: "_updated_at" | "updated_at";
}

/** Surface 5.0 and later: the demo's native spelling. */
export const NAMES_5: EngineNames = { major: 5, id: "_id", path: "_path", title: "_title", updated_at: "_updated_at" };
/** Surface 3.0–4.x: the bare names (the older branch). */
export const NAMES_4: EngineNames = { major: 4, id: "id", path: "path", title: "title", updated_at: "updated_at" };

/** The names for a server's `specs.surface`: `_`-prefixed from 5.0, bare
 * before; the native (5.0) spelling while the surface is unknown. */
export function namesFor(surface: string | null): EngineNames {
  const major = surfaceMajor(surface);
  return major === null || major >= UNDERSCORE_SURFACE_MAJOR ? NAMES_5 : NAMES_4;
}

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

/** The first string among the keys, else null (a reader that takes both spellings). */
function firstString(hit: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = hit?.[k];
    if (typeof v === "string") return v;
  }
  return null;
}

/** A query hit's id (`_id`; `id` on a 4.x server), else null. */
export function hitId(hit: Record<string, unknown> | null | undefined): string | null {
  return firstString(hit, "_id", "id");
}

/** A query hit's document path as returned (`/`-rooted; `_path`, or `path` on a 4.x server), else null. */
export function hitPath(hit: Record<string, unknown> | null | undefined): string | null {
  return firstString(hit, "_path", "path");
}

const DOC_ID = /^d_[0-9a-z]{1,7}$/;

/** A document ref (an id or a path) as the argument a `docs_*` tool takes
 * (spec/surface §4 "Arguments"): `{ _id }` for a `d_…` id, `{ _path }`
 * otherwise — `docs_history`, `docs_diff_unified` and `docs_read_at` alike;
 * `{ id }` / `{ path }` under the 4.x names. */
export function docLocator(doc: string, names: EngineNames = NAMES_5): Record<string, string> {
  return DOC_ID.test(doc) ? { [names.id]: doc } : { [names.path]: doc };
}

/** The `/`-rooted form: exactly one leading slash. Idempotent. */
export function rooted(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}
