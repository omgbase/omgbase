// Paths, the hit envelope, the surface gate and the engine's NAMES. The demo
// speaks omgbase surface 5.0 (spec/surface §1.2, "underscore = engine"): every
// path a tool returns is `/`-rooted and every path a tool accepts tolerates
// both forms (§1 "Paths"); a query hit is `{ _id, _path, ...projection }`
// (§1.4) and a row surfacing as a value is `{ _id, _path }`; every engine
// attribute is `_`-prefixed in the language (`_path`, `_id`, `_title`,
// `_updated_at`, … — a bare name is the user's authored key; `$` belongs to
// OQX alone); a `docs_*` tool addresses its document by `_id` or `_path` (§4
// "Arguments"). A 3.x/4.x server spells the same names bare (`path`, `title`,
// `updated_at`; `{ id }`/`{ path }`; `doc.out_links` for the link rows). The
// connected server's version comes from the `version` tool's `specs.surface`
// ("major.minor") and is checked once per connection (`surfaceProblem`: an
// older server gets a loud, friendly error instead of a silently empty graph);
// it also picks the spelling (`namesFor`) everything the page GENERATES uses —
// the preset queries, the edge queries, the document arguments, the builtin
// candidate names — while what the page READS and CLASSIFIES accepts both
// (`hitId`, `rowRef`, `isEngineAttribute`, lib/shapes.ts).

/** The surface major this demo is written against (the oldest it speaks). */
export const REQUIRED_SURFACE_MAJOR = 3;

/** The first surface whose engine names are `_`-prefixed (spec/surface 5.0 §1.2). */
export const UNDERSCORE_SURFACE_MAJOR = 5;

/** The spelling of the engine names the page generates — in a query, a tool
 * argument, a candidate's name — for one surface family. */
export interface EngineNames {
  /** 5: "underscore = engine" (surface ≥ 5.0); 4: the bare 3.x/4.x names. */
  major: 4 | 5;
  id: "_id" | "id";
  path: "_path" | "path";
  /** The computed title attribute. */
  title: "_title" | "title";
  updated_at: "_updated_at" | "updated_at";
  /** A link row's attributes (the `links` collection). */
  dst_path: "_dst_path" | "dst_path";
  field: "_field" | "field";
  provenance: "_provenance" | "provenance";
  dst_kind: "_dst_kind" | "dst_kind";
  /** The source block of a body link (null on a frontmatter link). */
  block_id: "_block_id" | "block_id";
  /** A document's link relations, and a link's reach-throughs. */
  out_links: "_out_links" | "out_links";
  in_links: "_in_links" | "in_links";
  /** A link's destination document. */
  dst: "_dst" | "dst";
  /** A link's source document (4.x: also the document's self alias). */
  doc: "_doc" | "doc";
  /** How the builtin link-graph candidates are named (lib/candidates.ts rule 4):
   * the relation on the document — `_out_links` / `_in_links` on 5.0 (`$it`
   * is the self; a bare `doc` is an authored key), `doc.out_links` /
   * `doc.in_links` under the 4.x names. */
  builtinLinks: string;
  builtinBacklinks: string;
}

/** Surface 5.0 and later: the demo's native spelling. */
export const NAMES_5: EngineNames = {
  major: 5,
  id: "_id", path: "_path", title: "_title", updated_at: "_updated_at",
  dst_path: "_dst_path", field: "_field", provenance: "_provenance", dst_kind: "_dst_kind", block_id: "_block_id",
  out_links: "_out_links", in_links: "_in_links", dst: "_dst", doc: "_doc",
  builtinLinks: "_out_links", builtinBacklinks: "_in_links",
};
/** Surface 3.0–4.x: the bare names (the older branch). */
export const NAMES_4: EngineNames = {
  major: 4,
  id: "id", path: "path", title: "title", updated_at: "updated_at",
  dst_path: "dst_path", field: "field", provenance: "provenance", dst_kind: "dst_kind", block_id: "block_id",
  out_links: "out_links", in_links: "in_links", dst: "dst", doc: "doc",
  builtinLinks: "doc.out_links", builtinBacklinks: "doc.in_links",
};

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
  return `this demo needs omgbase surface ≥ ${REQUIRED_SURFACE_MAJOR}.0 — the server reports ${surface ?? "no surface version (no \`version\` tool)"}`;
}

/** The hit envelope's keys (spec/surface §1.4) in both spellings — `_id`/`_path`,
 * and a 4.x server's `id`/`path`. None is a projectable field: the row's
 * identity is not a column. */
export const HIT_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["_id", "_path", "id", "path"]);

/** The engine attributes of a docs row under the 4.x names (spec/surface 4.x
 * §1.2): a bare name that is one of these read the engine's value there. On 5.0
 * the rule is the prefix — every `_`-name is the engine's and every bare name
 * is authored — so `isEngineAttribute` is the question to ask. */
export const DOC_ATTRIBUTES: ReadonlySet<string> = new Set(["id", "path", "raw", "hash", "updated_at", "title", "tags", "format"]);

/** Is `name` an engine attribute rather than an authored key, in either
 * spelling: a `_`-prefixed name (5.0 — the whole engine namespace), or one of
 * the bare 4.x docs attributes? (`$`-names are OQX's own and are judged by the
 * caller.) A 5.0 user projecting an authored bare `title` is thus read as the
 * attribute too — the price of serving both surfaces with one classifier. */
export function isEngineAttribute(name: string): boolean {
  return name.startsWith("_") || DOC_ATTRIBUTES.has(name);
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

/** A row surfacing as a VALUE in a result (spec/surface §1.4 "rows as
 * values": an empty `collect { }` / `first { }`, a `$it` projection) — `{ _id,
 * _path }` (a 4.x server's `{ id, path }`) — with the path rooted; null for
 * anything that is not that shape (a string reference, a record with other
 * keys, a scalar). */
export function rowRef(v: unknown): { id: string; path: string } | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const envelope = (keys.length === 2 && keys[0] === "_id" && keys[1] === "_path") || (keys.length === 2 && keys[0] === "id" && keys[1] === "path");
  if (!envelope) return null;
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
 * (spec/surface §4 "Arguments"): `{ _id }` for a `d_…` id, `{ _path }`
 * otherwise — `{ id }` / `{ path }` under the 4.x names. */
export function docLocator(doc: string, names: EngineNames = NAMES_5): Record<string, string> {
  return /^d_[0-9a-z]{1,7}$/.test(doc) ? { [names.id]: doc } : { [names.path]: doc };
}
