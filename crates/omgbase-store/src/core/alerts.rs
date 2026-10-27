//! The alert channel (`spec/store` §3.1 `alerts`, §5.8; `spec/surface` §4
//! "Alerts"; `spec/cli` §3.1 — modular-core Phase 3e-ii, phase-1-contracts §7
//! "+"). One row per (repository, condition) the engine raised because a
//! human is needed, kept while the condition stands and cleared
//! (`cleared_at`) when it ends: a MATERIALIZATION BACKLOG (pending rows older
//! than `recovery.alert_after_minutes`, default 10 — the api path owes the
//! working tree files it has not been able to write), a REPLAY FAILURE
//! (`materialization_failed`: a pending row's replay threw — the row is
//! intact and retried forever, resolution 18), a WRITER REFUSED by
//! `writer_requires` (`writer_refused`, [`crate::core::manifest`]). Every MCP
//! tool response carries the ACTIVE alerts of the call's repository in a
//! top-level `alerts` member when there are any, the CLI prints
//! `alert[<severity>] <code>: <message>` lines to stderr after a command,
//! `doctor` lists them under an `alerts` check. Port of
//! `packages/core/src/core/store/alerts.ts`.
//!
//! Derivable conditions are re-evaluated whenever the channel is read
//! ([`active_alerts`] → [`refresh_backlog_alert`]): the table remembers
//! `since` and the message, the condition itself is always current. Raising
//! is idempotent (message/detail refreshed, `since` kept); a cleared row is
//! re-raised in place with a new `since`; nothing is written when nothing
//! changed, so a read-only path that lists alerts does not write.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::core::codec::canonical_json;
use crate::core::settings::effective_settings;
use crate::core::time::{format_ms, parse_ms};
use crate::error::Result;

/// A row's `severity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertSeverity {
    Info,
    Warning,
    Error,
}

impl AlertSeverity {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }

    /// The column's value; anything else is a newer engine's (read as `error`
    /// so it is never hidden).
    #[must_use]
    pub fn parse(s: &str) -> Self {
        match s {
            "info" => Self::Info,
            "warning" => Self::Warning,
            _ => Self::Error,
        }
    }
}

/// One active alert as the wire carries it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub code: String,
    pub severity: AlertSeverity,
    pub message: String,
    /// First raised (RFC 3339, the store's time format).
    pub since: String,
    /// What the condition is about; absent on the wire when `{}`.
    pub detail: Map<String, Json>,
}

impl Alert {
    /// `{ code, severity, message, since, detail? }` — `detail` omitted when `{}`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("code".to_owned(), Json::String(self.code.clone()));
        m.insert(
            "severity".to_owned(),
            Json::String(self.severity.as_str().to_owned()),
        );
        m.insert("message".to_owned(), Json::String(self.message.clone()));
        m.insert("since".to_owned(), Json::String(self.since.clone()));
        if !self.detail.is_empty() {
            m.insert("detail".to_owned(), Json::Object(self.detail.clone()));
        }
        Json::Object(m)
    }
}

/// What a raiser hands [`raise_alert`].
#[derive(Clone, Copy, Debug)]
pub struct AlertInput<'a> {
    pub code: &'a str,
    pub severity: AlertSeverity,
    pub message: &'a str,
    pub detail: Option<&'a Map<String, Json>>,
}

/// The materialization backlog alert (a `warning`): pending rows older than the threshold.
pub const MATERIALIZATION_BACKLOG_ALERT: &str = "materialization_backlog";
/// The replay-failure alert (an `error`): a pending row's replay threw.
pub const MATERIALIZATION_FAILED_ALERT: &str = "materialization_failed";

/// The codes the contracts reserve for Phase 4's raisers (§5.8: no site in
/// 17.0; listed so both engines spell them alike when they arrive).
pub const CAPTURE_FAILED_ALERT: &str = "capture_failed";
pub const SEGMENT_DETACHED_ALERT: &str = "segment_detached";
pub const RECORDER_SCHEMA_UNKNOWN_ALERT: &str = "recorder_schema_unknown";
/// The alert a repository whose history provider cannot run raises
/// (`spec/store` §5.8, §5.12 — 17.5, Phase 6a): `git` not on PATH, or the
/// provider the manifest names not attached by this composition.
pub const HISTORY_PROVIDER_UNAVAILABLE_ALERT: &str = "history_provider_unavailable";

/// `recovery.alert_after_minutes`: how old a pending row may be before the
/// backlog alert is raised.
pub const RECOVERY_SETTINGS_KEY: &str = "recovery";
pub const RECOVERY_ALERT_AFTER_MINUTES_DEFAULT: f64 = 10.0;

/// The effective `recovery.alert_after_minutes` of a repository (a
/// non-negative number; the default for anything else).
pub fn alert_after_minutes(conn: &Connection, repo_id: &str) -> Result<f64> {
    let settings = effective_settings(conn, repo_id)?;
    Ok(settings
        .get(RECOVERY_SETTINGS_KEY)
        .and_then(Json::as_object)
        .and_then(|r| r.get("alert_after_minutes"))
        .and_then(Json::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(RECOVERY_ALERT_AFTER_MINUTES_DEFAULT))
}

/// A JavaScript number as JSON: an integral value prints without a fraction
/// (`10`, as `JSON.stringify(10)`), anything else as the float it is.
fn number_json(v: f64) -> Json {
    #[allow(clippy::cast_possible_truncation)]
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        Json::from(v as i64)
    } else {
        json!(v)
    }
}

fn alerts_table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alerts'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn detail_of(json: &str) -> Map<String, Json> {
    match serde_json::from_str::<Json>(json) {
        Ok(Json::Object(m)) => m,
        _ => Map::new(),
    }
}

/// The canonical JSON of a detail (keys sorted), so an unchanged detail
/// compares equal and both engines store the same bytes.
fn canonical_detail(detail: Option<&Map<String, Json>>) -> String {
    match detail {
        Some(d) => canonical_json(&Json::Object(d.clone())),
        None => "{}".to_owned(),
    }
}

/// Raise `alert` for `repo_id` at `now`: a new or cleared row is written
/// with `since = now`; an active row keeps its `since` and takes the new
/// message, severity and detail (no write when they are unchanged).
/// Idempotent.
pub fn raise_alert(
    conn: &Connection,
    repo_id: &str,
    alert: &AlertInput<'_>,
    now: &str,
) -> Result<()> {
    let detail = canonical_detail(alert.detail);
    let existing: Option<(String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT severity, message, detail, cleared_at FROM alerts WHERE repo_id = ?1 AND code = ?2",
            params![repo_id, alert.code],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    if let Some((severity, message, existing_detail, None)) = existing {
        if severity == alert.severity.as_str()
            && message == alert.message
            && existing_detail == detail
        {
            return Ok(());
        }
        conn.execute(
            "UPDATE alerts SET severity = ?1, message = ?2, detail = ?3 WHERE repo_id = ?4 AND code = ?5",
            params![alert.severity.as_str(), alert.message, detail, repo_id, alert.code],
        )?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO alerts (repo_id, code, severity, message, since, detail, cleared_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
         ON CONFLICT (repo_id, code) DO UPDATE SET severity = excluded.severity, message = excluded.message, since = excluded.since, detail = excluded.detail, cleared_at = NULL",
        params![repo_id, alert.code, alert.severity.as_str(), alert.message, now, detail],
    )?;
    Ok(())
}

/// Clear an active alert (`cleared_at = now`); a missing or already cleared
/// row is left alone. Returns whether a row was cleared.
pub fn clear_alert(conn: &Connection, repo_id: &str, code: &str, now: &str) -> Result<bool> {
    if !alerts_table_exists(conn)? {
        return Ok(false);
    }
    let changed = conn.execute(
        "UPDATE alerts SET cleared_at = ?1 WHERE repo_id = ?2 AND code = ?3 AND cleared_at IS NULL",
        params![now, repo_id, code],
    )?;
    Ok(changed > 0)
}

/// The active alerts of a repository as the wire carries them, by (`since`,
/// `code`); `detail` omitted when `{}`.
pub fn list_active_alerts(conn: &Connection, repo_id: &str) -> Result<Vec<Alert>> {
    if !alerts_table_exists(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT code, severity, message, since, detail FROM alerts WHERE repo_id = ?1 AND cleared_at IS NULL ORDER BY since, code",
    )?;
    let rows = stmt.query_map(params![repo_id], |r| {
        let severity: String = r.get(1)?;
        let detail: String = r.get(4)?;
        Ok(Alert {
            code: r.get(0)?,
            severity: AlertSeverity::parse(&severity),
            message: r.get(2)?,
            since: r.get(3)?,
            detail: detail_of(&detail),
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// The backlog message, byte for byte in both engines.
#[must_use]
pub fn materialization_backlog_message(
    pending: i64,
    oldest: &str,
    threshold_minutes: f64,
) -> String {
    format!(
        "{pending} pending materialization{} older than {} minutes (oldest {oldest}): the api path still owes the working tree these files — omg sync replays them",
        if pending == 1 { "" } else { "s" },
        number_json(threshold_minutes)
    )
}

/// The replay-failure message, byte for byte in both engines.
#[must_use]
pub fn materialization_failed_message(path: &str, reason: &str) -> String {
    format!(
        "replaying the pending materialization of {path} failed: {reason} — the row is kept and retried on the next sweep"
    )
}

/// Re-derive the backlog condition (`spec/store` §5.8): the pending rows of
/// the repository whose `created_at` is at or before `now −
/// recovery.alert_after_minutes`. Some → `materialization_backlog` raised
/// (`warning`, detail `{ pending, oldest, threshold_minutes }`); none →
/// cleared. Runs wherever the channel is read and after every replay.
pub fn refresh_backlog_alert(conn: &Connection, repo_id: &str, now: &str) -> Result<()> {
    if !alerts_table_exists(conn)? {
        return Ok(());
    }
    let minutes = alert_after_minutes(conn, repo_id)?;
    // `new Date(Date.parse(now) - minutes * 60_000)`: the fractional
    // millisecond truncated, as JavaScript's TimeClip does.
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let cutoff_ms = (parse_ms(now)? as f64 - minutes * 60_000.0).trunc() as i64;
    let cutoff = format_ms(cutoff_ms);
    let (n, oldest): (i64, Option<String>) = conn.query_row(
        "SELECT count(*), min(created_at) FROM pending_materializations WHERE repo_id = ?1 AND created_at <= ?2",
        params![repo_id, cutoff],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    match oldest {
        Some(oldest) if n > 0 => {
            let mut detail = Map::new();
            detail.insert("pending".to_owned(), Json::from(n));
            detail.insert("oldest".to_owned(), Json::String(oldest.clone()));
            detail.insert("threshold_minutes".to_owned(), number_json(minutes));
            raise_alert(
                conn,
                repo_id,
                &AlertInput {
                    code: MATERIALIZATION_BACKLOG_ALERT,
                    severity: AlertSeverity::Warning,
                    message: &materialization_backlog_message(n, &oldest, minutes),
                    detail: Some(&detail),
                },
                now,
            )
        }
        _ => clear_alert(conn, repo_id, MATERIALIZATION_BACKLOG_ALERT, now).map(|_| ()),
    }
}

/// Every derivable condition re-evaluated at `now` (the backlog today), then
/// the active alerts.
pub fn active_alerts(conn: &Connection, repo_id: &str, now: &str) -> Result<Vec<Alert>> {
    refresh_backlog_alert(conn, repo_id, now)?;
    list_active_alerts(conn, repo_id)
}

/// The active alerts as the wire carries them (`spec/surface` §4 "Alerts"):
/// a JSON array of [`Alert::to_json`].
pub fn active_alerts_json(conn: &Connection, repo_id: &str, now: &str) -> Result<Json> {
    Ok(Json::Array(
        active_alerts(conn, repo_id, now)?
            .iter()
            .map(Alert::to_json)
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc_store::{DocStore, NullDocStore};
    use crate::{BatchItem, Config, SequentialMinter, Store};

    const T0: &str = "2026-09-26T10:00:00.000Z";
    const T5: &str = "2026-09-26T10:05:00.000Z";
    const T10: &str = "2026-09-26T10:10:00.000Z";
    const T20: &str = "2026-09-26T10:20:00.000Z";

    fn store() -> (Store, String) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        (store, repo)
    }

    fn observe(store: &mut Store, repo: &str) {
        store
            .observe_batch(
                repo,
                &[BatchItem::observed("a.md", "# A\n\nbody\n")],
                T0,
                &Config::default(),
            )
            .unwrap();
    }

    fn plant_pending(store: &Store, repo: &str, created_at: &str) {
        store
            .conn()
            .execute(
                "INSERT INTO pending_materializations (repo_id, path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at)
                 SELECT repo_id, path, 'write', NULL, doc_id, head, file_hash, file_hash, 'c_0', ?1 FROM docs WHERE repo_id = ?2 AND path = 'a.md'",
                params![created_at, repo],
            )
            .unwrap();
    }

    fn input<'a>(
        code: &'a str,
        severity: AlertSeverity,
        message: &'a str,
        detail: Option<&'a Map<String, Json>>,
    ) -> AlertInput<'a> {
        AlertInput {
            code,
            severity,
            message,
            detail,
        }
    }

    fn codes(alerts: &[Alert]) -> Vec<&str> {
        alerts.iter().map(|a| a.code.as_str()).collect()
    }

    #[test]
    fn raising_is_idempotent_since_kept_detail_canonical_and_omitted_when_empty() {
        let (store, repo) = store();
        let conn = store.conn();
        raise_alert(
            conn,
            &repo,
            &input("x", AlertSeverity::Warning, "one", None),
            T0,
        )
        .unwrap();
        let detail = json!({ "n": 2, "a": [1] }).as_object().cloned().unwrap();
        raise_alert(
            conn,
            &repo,
            &input("x", AlertSeverity::Error, "two", Some(&detail)),
            T5,
        )
        .unwrap();
        let active = list_active_alerts(conn, &repo).unwrap();
        assert_eq!(
            active.iter().map(Alert::to_json).collect::<Vec<_>>(),
            [
                json!({ "code": "x", "severity": "error", "message": "two", "since": T0, "detail": { "n": 2, "a": [1] } })
            ]
        );
        let stored: String = conn
            .query_row("SELECT detail FROM alerts WHERE code = 'x'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stored, r#"{"a":[1],"n":2}"#);
        // Clear stamps cleared_at and hides the row; a cleared row re-raises
        // in place with a new since.
        assert!(clear_alert(conn, &repo, "x", T5).unwrap());
        assert!(!clear_alert(conn, &repo, "x", T5).unwrap());
        assert!(list_active_alerts(conn, &repo).unwrap().is_empty());
        let cleared: Option<String> = conn
            .query_row("SELECT cleared_at FROM alerts WHERE code = 'x'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(cleared.as_deref(), Some(T5));
        raise_alert(
            conn,
            &repo,
            &input("x", AlertSeverity::Info, "m", None),
            T10,
        )
        .unwrap();
        assert_eq!(
            list_active_alerts(conn, &repo)
                .unwrap()
                .iter()
                .map(Alert::to_json)
                .collect::<Vec<_>>(),
            [json!({ "code": "x", "severity": "info", "message": "m", "since": T10 })]
        );
        let n: i64 = conn
            .query_row("SELECT count(*) FROM alerts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn lists_by_since_then_code_per_repository() {
        let (mut store, repo) = store();
        let other = store.create_repo("other").unwrap();
        let conn = store.conn();
        for (r, code, at) in [
            (&repo, "b", T5),
            (&repo, "a", T5),
            (&repo, "c", T0),
            (&other, "z", T0),
        ] {
            raise_alert(conn, r, &input(code, AlertSeverity::Info, "m", None), at).unwrap();
        }
        assert_eq!(
            codes(&list_active_alerts(conn, &repo).unwrap()),
            ["c", "a", "b"]
        );
        assert_eq!(codes(&list_active_alerts(conn, &other).unwrap()), ["z"]);
    }

    #[test]
    fn the_backlog_is_raised_past_the_threshold_re_derived_on_read_and_cleared_when_the_rows_go() {
        let (mut store, repo) = store();
        observe(&mut store, &repo);
        let conn = store.conn();
        assert_eq!(alert_after_minutes(conn, &repo).unwrap(), 10.0);
        plant_pending(&store, &repo, T0);
        assert!(
            active_alerts(conn, &repo, T5).unwrap().is_empty(),
            "five minutes: below the threshold"
        );
        let at_ten = active_alerts(conn, &repo, T10).unwrap();
        assert_eq!(
            at_ten.iter().map(Alert::to_json).collect::<Vec<_>>(),
            [json!({
                "code": MATERIALIZATION_BACKLOG_ALERT,
                "severity": "warning",
                "message": materialization_backlog_message(1, T0, 10.0),
                "since": T10,
                "detail": { "pending": 1, "oldest": T0, "threshold_minutes": 10 },
            })]
        );
        assert_eq!(
            materialization_backlog_message(1, T0, 10.0),
            "1 pending materialization older than 10 minutes (oldest 2026-09-26T10:00:00.000Z): the api path still owes the working tree these files — omg sync replays them"
        );
        assert!(
            materialization_backlog_message(2, T0, 10.0)
                .starts_with("2 pending materializations older")
        );
        assert!(materialization_backlog_message(1, T0, 2.5).contains("older than 2.5 minutes"));
        // Still standing later: since is kept.
        assert_eq!(active_alerts(conn, &repo, T20).unwrap()[0].since, T10);
        conn.execute(
            "DELETE FROM pending_materializations WHERE repo_id = ?1",
            params![repo],
        )
        .unwrap();
        assert!(active_alerts(conn, &repo, T20).unwrap().is_empty());
        let cleared: Option<String> = conn
            .query_row(
                "SELECT cleared_at FROM alerts WHERE code = ?1",
                params![MATERIALIZATION_BACKLOG_ALERT],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cleared.as_deref(), Some(T20));
    }

    #[test]
    fn honors_the_repository_setting_and_a_quiet_read_writes_nothing() {
        let (mut store, repo) = store();
        observe(&mut store, &repo);
        let conn = store.conn();
        conn.execute(
            "UPDATE repos SET settings = ?1 WHERE repo_id = ?2",
            params![r#"{"recovery":{"alert_after_minutes":2}}"#, repo],
        )
        .unwrap();
        assert_eq!(alert_after_minutes(conn, &repo).unwrap(), 2.0);
        plant_pending(&store, &repo, T0);
        let detail: Vec<Json> = active_alerts(conn, &repo, T5)
            .unwrap()
            .iter()
            .map(|a| Json::Object(a.detail.clone()))
            .collect();
        assert_eq!(
            detail,
            [json!({ "pending": 1, "oldest": T0, "threshold_minutes": 2 })]
        );
        conn.execute(
            "UPDATE repos SET settings = ?1 WHERE repo_id = ?2",
            params![r#"{"recovery":{"alert_after_minutes":"soon"}}"#, repo],
        )
        .unwrap();
        assert_eq!(
            alert_after_minutes(conn, &repo).unwrap(),
            10.0,
            "not a number: the default"
        );
        // A read of a quiet repository writes nothing.
        let (mut quiet, repo) = self::store();
        observe(&mut quiet, &repo);
        refresh_backlog_alert(quiet.conn(), &repo, T20).unwrap();
        let n: i64 = quiet
            .conn()
            .query_row("SELECT count(*) FROM alerts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    struct FailingStore;

    impl DocStore for FailingStore {
        fn exists(&self, _path: &str) -> bool {
            false
        }
        fn read(&self, _path: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn write(&mut self, path: &str, _bytes: &str) -> Result<()> {
            Err(crate::Error::Other(format!("EACCES: cannot write {path}")))
        }
        fn rename(&mut self, _from: &str, _to: &str) -> Result<()> {
            Ok(())
        }
        fn remove(&mut self, _path: &str) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_replay_that_fails_raises_materialization_failed_keeps_the_row_and_a_clean_pass_clears_it()
    {
        let (mut store, repo) = store();
        observe(&mut store, &repo);
        plant_pending(&store, &repo, T0);
        let err = store
            .materialize_pending_at(&repo, &mut FailingStore, T20)
            .unwrap_err();
        assert!(err.to_string().contains("EACCES"));
        let active = list_active_alerts(store.conn(), &repo).unwrap();
        let mut have = codes(&active);
        have.sort_unstable();
        assert_eq!(
            have,
            [MATERIALIZATION_BACKLOG_ALERT, MATERIALIZATION_FAILED_ALERT]
        );
        let failed = active
            .iter()
            .find(|a| a.code == MATERIALIZATION_FAILED_ALERT)
            .unwrap();
        assert_eq!(failed.severity, AlertSeverity::Error);
        assert_eq!(
            failed.message,
            materialization_failed_message("/a.md", "EACCES: cannot write a.md")
        );
        assert_eq!(
            Json::Object(failed.detail.clone()),
            json!({ "path": "/a.md", "kind": "write", "reason": "EACCES: cannot write a.md" })
        );
        let n: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM pending_materializations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
        // A store that takes the write: the row is cleared, both alerts end.
        let cleared = store
            .materialize_pending_at(&repo, &mut NullDocStore, T20)
            .unwrap();
        assert_eq!(cleared, ["a.md"]);
        assert!(list_active_alerts(store.conn(), &repo).unwrap().is_empty());
    }
}
