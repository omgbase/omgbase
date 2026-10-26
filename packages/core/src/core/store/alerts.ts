import type { Database } from "better-sqlite3";
import { effectiveSettingsOf } from "./settings.js";

// The alert channel (spec/store §3.1 `alerts`, §5.8; spec/surface §4 "Alerts";
// spec/cli §3.1 — modular-core Phase 3e-ii, phase-1-contracts §7 "+"). One row
// per (repository, condition) the engine raised because a human is needed, kept
// while the condition stands and cleared (`cleared_at`) when it ends: a
// MATERIALIZATION BACKLOG (pending rows older than `recovery.alert_after_minutes`,
// default 10 — the api path owes the working tree files it has not been able
// to write), a REPLAY FAILURE (`materialization_failed`: a pending row's replay
// threw — the row is intact and retried forever, resolution 18), a WRITER
// REFUSED by `writer_requires` (`writer_refused`, `core/store/manifest.ts`).
// Every MCP tool response carries the ACTIVE alerts of the call's repository in
// a top-level `alerts` member when there are any (as a query result carries
// `hints`), the CLI prints `alert[<severity>] <code>: <message>` lines to
// stderr after a command, `doctor` lists them under an `alerts` check.
//
// Derivable conditions are re-evaluated whenever the channel is read
// (`activeAlerts` → `refreshAlerts`): the table remembers `since` and the
// message, the condition itself is always current. Raising is idempotent
// (message/detail refreshed, `since` kept); a cleared row is re-raised in
// place with a new `since`; nothing is written when nothing changed, so a
// read-only path that lists alerts does not write.

export type AlertSeverity = "info" | "warning" | "error";

export interface Alert {
  code: string;
  severity: AlertSeverity;
  message: string;
  /** first raised (RFC 3339, the store's time format) */
  since: string;
  /** what the condition is about; absent on the wire when `{}` */
  detail?: Record<string, unknown>;
}

export interface AlertInput {
  code: string;
  severity: AlertSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

/** The materialization backlog alert (a `warning`): pending rows older than the threshold. */
export const MATERIALIZATION_BACKLOG_ALERT = "materialization_backlog";
/** The replay-failure alert (an `error`): a pending row's replay threw. */
export const MATERIALIZATION_FAILED_ALERT = "materialization_failed";

/** `recovery.alert_after_minutes`: how old a pending row may be before the backlog alert is raised. */
export const RECOVERY_SETTINGS_KEY = "recovery";
export const RECOVERY_ALERT_AFTER_MINUTES_DEFAULT = 10;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The effective `recovery.alert_after_minutes` of a repository (a non-negative number; the default for anything else). */
export function alertAfterMinutes(db: Database, repoId: string): number {
  const recovery = effectiveSettingsOf(db, repoId)[RECOVERY_SETTINGS_KEY];
  const v = isRecord(recovery) ? recovery.alert_after_minutes : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : RECOVERY_ALERT_AFTER_MINUTES_DEFAULT;
}

function alertsTableExists(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alerts'").get();
}

interface RawRow { code: string; severity: string; message: string; since: string; detail: string; cleared_at: string | null }

function detailOf(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

/** The canonical JSON of a detail (keys sorted), so an unchanged detail compares equal and both engines store the same bytes. */
function canonicalDetail(detail: Record<string, unknown> | undefined): string {
  const canon = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
    if (isRecord(v)) return `{${Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
    return JSON.stringify(v);
  };
  return canon(detail ?? {});
}

/**
 * Raise `alert` for `repoId` at `now`: a new or cleared row is written with
 * `since = now`; an active row keeps its `since` and takes the new message,
 * severity and detail (no write when they are unchanged). Idempotent.
 */
export function raiseAlert(db: Database, repoId: string, alert: AlertInput, now: string): void {
  const detail = canonicalDetail(alert.detail);
  const existing = db.prepare("SELECT code, severity, message, since, detail, cleared_at FROM alerts WHERE repo_id = ? AND code = ?").get(repoId, alert.code) as RawRow | undefined;
  if (existing && existing.cleared_at === null) {
    if (existing.severity === alert.severity && existing.message === alert.message && existing.detail === detail) return;
    db.prepare("UPDATE alerts SET severity = ?, message = ?, detail = ? WHERE repo_id = ? AND code = ?").run(alert.severity, alert.message, detail, repoId, alert.code);
    return;
  }
  db.prepare(
    `INSERT INTO alerts (repo_id, code, severity, message, since, detail, cleared_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (repo_id, code) DO UPDATE SET severity = excluded.severity, message = excluded.message, since = excluded.since, detail = excluded.detail, cleared_at = NULL`,
  ).run(repoId, alert.code, alert.severity, alert.message, now, detail);
}

/** Clear an active alert (`cleared_at = now`); a missing or already cleared row is left alone. Returns whether a row was cleared. */
export function clearAlert(db: Database, repoId: string, code: string, now: string): boolean {
  if (!alertsTableExists(db)) return false;
  return db.prepare("UPDATE alerts SET cleared_at = ? WHERE repo_id = ? AND code = ? AND cleared_at IS NULL").run(now, repoId, code).changes > 0;
}

/** The active alerts of a repository as the wire carries them, by (`since`, `code`); `detail` omitted when `{}`. */
export function listActiveAlerts(db: Database, repoId: string): Alert[] {
  if (!alertsTableExists(db)) return [];
  const rows = db.prepare("SELECT code, severity, message, since, detail, cleared_at FROM alerts WHERE repo_id = ? AND cleared_at IS NULL ORDER BY since, code").all(repoId) as RawRow[];
  return rows.map((r) => {
    const detail = detailOf(r.detail);
    const out: Alert = { code: r.code, severity: r.severity as AlertSeverity, message: r.message, since: r.since };
    if (Object.keys(detail).length > 0) out.detail = detail;
    return out;
  });
}

/** The backlog message, byte for byte in both engines. */
export function materializationBacklogMessage(pending: number, oldest: string, thresholdMinutes: number): string {
  return `${pending} pending materialization${pending === 1 ? "" : "s"} older than ${thresholdMinutes} minutes (oldest ${oldest}): the api path still owes the working tree these files — omg sync replays them`;
}

/** The replay-failure message, byte for byte in both engines. */
export function materializationFailedMessage(path: string, reason: string): string {
  return `replaying the pending materialization of ${path} failed: ${reason} — the row is kept and retried on the next sweep`;
}

/**
 * Re-derive the backlog condition (spec/store §5.8): the pending rows of the
 * repository whose `created_at` is at or before `now − recovery.alert_after_minutes`.
 * Some → `materialization_backlog` raised (`warning`, detail `{ pending, oldest,
 * threshold_minutes }`); none → cleared. Runs wherever the channel is read and
 * after every replay.
 */
export function refreshBacklogAlert(db: Database, repoId: string, now: string): void {
  if (!alertsTableExists(db)) return;
  const minutes = alertAfterMinutes(db, repoId);
  const cutoff = new Date(Date.parse(now) - minutes * 60_000).toISOString();
  const r = db
    .prepare("SELECT count(*) AS n, min(created_at) AS oldest FROM pending_materializations WHERE repo_id = ? AND created_at <= ?")
    .get(repoId, cutoff) as { n: number; oldest: string | null };
  if (r.n > 0 && r.oldest !== null) {
    raiseAlert(db, repoId, {
      code: MATERIALIZATION_BACKLOG_ALERT,
      severity: "warning",
      message: materializationBacklogMessage(r.n, r.oldest, minutes),
      detail: { pending: r.n, oldest: r.oldest, threshold_minutes: minutes },
    }, now);
  } else {
    clearAlert(db, repoId, MATERIALIZATION_BACKLOG_ALERT, now);
  }
}

/** Every derivable condition re-evaluated at `now` (the backlog today), then the active alerts. */
export function activeAlerts(db: Database, repoId: string, now: string = new Date().toISOString()): Alert[] {
  refreshBacklogAlert(db, repoId, now);
  return listActiveAlerts(db, repoId);
}
