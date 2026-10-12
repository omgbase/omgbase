// Paths, the hit envelope and the surface gate. The demo speaks omgbase surface
// 3.0 (spec/surface): every path a tool returns is `/`-rooted and every path a
// tool accepts tolerates both forms (§1 "Paths"); a query hit is `{ id, path,
// ...projection }` (§1.4) and a row surfacing as a value is `{ id, path }`;
// every engine attribute is a bare name in the language (§1.2 — `path`, `id`,
// `title`, `updated_at`, … — `$` belongs to OQX alone); a `docs_*` tool
// addresses its document by `id` or `path` (§4 "Arguments"). The connected
// server's version comes from the `version` tool's `specs.surface`
// ("major.minor") and is checked once per connection (`surfaceProblem`): an
// older server gets a loud, friendly error instead of a silently empty graph.

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

/** The hit envelope's keys (spec/surface §1.4). Neither is a projectable
 * field: the row's identity is not a column. */
export const HIT_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["id", "path"]);

/** The engine attributes of a docs row (spec/surface §1.2): a bare name that is
 * one of these reads the engine's value, never an authored key of the same
 * name (that is `data.<k>`). */
export const DOC_ATTRIBUTES: ReadonlySet<string> = new Set(["id", "path", "raw", "hash", "updated_at", "title", "tags", "format"]);

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

/** A row surfacing as a VALUE in a result (spec/surface §1.4 "rows as
 * values": an empty `collect { }` / `first { }`, a `$it` projection) — `{ id,
 * path }` — with the path rooted; null for anything that is not that shape (a
 * string reference, a record with other keys, a scalar). */
export function rowRef(v: unknown): { id: string; path: string } | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.every((k) => HIT_ENVELOPE_KEYS.has(k))) return null;
  const id = hitId(o);
  const path = hitPath(o);
  return id !== null && path !== null ? { id, path: rooted(path) } : null;
}

/** The `/`-rooted form: exactly one leading slash. Idempotent. */
export function rooted(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

/** The bare (storage) form: no leading slash. Idempotent. */
export function unrooted(path: string): string {
  return path.replace(/^\/+/, "");
}

/** The same document path, whichever form each side came in. */
export function samePath(a: string, b: string): boolean {
  return unrooted(a) === unrooted(b);
}

/** A document ref (an id or a path) as the argument a `docs_*` tool takes
 * (spec/surface §4 "Arguments"): `{ id }` for a `d_…` id, `{ path }` otherwise. */
export function docLocator(doc: string): Record<string, string> {
  return /^d_[0-9a-z]{1,7}$/.test(doc) ? { id: doc } : { path: doc };
}
