// Paths, the hit envelope and the surface gate (after graph-ui's lib/paths.ts;
// the subset this demo needs, plus a version gate). The demo speaks omgbase
// surface 5.0 (spec/surface, "underscore = engine"): every path the server
// returns is `/`-rooted (§1 "Paths"), a query hit is `{ _id, _path,
// ...projection }` (§1.4), the engine attributes are `_`-prefixed names in the
// language and the bare namespace is the user's (§1.2), a `docs_*` tool
// addresses its document by `_id` or `_path` (§4 "Arguments"; a bare `id`/`path`
// argument is refused), `revisions` is a query target and `docs_read` takes
// `at` (both 4.7). The connected server's version comes from the `version`
// tool's `specs.surface` and is checked once per connection (`surfaceProblem`):
// an older server gets a loud, friendly error instead of empty panes.

/** The surface this demo is written against: the `_`-prefixed engine names and
 * the `_id`/`_path` arguments arrived in 5.0 (`revisions` and `docs_read { at }`
 * in 4.7). A 5.0 client cannot address rows on a 4.x server — its bare `path`
 * arguments are gone and `_path` is unknown there — so the gate is a major. */
export const REQUIRED_SURFACE = "5.0";

/** The `version` tool's `specs.surface` ("major.minor"), or null when the
 * result does not carry one (no `version` tool, a gateway hiding it, an error body). */
export function surfaceOf(versionResult: unknown): string | null {
  const surface = (versionResult as { specs?: { surface?: unknown } } | null | undefined)?.specs?.surface;
  return typeof surface === "string" && /^\d+\.\d+$/.test(surface) ? surface : null;
}

/** The `version` tool's `profile` ("full" | "minimal", 4.3), or null when absent. */
export function profileOf(versionResult: unknown): string | null {
  const profile = (versionResult as { profile?: unknown } | null | undefined)?.profile;
  return typeof profile === "string" ? profile : null;
}

/** `"major.minor"` → `[major, minor]`, null for anything else. */
export function surfaceParts(surface: string | null): [number, number] | null {
  const m = surface === null ? null : /^(\d+)\.(\d+)$/.exec(surface);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Is `surface` at least `required` (major first, then minor)? False for an unreadable surface. */
export function surfaceAtLeast(surface: string | null, required: string = REQUIRED_SURFACE): boolean {
  const a = surfaceParts(surface);
  const b = surfaceParts(required);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}

/** Null when the server speaks a surface this demo understands (≥ 5.0); else
 * the message to show instead of connecting. */
export function surfaceProblem(surface: string | null): string | null {
  if (surfaceAtLeast(surface)) return null;
  return `this demo needs omgbase surface ≥ ${REQUIRED_SURFACE} (the underscore engine names: _id/_path arguments, _title, _doc_id, …) — the server reports ${surface ?? "no surface version (no `version` tool)"}`;
}

/** A query hit's `_id` (the envelope, spec/surface §1.4), else null. */
export function hitId(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?._id;
  return typeof v === "string" ? v : null;
}

/** A query hit's `_path` as returned (`/`-rooted), else null. */
export function hitPath(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?._path;
  return typeof v === "string" ? v : null;
}

const DOC_ID = /^d_[0-9a-z]{1,7}$/;

/** A document ref (an id or a path) as the argument a `docs_*` tool takes
 * (spec/surface §4 "Arguments", 5.0): `{ _id }` for a `d_…` id, `{ _path }` otherwise. */
export function docLocator(doc: string): Record<string, string> {
  return DOC_ID.test(doc) ? { _id: doc } : { _path: doc };
}

/** The `/`-rooted form: exactly one leading slash. Idempotent. */
export function rooted(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

/** The bare (storage) form: no leading slash. Idempotent. */
export function unrooted(path: string): string {
  return path.replace(/^\/+/, "");
}

/** The directory prefix of a rooted document path, rooted and `/`-terminated (`/a/b.md` → `/a/`; `/x.md` → `/`). */
export function dirOf(path: string): string {
  const p = rooted(path);
  const i = p.lastIndexOf("/");
  return p.slice(0, i + 1);
}

/** The last segment of a path (`/a/b.md` → `b.md`; a `dir` entry `/a/b/` → `b`). */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Every directory prefix above a rooted path, root first (`/a/b/c.md` → `/`, `/a/`, `/a/b/`). */
export function ancestorsOf(path: string): string[] {
  const dir = dirOf(path);
  const out = ["/"];
  let acc = "/";
  for (const seg of dir.split("/").filter(Boolean)) {
    acc += `${seg}/`;
    out.push(acc);
  }
  return out;
}

/** Which kind of row an omgbase id names, by prefix; null for anything else. */
export function idKind(value: string): "doc" | "block" | "node" | "link" | "revision" | "commit" | null {
  const m = /^([dbnerc])_[0-9a-z]{1,8}$/.exec(value);
  if (!m) return null;
  return ({ d: "doc", b: "block", n: "node", e: "link", r: "revision", c: "commit" } as const)[m[1] as "d" | "b" | "n" | "e" | "r" | "c"];
}
