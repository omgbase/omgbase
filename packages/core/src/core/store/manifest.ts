import type { Database } from "better-sqlite3";
import { sha256 } from "../hash.js";
import { effectiveSettingsOf } from "./settings.js";
import { capabilitiesOf } from "../capabilities/registry.js";
import { CapabilityUnavailable, type CapabilityName } from "../capabilities/errors.js";
import { clearAlert, raiseAlert } from "./alerts.js";

// The capability manifest (spec/store §3.1 `capabilities`, 17.0 — modular-core
// Phase 3e-ii; phase-1-contracts §1.5, §1.14, §1.16 step 11, §7 resolutions 1
// and 17). One row per (repository, capability): `state`, the interface and
// data versions the bundle's rows were produced under, the `config` they were
// produced under with its sha256 fingerprint, the COVERAGE intervals capture
// was on (`[{ from, to }]`, the last open iff enabled) and `writer_requires`.
//
// Who writes it. `ensure_repo` (`core/attach.ts`) writes both rows for a new
// repository — history `enabled` with coverage from the repository's birth and
// `writer_requires = 1` (resolution 17: a writer without the recorder refuses),
// semantic `enabled` iff `embedding.provider` resolves for the repository
// (resolution 1: vectors are never consulted) — and migration 17 does the same
// for every existing repository (coverage from its first commit). Until the
// Phase 4 verbs (`history enable|disable|purge`, `embed enable|disable`) exist,
// the semantic row FOLLOWS the setting: every settings write re-derives it
// (`refreshSemanticManifest`, called by `sync/settings.ts`), opening or closing
// a coverage interval when the state flips. The history row is flipped by
// nothing in 17.0 (3e-ii): every composition carries the recorder.
//
// Who reads it. `version.capabilities` and `capability_unavailable`'s state
// (`sync/capability-state.ts`), `doctor --size`'s `capabilities` member and
// the `history`/`semantic` file lines (`core/store/size.ts`), and every writer
// through `requireWriter` below.

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
 * The history row a repository gets when capture starts (`ensure_repo`,
 * migration 17): `enabled`, interface/data 1, `config {}`, one open coverage
 * interval from `from`, `writer_requires` per `writerRequires` (default 1 —
 * resolution 17). Idempotent: an existing row is left alone (the manifest is
 * engine state, never re-derived from elsewhere).
 */
export function ensureHistoryManifest(db: Database, repoId: string, from: string, now: string, writerRequires = true): ManifestRow {
  const existing = readCapability(db, repoId, "history");
  if (existing) return existing;
  writeRow(db, repoId, {
    capability: "history", state: "enabled", interfaceV: HISTORY_INTERFACE_V, dataV: HISTORY_DATA_V, config: {},
    coverage: [{ from, to: null }], writerRequires, now,
  });
  return readCapability(db, repoId, "history")!;
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
export function refreshSemanticManifest(db: Database, repoId: string, now: string): ManifestRow {
  if (!manifestTableExists(db)) throw new Error("the capabilities table is missing — open the store through Store first");
  const state: ManifestState = semanticProviderConfigured(db, repoId) ? "enabled" : "disabled";
  const config = semanticConfigOf(db, repoId);
  const existing = readCapability(db, repoId, "semantic");
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
 * Both rows for a repository that has none yet: the history row with coverage
 * from `from` (its birth at `ensure_repo`; its first commit's `ts` on
 * migration) and the semantic row from the settings. Idempotent.
 */
export function ensureManifest(db: Database, repoId: string, from: string, now: string): void {
  ensureHistoryManifest(db, repoId, from, now);
  refreshSemanticManifest(db, repoId, now);
}

/** Every repository's semantic row re-derived (a WORKSPACE-layer settings write touches them all). */
export function refreshSemanticManifests(db: Database, now: string): void {
  if (!manifestTableExists(db)) return;
  const repos = db.prepare("SELECT repo_id FROM repos ORDER BY rowid").all() as { repo_id: string }[];
  for (const r of repos) refreshSemanticManifest(db, r.repo_id, now);
}

/** The alert a refused writer raises (spec/store §3.1 `alerts`; §7 resolution 17). */
export const WRITER_REFUSED_ALERT = "writer_refused";

/**
 * spec/store §5.4 step 0 (17.0, 3e-ii — resolution 17): a writer without the
 * history module must refuse to write on a repository whose manifest says
 * `history` is `enabled` with `writer_requires = 1`. The refusal is
 * `capability_unavailable { capability: "history", state: "unavailable" }`
 * (retriable: the right engine can) and raises the `writer_refused` alert so
 * the stall is visible where the user works; a write that passes clears it.
 * Through 17.0 every composition carries the recorder, so the refusal is
 * unreachable in production — the check and its shape are pinned here for
 * Phase 4, when the core-only composition drops the recorder.
 */
export function requireWriter(db: Database, repoId: string, now: string = new Date().toISOString()): void {
  const row = readCapability(db, repoId, "history");
  const required = row !== null && row.state === "enabled" && row.writer_requires;
  const present = capabilitiesOf(db).history !== null;
  if (required && !present) {
    raiseAlert(db, repoId, { code: WRITER_REFUSED_ALERT, severity: "error", message: WRITER_REFUSED_MESSAGE, detail: { capability: "history" } }, now);
    throw CapabilityUnavailable.historyWriterRequired();
  }
  if (present) clearAlert(db, repoId, WRITER_REFUSED_ALERT, now);
}

/** The `writer_refused` alert's message, byte for byte in both engines. */
export const WRITER_REFUSED_MESSAGE =
  "a writer without the history module was refused: this repository requires capture (writer_requires) — write through an engine that carries the history module, or run omg history disable";
