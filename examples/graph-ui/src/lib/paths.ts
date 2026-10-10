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
//   - a tool's `doc` argument (an id or a path): 1.x wants the bare path, 2.0
//     accepts both → `docArg` (ids pass through untouched);
//   - correlating the current row with an authored reference (frontmatter
//     values are `/`-rooted in the repositories this demo is aimed at, whatever
//     the server version): `"/" + ^$path` on 1.x, plain `^$path` on 2.0 →
//     `pathExpr`;
//   - the keyset cursor changed shape and a 1.x cursor is refused by 2.0; the
//     demo never stores one (`OmgClient.queryAll` follows the cursor within one
//     call), so there is nothing to drop on a version change.
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
