// Path forms across surface versions — THE adapter. Everything in the demo that
// builds a query with a path, hands a path to a tool, or compares two paths
// goes through here, so the page works against a surface-1.x server (Brendan's
// remote gateway: `$path` is the storage form, `timeline/kickoff.md`) and a
// surface-2.0 one (the local build: every returned path is `/`-rooted and every
// accepted path tolerates both forms — spec/surface §1 "Paths").
//
// What differs for the demo, by server version:
//   - returned paths (`$path`, `$dst_path`, a hit's `path`): bare on 1.x, rooted
//     on 2.0 → the demo keys its nodes by the ROOTED form everywhere (`rooted`),
//     so a 1.x hit and a 2.0 hit for one document share a key, and compares
//     paths modulo the slash (`samePath`);
//   - a `$path == "…"` literal: must be bare on 1.x; on 2.0 both forms match
//     (the literal is rooted before evaluation) and the rooted one is the
//     spelling → `serverPath`;
//   - a tool's document argument: 3.0 spells it `id` / `path` (`doc_id` /
//     `doc_path` from `diff`), earlier servers take `doc` (id-or-path; 1.x
//     wants the bare path) → `docLocator` / `docForeign` over `docArg`;
//   - correlating the current row with an authored reference (frontmatter
//     values are `/`-rooted in the repositories this demo is aimed at, whatever
//     the server version): `"/" + ^$path` on 1.x, plain `^$path` on 2.0 →
//     `pathExpr`;
//   - the keyset cursor changed shape and a 1.x cursor is refused by 2.0; the
//     demo never stores one (`OmgClient.queryAll` follows the cursor within one
//     call), so there is nothing to drop on a version change;
//   - the HIT ENVELOPE renamed its keys in 3.0 (spec/surface §1.4): a hit is
//     `{ $id, $path, ...projection }` — the intrinsics' own spellings, so a key
//     copied from a hit pastes into the next `where` — where 1.x/2.x spelled
//     `{ id, path }`; a row surfacing as a VALUE (an empty `collect { }`)
//     follows the same rename. Brendan's remote may lag the local build, so
//     the demo reads a hit's identity through `hitId`/`hitPath`/`rowRef`,
//     which accept both shapes (`$id` first), and never through `.id`/`.path`.
//
// The version comes from the `version` MCP tool's `specs.surface` ("major.minor",
// surface ≥ 1.4); a server without the tool is treated as 1.x (`surfaceOf`).

/** What a server without a `version` tool is taken to be. */
export const LEGACY_SURFACE = "1.x";

/** The `version` tool's `specs.surface`, or `LEGACY_SURFACE` when the result
 * does not carry a `"major.minor"` string (an older server, a gateway that
 * hides the tool, an error body). */
export function surfaceOf(versionResult: unknown): string {
  const specs = (versionResult as { specs?: { surface?: unknown } } | null | undefined)?.specs;
  const surface = specs?.surface;
  return typeof surface === "string" && /^\d+\.\d+$/.test(surface) ? surface : LEGACY_SURFACE;
}

/** The major version number of a `"major.minor"` surface, 1 for `LEGACY_SURFACE`
 * and anything unparsable, null when the version is not known yet. */
export function surfaceMajor(surface: string | null): number | null {
  if (surface === null) return null;
  const m = /^(\d+)\./.exec(surface);
  return m ? Number(m[1]) : 1;
}

/** Does the server return `/`-rooted paths (surface ≥ 2.0)? An unknown version
 * (`null`, not connected yet) is treated as 1.x — the conservative form, since
 * a 2.0 server accepts it everywhere. */
export function rootsPaths(surface: string | null): boolean {
  return (surfaceMajor(surface) ?? 1) >= 2;
}

/** The hit envelope's keys under both surface generations: `$id`/`$path` on
 * ≥ 3.0, `id`/`path` before. Neither spelling is a projectable field. */
export const HIT_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["$id", "$path", "id", "path"]);

/** A query hit's id: `$id` (surface ≥ 3.0) else `id` (1.x/2.x), else null. */
export function hitId(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.$id ?? hit?.id;
  return typeof v === "string" ? v : null;
}

/** A query hit's document path AS RETURNED (bare on 1.x, rooted since 2.0):
 * `$path` (surface ≥ 3.0) else `path` (1.x/2.x), else null. Callers that key
 * nodes root it (`rooted`). */
export function hitPath(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.$path ?? hit?.path;
  return typeof v === "string" ? v : null;
}

/** A row surfacing as a VALUE in a result (spec/surface §1.4 "rows as
 * values": an empty `collect { }` / `first { }`, a `$it` projection) — `{ $id,
 * $path }` on ≥ 3.0, `{ id, path }` before — as `{ id, path }` with the path
 * rooted; null for anything that is not that shape (a string reference, a
 * record with other keys, a scalar). */
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

/** The OQX fragment that yields the ROOTED path of the row `ref` names
 * (`$path`, `^$path`, `^^$dst_path`, …): the intrinsic itself on 2.0, `"/" +`
 * the intrinsic before — so it can be compared with an authored reference. */
export function pathExpr(surface: string | null, ref = "$path"): string {
  return rootsPaths(surface) ? ref : `"/" + ${ref}`;
}

/** `pathExpr` as an operand: parenthesized when it is a `+` (so `… in list(x)`
 * and `… == x` bind the way they read). */
export function pathOperand(surface: string | null, ref = "$path"): string {
  const expr = pathExpr(surface, ref);
  return expr === ref ? expr : `(${expr})`;
}

/** A path in the form the server expects in a `$path == "…"` / `$dst_path ==
 * "…"` literal and renders in its results: bare on 1.x, rooted on 2.0. */
export function serverPath(surface: string | null, path: string): string {
  return rootsPaths(surface) ? rooted(path) : unrooted(path);
}

/** A tool's `doc` argument — an id (`d_…`) or a path — in a form the server
 * accepts: ids pass through; a path is bare for 1.x and left as given (either
 * form is accepted) for 2.0. */
export function docArg(surface: string | null, doc: string): string {
  if (rootsPaths(surface) || !doc.includes("/")) return doc;
  return unrooted(doc);
}

/** Does the server take the 3.0 argument names (`spec/surface` §4 "Arguments":
 * a `docs_*` tool addresses its document by `id` or `path`, a foreign
 * reference by `doc_id`/`doc_path`; `doc` is gone)? Before 3.0 every document
 * argument was `doc` (id-or-path). An unknown version is taken as 2.x. */
export function bareArguments(surface: string | null): boolean {
  return (surfaceMajor(surface) ?? 1) >= 3;
}

/** A document ref (an id or a path) as the arguments a `docs_*` tool takes on
 * the connected server: `{ id }` / `{ path }` on ≥ 3.0, `{ doc }` before (the
 * path de-rooted for 1.x, `docArg`). */
export function docLocator(surface: string | null, doc: string): Record<string, string> {
  if (!bareArguments(surface)) return { doc: docArg(surface, doc) };
  return /^d_[0-9a-z]{1,7}$/.test(doc) ? { id: doc } : { path: doc };
}

/** The same document as a FOREIGN reference (`diff`, `diff_unified`):
 * `{ doc_id }` / `{ doc_path }` on ≥ 3.0, `{ doc }` before. */
export function docForeign(surface: string | null, doc: string): Record<string, string> {
  if (!bareArguments(surface)) return { doc: docArg(surface, doc) };
  return /^d_[0-9a-z]{1,7}$/.test(doc) ? { doc_id: doc } : { doc_path: doc };
}

