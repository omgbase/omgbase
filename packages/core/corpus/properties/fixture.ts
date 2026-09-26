// Fixture bridge for spec/properties (README §7). Pure pieces, no vitest:
//
//   runCase()               a case's `source` → the §7 `expect` (rows, grouped, merged) through the
//                           real ingest into a `:memory:` store, plus the runner checks' findings
//   projectRows()           the `properties` rows of a document → sorted fixture rows (§7 "Expect")
//   checkRows()             the §7 runner checks: prop_id derivation, uniqueness, block_id sanity
//   encodeNonFinite()       ±Infinity / NaN → the strings the fixtures carry (§8)
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about properties; it drives the same code path
// production uses (`ingestFile`) with the fixture minter installed and
// re-expresses the resulting rows so the two implementations can be compared.
import { createHash } from "node:crypto";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { ingestFile } from "../../src/core/ingest.js";
import { sequentialMinter, withIdMinter } from "../../src/core/ids.js";
import { docPropertiesGrouped, docPropertiesMerged } from "../../src/core/store/properties.js";
import { deepEqualTol } from "../reconcile/fixture.js";

export { deepEqualTol };

// ---- fixture shapes ------------------------------------------------------------

export type Source = "frontmatter" | "inline" | "computed";

/** A `val_num` as the fixture carries it: a JSON number, or one of the non-finite spellings (§8). */
export type FixtureNum = number | "Infinity" | "-Infinity" | "NaN";

/** README §1 `PropertyRow`, `val_json` decoded (§7 "Expect"). Exactly these eleven fields. */
export interface FixtureRow {
  prop_id: string;
  block_id: string | null;
  source: Source;
  key: string;
  card: "scalar" | "list";
  ord: number;
  type: "string" | "number" | "bool" | "null" | "json";
  val_text: string | null;
  val_num: FixtureNum | null;
  val_bool: 0 | 1 | null;
  val_json: unknown;
}

export const ROW_FIELDS = [
  "prop_id", "block_id", "source", "key", "card", "ord", "type", "val_text", "val_num", "val_bool", "val_json",
] as const;

export interface FixtureExpect {
  rows: FixtureRow[];
  grouped: Record<Source, Record<string, unknown>>;
  merged: Record<string, unknown>;
}

export interface FixtureCase {
  name: string;
  notes?: string;
  /** the exact document (§7 "Inputs") */
  source: string;
  expect: FixtureExpect;
}

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export const CASE_KEYS = ["name", "notes", "source", "expect"] as const;
export const SOURCES: readonly Source[] = ["frontmatter", "inline", "computed"];

/** README §7 "Inputs": the repo, path and document id every case runs as. */
export const FIXTURE_REPO_SLUG = "fixture";
export const FIXTURE_PATH = "a.md";
export const FIXTURE_DOC_ID = "d_0";

const SOURCE_RANK: Record<Source, number> = { frontmatter: 0, inline: 1, computed: 2 };

// ---- helpers ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Bytewise (UTF-8) string order — the `key` order of §7. */
export function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** README §1: `"p_" + first 12 hex chars of sha256(doc_id + "|" + source + "|" + key + "|" + ord)`. */
export function derivePropId(docId: string, source: string, key: string, ord: number): string {
  return "p_" + createHash("sha256").update(`${docId}|${source}|${key}|${ord}`, "utf8").digest("hex").slice(0, 12);
}

/**
 * §8 non-finite numbers as the fixtures spell them. `val_num` is stored as a
 * SQLite REAL: better-sqlite3 binds ±Infinity as ±Inf (read back as ±Infinity)
 * and NaN as NULL — so a `type = number` row with a NULL `val_num` is NaN.
 */
export function encodeNonFinite(v: number): FixtureNum {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return v;
}

/**
 * The read shapes (§5) hold decoded JavaScript values; JSON cannot carry
 * ±Infinity, so a non-finite number is replaced by its §8 spelling wherever it
 * sits. (NaN never reaches a shape: the reference decodes a `number` row from
 * `val_num`, which SQLite holds as NULL — so NaN reads as `null`.)
 */
export function encodeShape(v: unknown): unknown {
  if (typeof v === "number") return encodeNonFinite(v);
  if (Array.isArray(v)) return v.map(encodeShape);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = encodeShape(x);
    return out;
  }
  return v;
}

// ---- projection (README §7 "Expect") ------------------------------------------------

interface StoredRow {
  prop_id: string;
  block_id: string | null;
  source: Source;
  key: string;
  card: "scalar" | "list";
  ord: number;
  type: FixtureRow["type"];
  val_text: string | null;
  val_num: number | null;
  val_bool: number | null;
  val_json: string | null;
}

const ROW_SQL = `SELECT prop_id, block_id, source, key, card, ord, type, val_text, val_num, val_bool, val_json
                 FROM properties WHERE doc_id = ? AND deleted_commit IS NULL`;

function projectRow(r: StoredRow): FixtureRow {
  let valNum: FixtureNum | null;
  if (r.val_num !== null) valNum = encodeNonFinite(r.val_num);
  else valNum = r.type === "number" ? "NaN" : null; // §8: number with no val_num ⇒ NaN
  return {
    prop_id: r.prop_id,
    block_id: r.block_id,
    source: r.source,
    key: r.key,
    card: r.card,
    ord: r.ord,
    type: r.type,
    val_text: r.val_text,
    val_num: valNum,
    val_bool: r.val_bool === null ? null : r.val_bool === 1 ? 1 : 0,
    val_json: r.val_json === null ? null : (JSON.parse(r.val_json) as unknown),
  };
}

/** A document's live `properties` rows, projected and sorted by (source rank, key bytewise, ord). */
export function projectRows(db: Store["db"], docId: string): FixtureRow[] {
  const rows = (db.prepare(ROW_SQL).all(docId) as StoredRow[]).map(projectRow);
  rows.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || cmpBytes(a.key, b.key) || a.ord - b.ord);
  return rows;
}

// ---- runner checks (README §7) ---------------------------------------------------------

/**
 * The §7 runner checks on projected rows: every `prop_id` equals the §1
 * derivation from the row's own fields; `prop_id`s are unique; inline rows name
 * a live block of the document and the other sources carry no block. Returns
 * the problems found (empty = fine).
 */
export function checkRows(rows: FixtureRow[], docId: string, liveBlockIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const at = `${r.source}/${r.key}[${r.ord}]`;
    const want = derivePropId(docId, r.source, r.key, r.ord);
    if (r.prop_id !== want) problems.push(`${at}: prop_id ${r.prop_id} != derived ${want}`);
    if (seen.has(r.prop_id)) problems.push(`${at}: duplicate prop_id ${r.prop_id}`);
    seen.add(r.prop_id);
    if (r.source === "inline") {
      if (r.block_id === null || !liveBlockIds.has(r.block_id)) problems.push(`${at}: inline row's block_id ${String(r.block_id)} is not a live block`);
    } else if (r.block_id !== null) problems.push(`${at}: ${r.source} row carries block_id ${r.block_id}`);
    if (!Number.isInteger(r.ord) || r.ord < 0) problems.push(`${at}: ord must be a non-negative integer`);
    if (r.card === "scalar" && r.ord !== 0) problems.push(`${at}: a scalar row has ord ${r.ord}`);
  }
  return problems;
}

// ---- evaluation ----------------------------------------------------------------------

export type FixtureCaseInput = Omit<FixtureCase, "expect">;

export interface Evaluation {
  expect: FixtureExpect;
  /** §7 runner-check problems (empty = fine). */
  problems: string[];
}

/**
 * Run a case: fresh `:memory:` store under the fixture minter (repo `rp_0`),
 * ingest `source` at `a.md` (document `d_0`; body block ids `b_0`, `b_1`, … in
 * pre-order — `assignIds` mints parent before children), read the `properties`
 * rows back and project them, take the two read shapes of §5, run the §7 checks.
 */
export function runCase(c: FixtureCaseInput): Evaluation {
  return withIdMinter(sequentialMinter(), () => {
    const store = new Store({ path: ":memory:" });
    try {
      const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, null);
      const { docId, converged } = ingestFile(store, repoId, FIXTURE_PATH, c.source);
      const problems: string[] = [];
      if (docId !== FIXTURE_DOC_ID) problems.push(`document id ${docId} != ${FIXTURE_DOC_ID}`);
      if (!converged) problems.push("ingest did not converge (sha256(source) != rendered)");
      const live = new Set(
        (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL").all(docId) as { block_id: string }[]).map((b) => b.block_id),
      );
      const rows = projectRows(store.db, docId);
      problems.push(...checkRows(rows, docId, live));
      const grouped = encodeShape(docPropertiesGrouped(store.db, docId)) as FixtureExpect["grouped"];
      const merged = encodeShape(docPropertiesMerged(store.db, docId)) as FixtureExpect["merged"];
      return { expect: { rows, grouped, merged }, problems };
    } finally {
      store.close();
    }
  });
}

// ---- validation ------------------------------------------------------------------------

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
}

function validateRow(at: string, r: unknown, problems: string[]): void {
  if (!isRecord(r)) {
    problems.push(`${at}: not an object`);
    return;
  }
  const keys = Object.keys(r).sort();
  const want = [...ROW_FIELDS].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    problems.push(`${at}: a row has exactly the fields ${ROW_FIELDS.join(", ")} (got ${keys.join(", ")})`);
    return;
  }
  if (typeof r.prop_id !== "string" || !/^p_[0-9a-f]{12}$/.test(r.prop_id)) problems.push(`${at}: prop_id must be p_ + 12 hex`);
  if (r.block_id !== null && typeof r.block_id !== "string") problems.push(`${at}: block_id must be a string or null`);
  if (!(SOURCES as readonly string[]).includes(r.source as string)) problems.push(`${at}: source must be frontmatter | inline | computed`);
  if (typeof r.key !== "string") problems.push(`${at}: key must be a string`);
  if (r.card !== "scalar" && r.card !== "list") problems.push(`${at}: card must be scalar | list`);
  if (typeof r.ord !== "number" || !Number.isInteger(r.ord) || r.ord < 0) problems.push(`${at}: ord must be a non-negative integer`);
  if (!["string", "number", "bool", "null", "json"].includes(r.type as string)) problems.push(`${at}: type must be string | number | bool | null | json`);
  if (r.val_text !== null && typeof r.val_text !== "string") problems.push(`${at}: val_text must be a string or null`);
  if (r.val_num !== null && typeof r.val_num !== "number" && !["Infinity", "-Infinity", "NaN"].includes(r.val_num as string)) {
    problems.push(`${at}: val_num must be a number, "Infinity", "-Infinity", "NaN" or null`);
  }
  if (r.val_bool !== null && r.val_bool !== 0 && r.val_bool !== 1) problems.push(`${at}: val_bool must be 0, 1 or null`);
}

function validateExpect(at: string, e: unknown, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  const extra = Object.keys(e).filter((k) => !["rows", "grouped", "merged"].includes(k));
  if (extra.length > 0) problems.push(`${at}: unknown keys ${extra.join(", ")}`);
  if (!Array.isArray(e.rows)) problems.push(`${at}.rows must be an array`);
  else e.rows.forEach((r, i) => validateRow(`${at}.rows[${i}]`, r, problems));
  if (!isRecord(e.grouped)) problems.push(`${at}.grouped must be an object`);
  else {
    const keys = Object.keys(e.grouped).sort();
    const want = [...SOURCES].sort();
    if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) problems.push(`${at}.grouped: must have exactly the keys ${SOURCES.join(", ")} (got ${keys.join(", ")})`);
    for (const s of SOURCES) if (s in e.grouped && !isRecord(e.grouped[s])) problems.push(`${at}.grouped.${s} must be an object`);
  }
  if (!isRecord(e.merged)) problems.push(`${at}.merged must be an object`);
}

/**
 * Validate a parsed `cases/<suite>.json`; returns the problems found (empty = valid).
 * `file` is the file name (with `.json`); the suite must equal its stem.
 */
export function validateFixtureFile(file: string, doc: unknown, opts: ValidateOptions = {}): string[] {
  const requireExpect = opts.requireExpect ?? true;
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${file}: not an object`];
  const stem = file.replace(/\.json$/, "");
  if (doc.suite !== stem) problems.push(`${file}: \`suite\` must equal the file stem '${stem}' (got ${JSON.stringify(doc.suite)})`);
  const extra = Object.keys(doc).filter((k) => !["suite", "cases"].includes(k));
  if (extra.length > 0) problems.push(`${file}: unknown top-level keys ${extra.join(", ")}`);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];

  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const unknown = Object.keys(c).filter((k) => !(CASE_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) problems.push(`${at}: unknown case keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);
    if (typeof c.source !== "string") problems.push(`${at}: \`source\` must be a string`);
    if (c.expect === undefined) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run PROPERTIES_SPEC_UPDATE=1)`);
      return;
    }
    validateExpect(`${at}.expect`, c.expect, problems);
  });
  return problems;
}
