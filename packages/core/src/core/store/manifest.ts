import type { Database } from "better-sqlite3";
import { sha256 } from "../hash.js";
import { effectiveSettingsOf } from "./settings.js";
import { capabilitiesOf } from "../capabilities/registry.js";
import { CapabilityUnavailable, CaptureFailed, captureFailedMessage, type CapabilityName } from "../capabilities/errors.js";
import type { CommitRecord, HistoryPurgeOutcome, HistoryRecorder } from "../capabilities/types.js";
import { clearAlert, raiseAlert } from "./alerts.js";
import { HISTORY_DDL } from "./schema.js";
import { appendFeedEntry, appendFeedRow } from "./feed.js";

// The capability manifest (spec/store §3.1 `capabilities`, 17.0 — modular-core
// Phase 3e-ii; phase-1-contracts §1.5, §1.14, §1.16 step 11, §7 resolutions 1
// and 17). One row per (repository, capability): `state`, the interface and
// data versions the bundle's rows were produced under, the `config` they were
// produced under with its sha256 fingerprint, the COVERAGE intervals capture
// was on (`[{ from, to }]`, the last open iff enabled) and `writer_requires`.
//
// Who writes it. `ensure_repo` (`core/attach.ts`) writes both rows for a new
// repository — history `enabled` with coverage from the repository's birth and
// `writer_requires = 1` (resolution 17: a writer without the recorder refuses)
// WHEN the composition carries the recorder, `disabled` with no coverage when
// it does not (a core-only build creates repositories it can write; Phase 4a);
// semantic `enabled` iff `embedding.provider` resolves for the repository
// (resolution 1: vectors are never consulted) — and migration 17 does the same
// for every existing repository (coverage from its first commit). Until the
// `embed` verbs (Phase 4b) exist, the semantic row FOLLOWS the setting: every
// settings write re-derives it (`refreshSemanticManifest`, called by
// `sync/settings.ts`), opening or closing a coverage interval when the state
// flips. The history row is flipped by `history enable|disable` below (Phase
// 4a; spec/store §5.9).
//
// Who reads it. `version.capabilities` and `capability_unavailable`'s state
// (`sync/capability-state.ts`), `doctor --size`'s `capabilities` member and
// the `history`/`semantic` file lines (`core/store/size.ts`), every writer
// through `requireWriter`/`writerFor` below — and, since Phase 4a, every
// commit: `captureFor(db, repoId)` is the recorder iff the composition carries
// the module AND the repository's row is `enabled`; otherwise the commit
// writes no history row. The history bundle's DDL follows the manifest: it is
// executed when a repository's row becomes `enabled` (`ensure_repo`, `history
// enable`, the opener for a database some repository of which is enabled), so
// a database no repository of which ever enabled capture has no history table
// (spec/store §3.1 "The three bundles").

/** The history capability's interface version (phase-1-contracts §1.5: history 1). */
export const HISTORY_INTERFACE_V = 1;
/** The history bundle's data version (1 = 16.0's tables + `edge_transitions`). */
export const HISTORY_DATA_V = 1;
/** The semantic capability's interface version (1). */
export const SEMANTIC_INTERFACE_V = 1;
/** The semantic bundle's data version (1). */
export const SEMANTIC_DATA_V = 1;

export type ManifestState = "enabled" | "disabled";

/** One coverage interval: capture was on from `from` (inclusive) to `to` (exclusive), `to` null while it still is. */
export interface CoverageInterval { from: string; to: string | null }

export interface ManifestRow {
  capability: CapabilityName;
  state: ManifestState;
  interface_v: number;
  data_v: number;
  config: Record<string, unknown>;
  config_hash: Buffer;
  coverage: CoverageInterval[];
  writer_requires: boolean;
  updated_at: string;
}

interface RawRow {
  capability: string; state: string; interface_v: number; data_v: number; config: string; config_hash: Buffer; coverage: string; writer_requires: number; updated_at: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Canonical JSON (keys sorted bytewise at every level) — what `config_hash` fingerprints, so both engines hash the same bytes. */
export function canonicalConfigJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalConfigJson).join(",")}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalConfigJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** `sha256(canonical JSON of config)` — the fingerprint column. */
export function configHash(config: Record<string, unknown>): Buffer {
  return sha256(canonicalConfigJson(config));
}

function fromRaw(r: RawRow): ManifestRow {
  let config: Record<string, unknown> = {};
  let coverage: CoverageInterval[] = [];
  try {
    const c = JSON.parse(r.config) as unknown;
    if (isRecord(c)) config = c;
  } catch { /* an unparsable config reads as {} */ }
  try {
    const c = JSON.parse(r.coverage) as unknown;
    if (Array.isArray(c)) coverage = c.filter((i): i is CoverageInterval => isRecord(i) && typeof i.from === "string" && (i.to === null || typeof i.to === "string"));
  } catch { /* an unparsable coverage reads as [] */ }
  return {
    capability: r.capability as CapabilityName,
    state: r.state as ManifestState,
    interface_v: r.interface_v,
    data_v: r.data_v,
    config,
    config_hash: r.config_hash,
    coverage,
    writer_requires: r.writer_requires === 1,
    updated_at: r.updated_at,
  };
}

const COLUMNS = "capability, state, interface_v, data_v, config, config_hash, coverage, writer_requires, updated_at";

/** Does the `capabilities` table exist on this connection (false only on a pre-3e-ii 17.0 database before the opener finished the step)? */
export function manifestTableExists(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capabilities'").get();
}

/** The manifest row of `(repoId, capability)`, or null — spec/store §3.1 rule 1: no row is `disabled` with no coverage. */
export function readCapability(db: Database, repoId: string, capability: CapabilityName): ManifestRow | null {
  if (!manifestTableExists(db)) return null;
  const r = db.prepare(`SELECT ${COLUMNS} FROM capabilities WHERE repo_id = ? AND capability = ?`).get(repoId, capability) as RawRow | undefined;
  return r ? fromRaw(r) : null;
}

/** Both rows of a repository (null where absent). */
export function readCapabilities(db: Database, repoId: string): { history: ManifestRow | null; semantic: ManifestRow | null } {
  return { history: readCapability(db, repoId, "history"), semantic: readCapability(db, repoId, "semantic") };
}

/** Rule 3: `coverage_from` is the first interval's `from`, null when there is none. */
export function coverageFrom(row: ManifestRow | null): string | null {
  return row && row.coverage.length > 0 ? row.coverage[0]!.from : null;
}

interface WriteInput {
  capability: CapabilityName;
  state: ManifestState;
  interfaceV: number;
  dataV: number;
  config: Record<string, unknown>;
  coverage: CoverageInterval[];
  writerRequires: boolean;
  now: string;
}

function writeRow(db: Database, repoId: string, w: WriteInput): void {
  db.prepare(
    `INSERT INTO capabilities (repo_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, capability) DO UPDATE SET
       state = excluded.state, interface_v = excluded.interface_v, data_v = excluded.data_v, config = excluded.config,
       config_hash = excluded.config_hash, coverage = excluded.coverage, writer_requires = excluded.writer_requires, updated_at = excluded.updated_at`,
  ).run(repoId, w.capability, w.state, w.interfaceV, w.dataV, canonicalConfigJson(w.config), configHash(w.config), JSON.stringify(w.coverage), w.writerRequires ? 1 : 0, w.now);
}

/**
 * The history row a repository gets at `ensure_repo` / migration 17: when the
 * composition carries the recorder and the caller did not ask for `history:
 * false` (`omg source add --no-history`), `enabled`, interface/data 1, `config
 * {}`, one open coverage interval from `from`, `writer_requires` per
 * `writerRequires` (default 1 — resolution 17), and the history bundle's DDL
 * executed; otherwise (a core-only build, Phase 4a, or the explicit opt-out)
 * `disabled` with no coverage and `writer_requires = 0` — a build that cannot
 * capture does not require what it cannot do, and `history enable` through a
 * full build turns it on later. Idempotent: an existing row is left alone (the
 * manifest is engine state, never re-derived from elsewhere).
 */
export function ensureHistoryManifest(db: Database, repoId: string, from: string, now: string, opts: { history?: boolean; writerRequires?: boolean } = {}): ManifestRow {
  const existing = readCapability(db, repoId, "history");
  if (existing) return existing;
  const writerRequires = opts.writerRequires ?? true;
  const enabled = capabilitiesOf(db).history !== null && opts.history !== false;
  if (enabled) applyHistoryBundle(db);
  writeRow(db, repoId, {
    capability: "history", state: enabled ? "enabled" : "disabled", interfaceV: HISTORY_INTERFACE_V, dataV: HISTORY_DATA_V, config: {},
    coverage: enabled ? [{ from, to: null }] : [], writerRequires: enabled && writerRequires, now,
  });
  return readCapability(db, repoId, "history")!;
}

// ---- the history bundle's presence (spec/store §3.1 "The three bundles", Phase 4a) ----

const bundlePresent = new WeakMap<Database, true>();

/** Do the history bundle's tables exist on this connection? (Probed once per connection, then remembered — `applyHistoryBundle` is the only way they appear.) */
export function historyBundlePresent(db: Database): boolean {
  if (bundlePresent.get(db)) return true;
  const present = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'commits'").get();
  if (present) bundlePresent.set(db, true);
  return present;
}

/** Execute the history bundle's DDL (`schema-history.sql`; every statement `IF NOT EXISTS`) — `history enable`, `ensure_repo` with the recorder, the opener. */
export function applyHistoryBundle(db: Database): void {
  if (historyBundlePresent(db)) return;
  db.exec(HISTORY_DDL);
  bundlePresent.set(db, true);
}

/** The bundle's tables were dropped (`history purge`, spec/store §7.6): forget the probe's answer so the next capture re-executes the DDL. */
function forgetHistoryBundle(db: Database): void {
  bundlePresent.delete(db);
}

/** spec/store §3.1 `coverage`: does some interval hold `ts` — `from ≤ ts` and (`to` null or `ts < to`)? */
export function inCoverage(coverage: readonly CoverageInterval[], ts: string): boolean {
  return coverage.some((i) => i.from <= ts && (i.to === null || ts < i.to));
}

/** Does `ts` lie after the last interval's end (or is there no interval at all)? — the `disabled` state's condition (spec/surface §2.1). */
function afterCoverage(coverage: readonly CoverageInterval[], ts: string): boolean {
  if (coverage.length === 0) return true;
  const last = coverage[coverage.length - 1]!;
  return last.to !== null && ts >= last.to;
}

/** The claim's `minted_at` for an id (spec/store §2.1 `id_claims`), null when no claim exists (never minted here, or pruned under `identity.claims_retain_days`). */
export function claimMintedAt(db: Database, id: string): string | null {
  const r = db.prepare("SELECT minted_at FROM id_claims WHERE id = ?").get(id) as { minted_at: string } | undefined;
  return r ? r.minted_at : null;
}

/**
 * The history read states, decided in the spec's order (spec/surface §2.1's
 * table; phase-1-contracts §2.1, D3 — Phase 4b) for a revision token `rev` the
 * recorder holds NO row for, on a repository whose current head `rev` is not
 * (the head is served from the rows, resolution 11). Throws:
 *   - `capability_unavailable { history, unavailable }` — no module (retriable);
 *   - `{ history, disabled, rev }` — the row is absent or `disabled` and the
 *     token was minted after the last coverage interval (or there is none), or
 *     the token is no claim at all (nothing says it was ever minted here);
 *   - `{ history, outside_coverage, rev, coverage_from, fix? }` — the claim's
 *     `minted_at` falls in no interval: capture was off when it was minted;
 *   - `{ history, pruned, rev, fix? }` — minted within coverage, no row: the
 *     history was purged (spec/store §7.6);
 *   - `target_missing` — an unclaimed token on an enabled repository (the 4a
 *     answer, kept: the token is nobody's).
 * A token the recorder DOES hold — another document's revision — is
 * `target_missing` on every composition, as before. `docId` names the document
 * asked about (the `target_missing` data); `readFix` adds the current document
 * (`docs_read {"_id":"<id>"}`) as the `fix` of `outside_coverage`/`pruned` —
 * the caller is `docs_read { at }` / `docs_read_at`.
 */
export function historyReadRefusal(db: Database, repoId: string, rev: string, opts: { docId?: string; readFix?: boolean } = {}): never {
  if (!capabilitiesOf(db).history) throw CapabilityUnavailable.historyUnavailable();
  if (historyReader(db)?.hasRevision(rev)) throw new TargetMissingRevision(rev, opts.docId ?? null);
  const row = readCapability(db, repoId, "history");
  const enabled = row !== null && row.state === "enabled";
  const mintedAt = claimMintedAt(db, rev);
  if (mintedAt === null) {
    if (enabled) throw new TargetMissingRevision(rev, opts.docId ?? null);
    throw CapabilityUnavailable.historyDisabled(rev);
  }
  const coverage = row?.coverage ?? [];
  if (!enabled && afterCoverage(coverage, mintedAt)) throw CapabilityUnavailable.historyDisabled(rev);
  const fix = opts.readFix && opts.docId !== undefined ? `docs_read ${JSON.stringify({ _id: opts.docId })}` : undefined;
  if (!inCoverage(coverage, mintedAt)) throw CapabilityUnavailable.historyOutsideCoverage(rev, coverage[0]!.from, fix);
  throw CapabilityUnavailable.historyPruned(rev, fix);
}

/** `target_missing` "no revision \"<rev>\" for document <id>" — the surface renders it (`mcp/errors.ts`); raised here so the table has one home. */
export class TargetMissingRevision extends Error {
  readonly code = "target_missing" as const;
  constructor(readonly rev: string, readonly docId: string | null) {
    super(`no revision ${JSON.stringify(rev)} for document ${docId ?? "?"}`);
    this.name = "TargetMissingRevision";
  }
  data(): Record<string, unknown> {
    return { ...(this.docId !== null ? { doc: this.docId } : {}), rev: this.rev };
  }
}

/** Is any repository's history row `enabled` (the opener's rule for executing the bundle's DDL: one database holds every repository)? */
export function anyHistoryEnabled(db: Database): boolean {
  if (!manifestTableExists(db)) return false;
  return !!db.prepare("SELECT 1 FROM capabilities WHERE capability = 'history' AND state = 'enabled' LIMIT 1").get();
}

/**
 * The recorder a commit on `repoId` captures through (spec/store §5.4 step
 * 15, Phase 4a): the composition's module when the repository's manifest row
 * is `enabled`, else null — the capture is simply skipped and no history row
 * is written. With `repoId` null (a store-wide maintenance path — `gc`,
 * `rebuild-index`): the module when the bundle's tables exist.
 */
export function captureFor(db: Database, repoId: string | null): HistoryRecorder | null {
  const history = capabilitiesOf(db).history;
  if (!history) return null;
  if (repoId === null) return historyBundlePresent(db) ? history : null;
  const row = readCapability(db, repoId, "history");
  if (!row || row.state !== "enabled") return null;
  return history;
}

/**
 * The recorder a READ goes through (`docs_read { at }`, `docs_diff*`,
 * `docs_history`, `blocks_history`, the `revisions` query root): the module
 * when the bundle's tables exist — what was captured is readable whatever the
 * repository's current state (spec/surface §2.1: a disabled repository reads
 * what it captured earlier) — else null (nothing was ever captured in this
 * database, or the build has no module).
 */
export function historyReader(db: Database): HistoryRecorder | null {
  const history = capabilitiesOf(db).history;
  return history && historyBundlePresent(db) ? history : null;
}

/**
 * Run one of the recorder's capture calls (spec/store §5.4 step 15, resolution
 * 18): a throw becomes `CaptureFailed` for the transaction's owner to roll back
 * on, name the member and raise the alert after. `path` is the member when the
 * caller knows it (null for the batch's commit row).
 */
export function capture<T>(path: string | null, body: () => T): T {
  try {
    return body();
  } catch (e) {
    if (e instanceof CaptureFailed) throw e;
    throw new CaptureFailed(path, e);
  }
}

// ---- the capture lifecycle: `history enable` / `history disable` (spec/store §5.9, Phase 4a) ----

export interface HistoryLifecycleResult {
  /** The row as it now is. */
  row: ManifestRow;
  /** Whether anything changed (`false`: the verb was a no-op — already in that state). */
  changed: boolean;
  /** `enable`: the baseline commit's id and the revisions it wrote (null when nothing changed). */
  baseline: { commit: string; revisions: number } | null;
}

/**
 * `history enable` (spec/store §5.9; phase-1-contracts §1.14): in one
 * transaction — the bundle's DDL when absent; the BASELINE: one feed row
 * (`origin = 'import'`, `reason = 'history enabled'`, its own batch) with one
 * `changed` entry per live document under its EXISTING head (no head is
 * minted, so every `_rev` a client holds stays valid), handed to the recorder
 * as `HistoryRecorder.baseline` — the `commits` row, a checkpoint revision for
 * every live document whose head has none, the recorder's holds, the edge
 * record reconciled; then the manifest row: `state = 'enabled'`, `coverage +=
 * { from: ts, to: null }`, `writer_requires` per `writerRequires` (default 1,
 * resolution 17). Idempotent: an `enabled` row is returned unchanged (even
 * when `writerRequires` differs — the flag is the enable's, not a setting).
 * Refuses on a composition without the recorder (`capability_unavailable {
 * history, unavailable }`: nothing can capture here). The caller holds the
 * writer lock and no transaction (the baseline is one of its own).
 */
export function enableHistory(db: Database, repoId: string, opts: { now?: string; writerRequires?: boolean } = {}): HistoryLifecycleResult {
  const history = capabilitiesOf(db).history;
  if (!history) throw CapabilityUnavailable.historyUnavailable();
  const now = opts.now ?? new Date().toISOString();
  const existing = readCapability(db, repoId, "history");
  if (existing && existing.state === "enabled") return { row: existing, changed: false, baseline: null };
  return db.transaction((): HistoryLifecycleResult => {
    applyHistoryBundle(db);
    const commit = appendFeedRow(db, { repoId, ts: now, origin: "import", reason: HISTORY_ENABLED_REASON });
    const live = db.prepare("SELECT doc_id, path, head, file_hash FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND head IS NOT NULL ORDER BY rowid").all(repoId) as { doc_id: string; path: string; head: string; file_hash: Buffer }[];
    for (const d of live) appendFeedEntry(db, { repoId, epoch: commit.epoch, seq: commit.seq, docId: d.doc_id, path: d.path, head: d.head, hash: d.file_hash, kind: "changed" });
    const record: CommitRecord = { commitId: commit.commitId, repoId, epoch: commit.epoch, seq: commit.seq, ts: now, origin: "import", actor: null, reason: HISTORY_ENABLED_REASON, batchId: commit.batchId, ops: null };
    const { revisions } = history.baseline(record);
    const coverage = [...(existing?.coverage ?? []), { from: now, to: null }];
    writeRow(db, repoId, {
      capability: "history", state: "enabled", interfaceV: existing?.interface_v ?? HISTORY_INTERFACE_V, dataV: existing?.data_v ?? HISTORY_DATA_V, config: existing?.config ?? {},
      coverage, writerRequires: opts.writerRequires ?? true, now,
    });
    return { row: readCapability(db, repoId, "history")!, changed: true, baseline: { commit: commit.commitId, revisions } };
  })();
}

/** The feed row's `reason` on the baseline commit, byte for byte in both engines. */
export const HISTORY_ENABLED_REASON = "history enabled";

/**
 * `history disable` (spec/store §5.9): the open coverage interval closes
 * (`to = ts`), `state = 'disabled'`, `writer_requires = 0`. The rows stay
 * (`history purge`, Phase 4b, is what removes them); reads of what was
 * captured keep working; step 15 stops for this repository from the next
 * commit on, in this process and every other (every commit reads the row).
 * Idempotent: a `disabled` or absent row is a no-op. Needs no recorder: a
 * core-only build may switch capture off on a repository it cannot write.
 */
export function disableHistory(db: Database, repoId: string, opts: { now?: string } = {}): HistoryLifecycleResult {
  const now = opts.now ?? new Date().toISOString();
  const existing = readCapability(db, repoId, "history");
  if (!existing || existing.state === "disabled") {
    const row = existing ?? ensureHistoryManifestDisabled(db, repoId, now);
    return { row, changed: false, baseline: null };
  }
  const coverage = existing.coverage.map((i, idx) => (idx === existing.coverage.length - 1 && i.to === null ? { from: i.from, to: now } : i));
  writeRow(db, repoId, {
    capability: "history", state: "disabled", interfaceV: existing.interface_v, dataV: existing.data_v, config: existing.config, coverage, writerRequires: false, now,
  });
  return { row: readCapability(db, repoId, "history")!, changed: true, baseline: null };
}

/** A `disabled` history row for a repository that has none (rule 1 made explicit by a `disable` on a row-less repository). */
function ensureHistoryManifestDisabled(db: Database, repoId: string, now: string): ManifestRow {
  writeRow(db, repoId, { capability: "history", state: "disabled", interfaceV: HISTORY_INTERFACE_V, dataV: HISTORY_DATA_V, config: {}, coverage: [], writerRequires: false, now });
  return readCapability(db, repoId, "history")!;
}

export interface HistoryPurgeResult {
  /** The rows removed, per history table (spec/store §7.6). */
  purged: HistoryPurgeOutcome["purged"];
  /** The recorder's holds released (claims left with no holder deleted). */
  claims_released: number;
  /** The manifest's coverage — unchanged by a purge: coverage records when capture was ON, not what is retained (spec/store §7.6). */
  coverage: CoverageInterval[];
  /** Whether the bundle's tables were dropped: no repository enabled and every history table empty after the purge. */
  tables_dropped: boolean;
}

/**
 * `history purge [--before <ts>]` (spec/store §7.6, Phase 4b; phase-1-contracts
 * §1.14, D2 step two): in one transaction — the recorder removes the
 * repository's history rows (`HistoryRecorder.purge`: every commit, or those
 * before `before`, never a live head's revision), the recorder's hold (bit 1)
 * is released on every claim no history row names any more (a claim with no
 * holder left is deleted), and — when NO repository is `enabled` and every
 * history table is empty — the bundle's tables are dropped (a workspace-wide
 * decision taken automatically and reported as `tables_dropped`, so a
 * database that purged its last history is a core database again; the next
 * `history enable` re-executes the DDL). The manifest's `coverage` and
 * `state` are NOT touched: coverage is the record of when capture was on, which
 * a purge does not change — it is what tells a purged token (`pruned`) from
 * one minted while capture was off (`outside_coverage`), spec/surface §2.1.
 * Needs the module (`capability_unavailable { history, unavailable }`
 * otherwise); a database without the bundle has nothing to purge (every count
 * 0). The caller holds the writer lock and no transaction.
 */
export function purgeHistory(db: Database, repoId: string, opts: { before?: string | null; now?: string } = {}): HistoryPurgeResult {
  const history = capabilitiesOf(db).history;
  if (!history) throw CapabilityUnavailable.historyUnavailable();
  const before = opts.before ?? null;
  const row = readCapability(db, repoId, "history");
  const coverage = row?.coverage ?? [];
  if (!historyBundlePresent(db)) {
    return { purged: { commits: 0, revisions: 0, blobs: 0, tree_nodes: 0, dispositions: 0, block_changes: 0, edge_transitions: 0, archives: 0 }, claims_released: 0, coverage, tables_dropped: false };
  }
  return db.transaction((): HistoryPurgeResult => {
    const { purged, claims_released, tables_dropped } = history.purge(repoId, before, { dropIfEmpty: !anyHistoryEnabled(db), protectHeads: row?.state === "enabled" });
    if (tables_dropped) forgetHistoryBundle(db);
    return { purged, claims_released, coverage, tables_dropped };
  })();
}

/** The open coverage interval's `from` (the current capture's start), or null when capture is off. */
export function openCoverageFrom(row: ManifestRow | null): string | null {
  if (!row || row.coverage.length === 0) return null;
  const last = row.coverage[row.coverage.length - 1]!;
  return last.to === null ? last.from : null;
}

/** Is `embedding.provider` configured for the repository (the workspace layer with the repo's own over it)? */
export function semanticProviderConfigured(db: Database, repoId: string): boolean {
  const embedding = effectiveSettingsOf(db, repoId).embedding;
  if (!isRecord(embedding)) return false;
  const provider = embedding.provider;
  return typeof provider === "string" && provider.trim() !== "";
}

/** The semantic row's `config`: `{ model, dim }` from the effective `embedding.*` settings — only the keys that are set. */
export function semanticConfigOf(db: Database, repoId: string): Record<string, unknown> {
  const embedding = effectiveSettingsOf(db, repoId).embedding;
  if (!isRecord(embedding)) return {};
  const out: Record<string, unknown> = {};
  if (typeof embedding.model === "string" && embedding.model !== "") out.model = embedding.model;
  if (typeof embedding.dim === "number" && Number.isFinite(embedding.dim)) out.dim = embedding.dim;
  return out;
}

/**
 * Re-derive the semantic row from the settings (resolution 1: `enabled` iff a
 * provider is configured; stored vectors are never consulted). The row is
 * inserted when missing; when the state flips an interval opens (`{ from: now,
 * to: null }`) or the open one closes (`to = now`); when only the config
 * changed the config and its hash move; an unchanged row is not touched (its
 * `updated_at` stands). Returns the row as it now is. Called by `ensure_repo`,
 * migration 17 and every settings write until the Phase 4 `embed` verbs own it.
 */
export function refreshSemanticManifest(db: Database, repoId: string, now: string, opts: { flip?: boolean } = {}): ManifestRow {
  if (!manifestTableExists(db)) throw new Error("the capabilities table is missing — open the store through Store first");
  const config = semanticConfigOf(db, repoId);
  const existing = readCapability(db, repoId, "semantic");
  // spec/store §5.10 (Phase 4b): once the row exists, a settings write that
  // did not change the effective provider leaves the STATE alone — `omg embed
  // disable` is sticky across unrelated settings writes — and moves the config
  // when it changed. `flip` (default: derive the state) is the caller's word
  // that the provider changed.
  const flip = opts.flip ?? true;
  const state: ManifestState = existing && !flip ? existing.state : semanticProviderConfigured(db, repoId) ? "enabled" : "disabled";
  if (!existing) {
    writeRow(db, repoId, {
      capability: "semantic", state, interfaceV: SEMANTIC_INTERFACE_V, dataV: SEMANTIC_DATA_V, config,
      coverage: state === "enabled" ? [{ from: now, to: null }] : [], writerRequires: false, now,
    });
    return readCapability(db, repoId, "semantic")!;
  }
  const sameConfig = existing.config_hash.equals(configHash(config));
  if (existing.state === state && sameConfig) return existing;
  let coverage = existing.coverage;
  if (existing.state !== state) {
    coverage = state === "enabled"
      ? [...coverage, { from: now, to: null }]
      : coverage.map((i, idx) => (idx === coverage.length - 1 && i.to === null ? { from: i.from, to: now } : i));
  }
  writeRow(db, repoId, {
    capability: "semantic", state, interfaceV: existing.interface_v, dataV: existing.data_v, config, coverage, writerRequires: existing.writer_requires, now,
  });
  return readCapability(db, repoId, "semantic")!;
}

/**
 * `embed enable` / `embed disable` (spec/store §5.10, Phase 4b; phase-1-contracts
 * §1.14): the semantic row is the verbs' to flip. `enable` needs the module
 * (`capability_unavailable { semantic, disabled }` otherwise) and a configured
 * provider (`SemanticProviderMissing` — the CLI passes `--provider` to set
 * one first); it sets `state = 'enabled'`, opens a coverage interval, writes
 * the config `{ model?, dim? }` from the effective settings. `disable` closes
 * the interval and sets `disabled`; the vectors stay (`embed drain --prune` is
 * the purge), the provider setting stays — `semantic()`, `blocks_resolve`'s
 * vector leg and the drain then refuse with `capability_unavailable { semantic,
 * disabled, fix: "omg embed enable" }` (`semanticSwitchedOff`). Both idempotent.
 */
export function enableSemantic(db: Database, repoId: string, opts: { now?: string } = {}): SemanticLifecycleResult {
  if (!capabilitiesOf(db).semantic) throw CapabilityUnavailable.semanticDisabled();
  const now = opts.now ?? new Date().toISOString();
  if (!semanticProviderConfigured(db, repoId)) throw new SemanticProviderMissing();
  const existing = readCapability(db, repoId, "semantic");
  const config = semanticConfigOf(db, repoId);
  if (existing && existing.state === "enabled") {
    if (existing.config_hash.equals(configHash(config))) return { row: existing, changed: false };
    writeRow(db, repoId, { capability: "semantic", state: "enabled", interfaceV: existing.interface_v, dataV: existing.data_v, config, coverage: existing.coverage, writerRequires: existing.writer_requires, now });
    return { row: readCapability(db, repoId, "semantic")!, changed: true };
  }
  writeRow(db, repoId, {
    capability: "semantic", state: "enabled", interfaceV: existing?.interface_v ?? SEMANTIC_INTERFACE_V, dataV: existing?.data_v ?? SEMANTIC_DATA_V, config,
    coverage: [...(existing?.coverage ?? []), { from: now, to: null }], writerRequires: existing?.writer_requires ?? false, now,
  });
  return { row: readCapability(db, repoId, "semantic")!, changed: true };
}

export function disableSemantic(db: Database, repoId: string, opts: { now?: string } = {}): SemanticLifecycleResult {
  const now = opts.now ?? new Date().toISOString();
  const existing = readCapability(db, repoId, "semantic");
  if (!existing || existing.state === "disabled") {
    if (existing) return { row: existing, changed: false };
    writeRow(db, repoId, { capability: "semantic", state: "disabled", interfaceV: SEMANTIC_INTERFACE_V, dataV: SEMANTIC_DATA_V, config: semanticConfigOf(db, repoId), coverage: [], writerRequires: false, now });
    return { row: readCapability(db, repoId, "semantic")!, changed: false };
  }
  const coverage = existing.coverage.map((i, idx) => (idx === existing.coverage.length - 1 && i.to === null ? { from: i.from, to: now } : i));
  writeRow(db, repoId, { capability: "semantic", state: "disabled", interfaceV: existing.interface_v, dataV: existing.data_v, config: existing.config, coverage, writerRequires: existing.writer_requires, now });
  return { row: readCapability(db, repoId, "semantic")!, changed: true };
}

export interface SemanticLifecycleResult {
  row: ManifestRow;
  changed: boolean;
}

/** `embed enable` without a configured provider: nothing to enable (the CLI renders it as a usage error with the `--provider` hint). */
export class SemanticProviderMissing extends Error {
  readonly code = "provider_unavailable" as const;
  constructor() {
    super(SEMANTIC_PROVIDER_MISSING_MESSAGE);
    this.name = "SemanticProviderMissing";
  }
}
/** Byte for byte in both engines. */
export const SEMANTIC_PROVIDER_MISSING_MESSAGE = "no embedding provider configured — pass --provider <command|url>, or set one with omg config set embedding.provider <command|url>";

/**
 * spec/store §5.10 (Phase 4b): is the repository's semantic row switched OFF
 * while a provider is configured — the state only `omg embed disable` leaves
 * (a row born `disabled` has no provider, and a provider change re-derives the
 * row)? When true the semantic paths refuse with `semanticSwitchedOff()`.
 */
export function semanticSwitchedOff(db: Database, repoId: string): boolean {
  if (!capabilitiesOf(db).semantic) return false;
  const row = readCapability(db, repoId, "semantic");
  return row !== null && row.state === "disabled" && semanticProviderConfigured(db, repoId);
}

/** The effective `embedding.provider` of a repository (the string, or null) — what a settings write compares before and after (spec/store §5.10). */
export function semanticProviderOf(db: Database, repoId: string): string | null {
  const embedding = effectiveSettingsOf(db, repoId).embedding;
  if (!isRecord(embedding)) return null;
  const provider = embedding.provider;
  return typeof provider === "string" && provider.trim() !== "" ? provider : null;
}

/**
 * Both rows for a repository that has none yet: the history row with coverage
 * from `from` (its birth at `ensure_repo`; its first commit's `ts` on
 * migration) and the semantic row from the settings. Idempotent.
 */
export function ensureManifest(db: Database, repoId: string, from: string, now: string, opts: { history?: boolean } = {}): void {
  ensureHistoryManifest(db, repoId, from, now, opts);
  // An existing semantic row keeps its state (spec/store §5.10: the verbs and a provider change flip it, not a re-open).
  refreshSemanticManifest(db, repoId, now, { flip: false });
}

/** Every repository's semantic row re-derived (a WORKSPACE-layer settings write touches them all); `flipped` names the repositories whose effective provider changed (spec/store §5.10) — the others keep their state. */
export function refreshSemanticManifests(db: Database, now: string, flipped?: ReadonlySet<string>): void {
  if (!manifestTableExists(db)) return;
  const repos = db.prepare("SELECT repo_id FROM repos ORDER BY rowid").all() as { repo_id: string }[];
  for (const r of repos) refreshSemanticManifest(db, r.repo_id, now, { flip: flipped === undefined || flipped.has(r.repo_id) });
}

/** The alert a refused writer raises (spec/store §3.1 `alerts`; §7 resolution 17). */
export const WRITER_REFUSED_ALERT = "writer_refused";

/**
 * spec/store §5.4 step 0 (17.0, 3e-ii — resolution 17; reachable since Phase
 * 4a): a writer without the history module must refuse to write on a
 * repository whose manifest says `history` is `enabled` with `writer_requires
 * = 1`. The refusal is `capability_unavailable { capability: "history", state:
 * "unavailable" }` (retriable: the right engine can) and raises the
 * `writer_refused` alert so the stall is visible where the user works; a write
 * that passes clears it (through an engine with the module, or because capture
 * was switched off). A repository whose row is `disabled` writes freely and
 * captures nothing. Call it OUTSIDE the write transaction (the alert must
 * survive the refusal): `ingestFile`, `observeBatch`, `runPhases` do; the
 * check inside `ingestInto` is the guard for a caller that did not.
 */
export function requireWriter(db: Database, repoId: string, now: string = new Date().toISOString()): void {
  const row = readCapability(db, repoId, "history");
  const required = row !== null && row.state === "enabled" && row.writer_requires;
  const present = capabilitiesOf(db).history !== null;
  if (required && !present) {
    raiseAlert(db, repoId, { code: WRITER_REFUSED_ALERT, severity: "error", message: WRITER_REFUSED_MESSAGE, detail: { capability: "history" } }, now);
    throw CapabilityUnavailable.historyWriterRequired();
  }
  // A write that passes ends the condition — through an engine with the module, or because capture was turned off.
  clearAlert(db, repoId, WRITER_REFUSED_ALERT, now);
}

/** Step 0 then step 15's recorder: the refusal check, then the recorder a commit on `repoId` captures through (null = uncaptured). */
export function writerFor(db: Database, repoId: string, now: string): HistoryRecorder | null {
  requireWriter(db, repoId, now);
  return captureFor(db, repoId);
}

/** The alert a failed capture raises (spec/store §5.8; resolution 18). */
export const CAPTURE_FAILED_ALERT = "capture_failed";

/**
 * Raise `capture_failed` for the member whose capture threw (after the
 * rollback — the transaction's owner calls this): `error`, detail `{ path,
 * reason }`. The row is retried by the next sweep; a later capture of the same
 * path clears it (`clearCaptureFailed`).
 */
export function raiseCaptureFailed(db: Database, repoId: string, failure: CaptureFailed, now: string): void {
  const path = failure.path === null ? null : alertPath(failure.path);
  raiseAlert(db, repoId, {
    code: CAPTURE_FAILED_ALERT, severity: "error", message: captureFailedMessage(path, failure.reason),
    detail: { ...(path !== null ? { path } : {}), reason: failure.reason },
  }, now);
}

/** A successful capture of `path` ends its failure condition: the active `capture_failed` alert about this path is cleared. Runs in the commit's transaction. */
export function clearCaptureFailed(db: Database, repoId: string, path: string, now: string): void {
  db.prepare("UPDATE alerts SET cleared_at = ? WHERE repo_id = ? AND code = ? AND cleared_at IS NULL AND json_extract(detail, '$.path') = ?").run(now, repoId, CAPTURE_FAILED_ALERT, alertPath(path));
}

/** An alert names a path in the reference form (`/a.md`), as the materialization alerts do. */
function alertPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * The recorder a history TOOL reads through, or the refusal (spec/surface §2.1;
 * Phase 4a): `capability_unavailable { history, unavailable }` on a composition
 * without the module, `{ history, disabled }` when nothing was ever captured in
 * this database (no bundle) — the reads of a repository whose capture is off
 * but whose rows exist go through (what was captured stays readable).
 */
export function requireHistoryReader(db: Database): HistoryRecorder {
  const history = capabilitiesOf(db).history;
  if (!history) throw CapabilityUnavailable.historyUnavailable();
  if (!historyBundlePresent(db)) throw CapabilityUnavailable.historyDisabled();
  return history;
}

/** The `writer_refused` alert's message, byte for byte in both engines. */
export const WRITER_REFUSED_MESSAGE =
  "a writer without the history module was refused: this repository requires capture (writer_requires) — write through an engine that carries the history module, or run omg history disable";
