// Fixture bridge for spec/reconcile (README §9). Pure pieces, no vitest:
//
//   inputToFlatSource()     a case's `old`/`new` side ({source} or {blocks}) → FlatSource[]
//   poolToCandidates()      `pool` entries → ResurrectionCandidate[]
//   canonicalize()          a DocReconcileResult → the fixture `expect` shape
//   evaluateCase()          run the reference on a case (single-doc or checkpoint)
//   checkInvariants()       the §2/§3 runner checks on a raw result
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//   deepEqualTol()          deep equality with a numeric tolerance (§8)
//
// Nothing here decides anything about matching; it re-expresses inputs and
// outputs so the two implementations can be compared.
import { parseTree } from "../../src/core/parse/tree.js";
import type { RawBlock } from "../../src/core/parse/types.js";
import { hashHex, normalizeVisibleText } from "../../src/core/hash.js";
import { flatten, type FlatSource } from "../../src/reconcile/flatten.js";
import { reconcileDocument, type DocReconcileResult, type ResurrectionCandidate } from "../../src/reconcile/reconcile.js";
import { crossDocMatch, applyCrossDocMatches, type PerDocUnmatched } from "../../src/reconcile/crossdoc.js";
import { DEFAULT_CONFIG, type MatchBlock, type ReconcileConfig } from "../../src/reconcile/types.js";

// ---- fixture shapes ------------------------------------------------------------

/** §6 fixture (snake_case) name → `ReconcileConfig` field. */
export const CONFIG_KEYS = {
  matcher_v: "matcherV",
  theta_accept: "thetaAccept",
  theta_small: "thetaSmall",
  small_block_tokens: "smallBlockTokens",
  context_sim_floor: "contextSimFloor",
  children_vouch_frac: "childrenVouchFrac",
  split_coverage: "splitCoverage",
  split_dominant_share: "splitDominantShare",
  copy_sim: "copySim",
  bulk_unmatched_frac: "bulkUnmatchedFrac",
  bulk_min_blocks: "bulkMinBlocks",
  max_scored_blocks: "maxScoredBlocks",
  theta_xdoc: "thetaXdoc",
} as const satisfies Record<string, keyof ReconcileConfig>;

export type FixtureConfigKey = keyof typeof CONFIG_KEYS;
export type FixtureConfig = Partial<Record<FixtureConfigKey, number | string>>;

/** spec/format §3 kind names a fixture block may carry (`frontmatter` is never reconciled, §1.1). */
export const BLOCK_KINDS = [
  "heading", "paragraph", "list", "list_item", "task", "blockquote",
  "code_fence", "table", "table_row", "thematic_break", "html_block", "opaque",
] as const;

export interface FixtureInputBlock {
  /** old side only */
  id?: string;
  type: string;
  raw: string;
  anchors?: string[];
  children: FixtureInputBlock[];
}

export type FixtureSide = { source: string } | { blocks: FixtureInputBlock[] };

export interface FixturePoolEntry {
  id: string;
  type: string;
  raw: string;
  /** visible text; defaults to the spec/format §4.1 leaf rule over `raw` at depth 0 */
  text?: string;
}

export interface CanonDisposition {
  /** old id, pool id, "DOC", or `new:<key>` for a minted id */
  block: string;
  kind: string;
  confidence: number | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface CanonResult {
  assignment: Record<string, string | null>;
  dispositions: CanonDisposition[];
  deleted: string[];
  consumed_pool: string[];
}

export interface CanonMove {
  from_doc: string;
  to_doc: string;
  carried_id: string;
  new_key: string;
  kind: "moved" | "edited_moved";
  confidence: number;
}

export interface CheckpointExpect {
  moves: CanonMove[];
  docs: Record<string, CanonResult>;
}

export interface FixtureDoc {
  id: string;
  old: FixtureSide;
  new: FixtureSide;
}

export interface FixtureCaseBase {
  name: string;
  notes?: string;
  config?: FixtureConfig;
}

export interface SingleDocCase extends FixtureCaseBase {
  old: FixtureSide;
  new: FixtureSide;
  pool?: FixturePoolEntry[];
  expect: CanonResult;
}

export interface CheckpointCase extends FixtureCaseBase {
  docs: FixtureDoc[];
  expect: CheckpointExpect;
}

export type FixtureCase = SingleDocCase | CheckpointCase;

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export function isCheckpointCase(c: FixtureCase): c is CheckpointCase {
  return "docs" in c;
}

/** The keys a case may carry. */
export const FIXTURE_CASE_KEYS = ["name", "notes", "config", "old", "new", "pool", "docs", "expect"] as const;

// ---- config ----------------------------------------------------------------------

export function toReconcileConfig(overrides: FixtureConfig | undefined): ReconcileConfig {
  const config: ReconcileConfig = { ...DEFAULT_CONFIG };
  if (!overrides) return config;
  for (const [k, v] of Object.entries(overrides)) {
    const field = CONFIG_KEYS[k as FixtureConfigKey];
    if (!field) throw new Error(`unknown config key ${k}`);
    if (field === "matcherV") {
      if (typeof v !== "string") throw new Error(`config.matcher_v must be a string`);
      config.matcherV = v;
    } else {
      if (typeof v !== "number") throw new Error(`config.${k} must be a number`);
      config[field] = v;
    }
  }
  return config;
}

// ---- inputs → FlatSource -----------------------------------------------------------

function fromRawBlocks(blocks: RawBlock[], ids: { next: number } | null): FlatSource[] {
  return blocks.map((b) => {
    // Pre-order: this block takes the next id before its children do.
    const src: FlatSource = ids ? { blockId: `b_${ids.next++}`, type: b.type, raw: b.raw, children: [] } : { type: b.type, raw: b.raw, children: [] };
    src.children = fromRawBlocks(b.children, ids);
    return src;
  });
}

function fromInputBlocks(blocks: FixtureInputBlock[], isOld: boolean, at: string): FlatSource[] {
  return blocks.map((b, i) => {
    const here = `${at}[${i}]`;
    if (isOld && (typeof b.id !== "string" || b.id === "")) throw new Error(`${here}: old block needs an id`);
    if (!isOld && b.id !== undefined) throw new Error(`${here}: new block must not carry an id`);
    const src: FlatSource = { type: b.type, raw: b.raw, children: fromInputBlocks(b.children ?? [], isOld, here) };
    if (isOld) src.blockId = b.id!;
    if (b.anchors && b.anchors.length > 0) src.anchors = [...b.anchors];
    return src;
  });
}

/**
 * A case side to FlatSource. `{source}` is parsed per spec/format, the
 * `frontmatter` block dropped, and (old side) ids assigned `b_0`, `b_1`, … in
 * pre-order — the order `flatten()` emits. `source` form carries no anchors.
 * `{blocks}` passes `type`/`raw`/`anchors`/`children` through and maps `id` →
 * `blockId` (required on old, forbidden on new).
 */
export function inputToFlatSource(side: FixtureSide, isOld: boolean, at = "input"): FlatSource[] {
  if ("source" in side) {
    const blocks = parseTree(side.source).children.filter((b) => b.type !== "frontmatter");
    return fromRawBlocks(blocks, isOld ? { next: 0 } : null);
  }
  return fromInputBlocks(side.blocks, isOld, at);
}

export function poolToCandidates(pool: FixturePoolEntry[] | undefined): ResurrectionCandidate[] {
  return (pool ?? []).map((p) => ({
    blockId: p.id,
    type: p.type,
    rawHashHex: hashHex(p.raw),
    normHashHex: hashHex(p.text ?? normalizeVisibleText(p.raw, p.type, 0)),
  }));
}

// ---- result → expect ---------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * README §9 "Expect": assignment with minted ids as `null`, dispositions with
 * minted ids as `new:<key>`, sorted by block then kind, `matcherV` dropped
 * (asserted equal to the config's). `knownIds` are the ids that may legitimately
 * appear in this document's result besides minted ones: its old ids, pool ids
 * and — in a checkpoint — the other documents' old ids.
 */
export function canonicalize(result: DocReconcileResult, newFlat: MatchBlock[], knownIds: ReadonlySet<string>, config: ReconcileConfig): CanonResult {
  const assignment: Record<string, string | null> = {};
  const mintedToKey = new Map<string, string>();
  for (const n of newFlat) {
    const id = result.assignment.get(n.key);
    if (id === undefined) throw new Error(`new key ${n.key} has no assignment`);
    if (knownIds.has(id)) {
      assignment[n.key] = id;
    } else {
      assignment[n.key] = null;
      if (mintedToKey.has(id)) throw new Error(`minted id ${id} assigned to both ${mintedToKey.get(id)} and ${n.key}`);
      mintedToKey.set(id, n.key);
    }
  }
  const dispositions: CanonDisposition[] = result.dispositions.map((d) => {
    if (d.matcherV !== config.matcherV) throw new Error(`disposition ${d.blockId} has matcherV ${d.matcherV}, expected ${config.matcherV}`);
    let block: string;
    if (d.blockId === "DOC" || knownIds.has(d.blockId)) block = d.blockId;
    else {
      const key = mintedToKey.get(d.blockId);
      if (key === undefined) throw new Error(`disposition ${d.blockId} (${d.kind}) names an id that is neither known nor assigned to a new key`);
      block = `new:${key}`;
    }
    return { block, kind: d.kind, confidence: d.confidence, reason: d.reason, detail: d.detail };
  });
  dispositions.sort((a, b) => cmp(a.block, b.block) || cmp(a.kind, b.kind));
  return { assignment, dispositions, deleted: [...result.deleted], consumed_pool: [...result.consumedPool] };
}

// ---- invariants (README §2, §3, §9 "Runner checks") ----------------------------------

export interface EvaluatedDoc {
  docId: string;
  oldFlat: MatchBlock[];
  newFlat: MatchBlock[];
  result: DocReconcileResult;
}

/**
 * The runner checks on raw results: every new key assigned exactly once; carried
 * ids unique (R1); carried pairs same type (R2); every old id in exactly one
 * disposition (across the documents of a checkpoint); every minted id in exactly
 * one; `matcherV` everywhere. Returns the problems found (empty = fine).
 */
export function checkInvariants(docs: EvaluatedDoc[], config: ReconcileConfig, poolIds: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  const oldById = new Map<string, MatchBlock>();
  for (const d of docs) {
    for (const o of d.oldFlat) {
      if (oldById.has(o.blockId!)) problems.push(`${d.docId}: old id ${o.blockId} is not unique`);
      oldById.set(o.blockId!, o);
    }
  }
  const knownIds = new Set([...oldById.keys(), ...poolIds]);
  const oldDispositionCount = new Map<string, number>();
  for (const id of oldById.keys()) oldDispositionCount.set(id, 0);

  for (const { docId, newFlat, result } of docs) {
    const at = docId;
    // Every new key assigned exactly once; no extra keys.
    const newKeys = new Set(newFlat.map((n) => n.key));
    for (const n of newFlat) if (!result.assignment.has(n.key)) problems.push(`${at}: new key ${n.key} unassigned`);
    for (const k of result.assignment.keys()) if (!newKeys.has(k)) problems.push(`${at}: assignment names unknown key ${k}`);

    // R1 / R2 and the minted-id set.
    const seenIds = new Map<string, string>();
    const minted = new Set<string>();
    for (const n of newFlat) {
      const id = result.assignment.get(n.key);
      if (id === undefined) continue;
      const prev = seenIds.get(id);
      if (prev !== undefined) problems.push(`${at}: id ${id} assigned to ${prev} and ${n.key} (R1)`);
      seenIds.set(id, n.key);
      const o = oldById.get(id);
      if (o) {
        if (o.type !== n.type) problems.push(`${at}: carry ${id} → ${n.key} changes type ${o.type} → ${n.type} (R2)`);
      } else if (!poolIds.has(id)) {
        minted.add(id);
      }
    }

    // Dispositions: matcherV, and one per old / minted id.
    const mintedCount = new Map<string, number>();
    for (const id of minted) mintedCount.set(id, 0);
    for (const d of result.dispositions) {
      if (d.matcherV !== config.matcherV) problems.push(`${at}: disposition ${d.blockId} has matcher_v ${d.matcherV}`);
      if (oldDispositionCount.has(d.blockId)) oldDispositionCount.set(d.blockId, oldDispositionCount.get(d.blockId)! + 1);
      else if (mintedCount.has(d.blockId)) mintedCount.set(d.blockId, mintedCount.get(d.blockId)! + 1);
      else if (d.blockId !== "DOC" && !poolIds.has(d.blockId)) problems.push(`${at}: disposition names unknown id ${d.blockId} (${d.kind})`);
    }
    for (const [id, n] of mintedCount) if (n !== 1) problems.push(`${at}: minted id ${id} has ${n} dispositions`);
    for (const id of result.deleted) if (!knownIds.has(id)) problems.push(`${at}: deleted names unknown id ${id}`);
    for (const id of result.consumedPool) if (!poolIds.has(id)) problems.push(`${at}: consumed_pool names non-pool id ${id}`);
  }
  for (const [id, n] of oldDispositionCount) if (n !== 1) problems.push(`old id ${id} has ${n} dispositions`);
  return problems;
}

// ---- evaluation -------------------------------------------------------------------

export interface Evaluation {
  expect: CanonResult | CheckpointExpect;
  problems: string[];
}

/** A case without its (generated) `expect`; a full case is accepted too. */
export type FixtureCaseInput = Omit<SingleDocCase, "expect"> | Omit<CheckpointCase, "expect">;

/** Run the reference on a case's inputs and produce its `expect` plus invariant problems. */
export function evaluateCase(c: FixtureCaseInput): Evaluation {
  const config = toReconcileConfig(c.config);
  if ("docs" in c) return evaluateCheckpoint(c.docs, config);
  const single = c;
  const oldFlat = flatten(inputToFlatSource(single.old, true, "old"));
  const newFlat = flatten(inputToFlatSource(single.new, false, "new"));
  const pool = poolToCandidates(single.pool);
  const result = reconcileDocument(oldFlat, newFlat, pool.length > 0 ? { config, pool } : { config });
  const poolIds = new Set(pool.map((p) => p.blockId));
  const knownIds = new Set([...oldFlat.map((o) => o.blockId!), ...poolIds]);
  const problems = checkInvariants([{ docId: "doc", oldFlat, newFlat, result }], config, poolIds);
  return { expect: canonicalize(result, newFlat, knownIds, config), problems };
}

/** README §7: reconcile each document, pool the leftovers, match, apply, canonicalize. */
function evaluateCheckpoint(docs: FixtureDoc[], config: ReconcileConfig): Evaluation {
  const evaluated: EvaluatedDoc[] = docs.map((d) => {
    const oldFlat = flatten(inputToFlatSource(d.old, true, `docs.${d.id}.old`));
    const newFlat = flatten(inputToFlatSource(d.new, false, `docs.${d.id}.new`));
    return { docId: d.id, oldFlat, newFlat, result: reconcileDocument(oldFlat, newFlat, { config }) };
  });

  const perDoc: PerDocUnmatched[] = evaluated.map(({ docId, oldFlat, newFlat, result }) => {
    const oldById = new Map(oldFlat.map((b) => [b.blockId!, b]));
    const newByKey = new Map(newFlat.map((b) => [b.key, b]));
    const keyOfId = new Map<string, string>();
    for (const [key, id] of result.assignment) keyOfId.set(id, key);
    return {
      docId,
      deleted: result.deleted.map((id) => ({ block: oldById.get(id)! })),
      inserted: result.dispositions
        .filter((d) => d.kind === "inserted")
        .map((d) => ({ block: newByKey.get(keyOfId.get(d.blockId)!)!, mintedId: d.blockId })),
    };
  });

  const matches = crossDocMatch(perDoc, config);
  const byDoc = new Map(evaluated.map((e) => [e.docId, e.result]));
  applyCrossDocMatches(byDoc, matches, config.matcherV);

  const knownIds = new Set(evaluated.flatMap((e) => e.oldFlat.map((o) => o.blockId!)));
  const problems = checkInvariants(evaluated, config);
  const out: Record<string, CanonResult> = {};
  for (const e of evaluated) out[e.docId] = canonicalize(e.result, e.newFlat, knownIds, config);
  const moves: CanonMove[] = matches.map((m) => ({
    from_doc: m.fromDoc,
    to_doc: m.toDoc,
    carried_id: m.carriedId,
    new_key: m.newKey,
    kind: m.kind,
    confidence: m.confidence,
  }));
  return { expect: { moves, docs: out }, problems };
}

// ---- deep equality with tolerance (README §8) -----------------------------------------

/**
 * Deep-compare two JSON values, object key order ignored, numbers within `eps`.
 * Returns null when equal, else the path of the first difference.
 */
export function deepEqualTol(a: unknown, b: unknown, eps: number, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= eps || (Number.isNaN(a) && Number.isNaN(b)) ? null : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`;
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const r = deepEqualTol(a[i], b[i], eps, `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return `${path}: object vs non-object`;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return `${path}: keys {${ka.join(",")}} vs {${kb.join(",")}}`;
    for (const k of ka) {
      const r = deepEqualTol(a[k], b[k], eps, `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

// ---- validation ---------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateBlocks(at: string, blocks: unknown, isOld: boolean, problems: string[]): void {
  if (!Array.isArray(blocks)) {
    problems.push(`${at}: \`blocks\` must be an array`);
    return;
  }
  blocks.forEach((b, i) => {
    const here = `${at}[${i}]`;
    if (!isRecord(b)) {
      problems.push(`${here}: block is not an object`);
      return;
    }
    const unknown = Object.keys(b).filter((k) => !["id", "type", "raw", "anchors", "children"].includes(k));
    if (unknown.length > 0) problems.push(`${here}: unknown block keys ${unknown.join(", ")}`);
    if (typeof b.type !== "string" || !(BLOCK_KINDS as readonly string[]).includes(b.type)) {
      problems.push(`${here}: \`type\` must be a spec/format §3 kind (got ${JSON.stringify(b.type)})`);
    }
    if (typeof b.raw !== "string") problems.push(`${here}: \`raw\` must be a string`);
    if (isOld && (typeof b.id !== "string" || b.id === "")) problems.push(`${here}: old block needs a non-empty \`id\``);
    if (!isOld && b.id !== undefined) problems.push(`${here}: new block must not carry an \`id\``);
    if (b.anchors !== undefined && (!Array.isArray(b.anchors) || !b.anchors.every((a) => typeof a === "string"))) {
      problems.push(`${here}: \`anchors\` must be an array of strings`);
    }
    if (!Array.isArray(b.children)) problems.push(`${here}: \`children\` must be an array`);
    else validateBlocks(`${here}.children`, b.children, isOld, problems);
  });
}

function validateSide(at: string, side: unknown, isOld: boolean, problems: string[]): void {
  if (!isRecord(side)) {
    problems.push(`${at}: must be an object with \`source\` or \`blocks\``);
    return;
  }
  const keys = Object.keys(side);
  if (keys.length !== 1 || (keys[0] !== "source" && keys[0] !== "blocks")) {
    problems.push(`${at}: must have exactly one of \`source\` / \`blocks\` (got ${keys.join(", ")})`);
    return;
  }
  if ("source" in side) {
    if (typeof side.source !== "string") problems.push(`${at}: \`source\` must be a string`);
  } else {
    validateBlocks(`${at}.blocks`, side.blocks, isOld, problems);
  }
}

function validateConfig(at: string, config: unknown, problems: string[]): void {
  if (!isRecord(config)) {
    problems.push(`${at}: \`config\` must be an object`);
    return;
  }
  for (const [k, v] of Object.entries(config)) {
    if (!(k in CONFIG_KEYS)) problems.push(`${at}: unknown config key \`${k}\``);
    else if (k === "matcher_v" ? typeof v !== "string" : typeof v !== "number") {
      problems.push(`${at}: config.${k} has the wrong type`);
    }
  }
}

function validatePool(at: string, pool: unknown, problems: string[]): void {
  if (!Array.isArray(pool)) {
    problems.push(`${at}: \`pool\` must be an array`);
    return;
  }
  pool.forEach((p, i) => {
    const here = `${at}[${i}]`;
    if (!isRecord(p)) {
      problems.push(`${here}: pool entry is not an object`);
      return;
    }
    const unknown = Object.keys(p).filter((k) => !["id", "type", "raw", "text"].includes(k));
    if (unknown.length > 0) problems.push(`${here}: unknown pool keys ${unknown.join(", ")}`);
    if (typeof p.id !== "string" || p.id === "") problems.push(`${here}: pool entry needs an \`id\``);
    if (typeof p.type !== "string" || !(BLOCK_KINDS as readonly string[]).includes(p.type)) problems.push(`${here}: \`type\` must be a spec/format §3 kind`);
    if (typeof p.raw !== "string") problems.push(`${here}: \`raw\` must be a string`);
    if (p.text !== undefined && typeof p.text !== "string") problems.push(`${here}: \`text\` must be a string`);
  });
}

function validateCanonResult(at: string, e: unknown, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  const extra = Object.keys(e).filter((k) => !["assignment", "dispositions", "deleted", "consumed_pool"].includes(k));
  if (extra.length > 0) problems.push(`${at}: unknown keys ${extra.join(", ")}`);
  if (!isRecord(e.assignment)) problems.push(`${at}.assignment must be an object`);
  if (!Array.isArray(e.dispositions)) problems.push(`${at}.dispositions must be an array`);
  else {
    e.dispositions.forEach((d, i) => {
      if (!isRecord(d)) {
        problems.push(`${at}.dispositions[${i}]: not an object`);
        return;
      }
      const keys = Object.keys(d).sort();
      const want = ["block", "confidence", "detail", "kind", "reason"];
      if (keys.length !== want.length || keys.some((k, j) => k !== want[j])) {
        problems.push(`${at}.dispositions[${i}]: must have exactly block, kind, confidence, reason, detail (got ${keys.join(", ")})`);
      }
    });
  }
  if (!Array.isArray(e.deleted)) problems.push(`${at}.deleted must be an array`);
  if (!Array.isArray(e.consumed_pool)) problems.push(`${at}.consumed_pool must be an array`);
}

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
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
    const unknown = Object.keys(c).filter((k) => !(FIXTURE_CASE_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) problems.push(`${at}: unknown case keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);
    if (c.config !== undefined) validateConfig(at, c.config, problems);

    const single = c.old !== undefined || c.new !== undefined;
    const checkpoint = c.docs !== undefined;
    if (single === checkpoint) {
      problems.push(`${at}: a case has either \`old\` + \`new\` or \`docs\``);
      return;
    }
    if (single) {
      validateSide(`${at}.old`, c.old, true, problems);
      validateSide(`${at}.new`, c.new, false, problems);
      if (c.pool !== undefined) validatePool(`${at}.pool`, c.pool, problems);
    } else {
      if (c.pool !== undefined) problems.push(`${at}: a checkpoint case takes no \`pool\``);
      if (!Array.isArray(c.docs) || c.docs.length === 0) problems.push(`${at}: \`docs\` must be a non-empty array`);
      else {
        const ids = new Set<string>();
        c.docs.forEach((d, j) => {
          const here = `${at}.docs[${j}]`;
          if (!isRecord(d)) {
            problems.push(`${here}: not an object`);
            return;
          }
          const bad = Object.keys(d).filter((k) => !["id", "old", "new"].includes(k));
          if (bad.length > 0) problems.push(`${here}: unknown doc keys ${bad.join(", ")}`);
          if (typeof d.id !== "string" || d.id === "") problems.push(`${here}: doc needs an \`id\``);
          else if (ids.has(d.id)) problems.push(`${here}: duplicate doc id '${d.id}'`);
          else ids.add(d.id);
          validateSide(`${here}.old`, d.old, true, problems);
          validateSide(`${here}.new`, d.new, false, problems);
        });
      }
    }

    if (c.expect === undefined) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run RECONCILE_SPEC_UPDATE=1)`);
      return;
    }
    if (single) validateCanonResult(`${at}.expect`, c.expect, problems);
    else if (!isRecord(c.expect) || !Array.isArray(c.expect.moves) || !isRecord(c.expect.docs)) {
      problems.push(`${at}.expect: a checkpoint expect has \`moves\` and \`docs\``);
    } else {
      for (const [id, r] of Object.entries(c.expect.docs)) validateCanonResult(`${at}.expect.docs.${id}`, r, problems);
    }
  });
  return problems;
}
