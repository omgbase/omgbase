//! The capability manifest (`spec/store` §3.1 `capabilities`, 17.0 —
//! modular-core Phase 3e-ii; `docs/modular-core/phase-1-contracts.md` §1.5,
//! §1.14, §1.16 step 11, §7 resolutions 1 and 17). One row per (repository,
//! capability): `state`, the interface and data versions the bundle's rows
//! were produced under, the `config` they were produced under with its
//! sha256 fingerprint, the COVERAGE intervals capture was on (`[{ from, to
//! }]`, the last open iff enabled) and `writer_requires`. Port of
//! `packages/core/src/core/store/manifest.ts`.
//!
//! Who writes it. [`Store::create_repo`](crate::Store::create_repo) writes
//! both rows for a new repository — history `enabled` with coverage from the
//! repository's birth and `writer_requires = 1` (resolution 17: a writer
//! without the recorder refuses) WHEN the composition carries the recorder
//! and the caller did not opt out, `disabled` with no coverage otherwise (a
//! core-only build creates repositories it can write; `omg source add
//! --no-history`; Phase 4a), semantic `enabled` iff `embedding.provider`
//! resolves for the repository (resolution 1: vectors are never consulted) —
//! and migration 17 step (13) does the same for every existing repository
//! (coverage from its first commit). The semantic row is the verbs'
//! ([`enable_semantic`] / [`disable_semantic`], `omg embed enable|disable` —
//! `spec/store` §5.10, Phase 4b) and follows a CHANGE of the effective
//! `embedding.provider` (a settings write re-derives it through
//! [`refresh_semantic_manifest`] only when the provider moved, so `embed
//! disable` is sticky across unrelated writes; through 17.1 every settings
//! write re-derived it). The history row is flipped by [`enable_history`] /
//! [`disable_history`] (Phase 4a; `spec/store` §5.9) and left alone by
//! [`purge_history`] (§7.6: coverage records when capture was ON — the
//! record `spec/surface` §3's `pruned` rests on, [`history_read_refusal`]).
//!
//! Who reads it. `version.capabilities` and `capability_unavailable`'s state
//! (`omgbase-sync`'s `capability_state`), `doctor --size`'s `capabilities`
//! member and the `history`/`semantic` file lines ([`crate::size`]), every
//! writer through [`require_writer`] / [`writer_for`] — and, since Phase 4a,
//! every commit: [`capture_for`] is the recorder iff the composition carries
//! the module AND the repository's row is `enabled`; otherwise the commit
//! writes no history row. The history bundle's DDL follows the manifest: it
//! is executed when a repository's row becomes `enabled` (`create_repo`,
//! `history enable`, the opener for a database some repository of which is
//! enabled), so a database no repository of which ever enabled capture has
//! no history table (`spec/store` §3.1 "Which bundles a database holds").

use omgbase_format::hash::sha256;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use std::collections::HashSet;

use crate::core::alerts::{
    AlertInput, AlertSeverity, CAPTURE_FAILED_ALERT, clear_alert, raise_alert,
};
use crate::core::capabilities::{HistoryRecorder, PurgedCounts};
use crate::core::codec::canonical_json;
use crate::core::fault::{FaultSite, fault_point};
use crate::core::feed::{
    FeedEntryKind, NewFeedEntry, NewFeedRow, append_feed_entry, append_feed_row,
};
use crate::core::mint::Mint;
use crate::core::settings::effective_settings;
use crate::core::writers::{CommitRecord, Origin};
use crate::error::{Error, Result};

/// The history capability's interface version (phase-1-contracts §1.5: history 1).
pub const HISTORY_INTERFACE_V: i64 = 1;
/// The history bundle's data version (1 = 16.0's tables + `edge_transitions`).
pub const HISTORY_DATA_V: i64 = 1;
/// The semantic capability's interface version (1).
pub const SEMANTIC_INTERFACE_V: i64 = 1;
/// The semantic bundle's data version (1).
pub const SEMANTIC_DATA_V: i64 = 1;

/// A manifest row's `state` — the two values the column admits (`unavailable`
/// is a host overlay, never stored).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManifestState {
    Enabled,
    Disabled,
}

impl ManifestState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "enabled" {
            Self::Enabled
        } else {
            Self::Disabled
        }
    }
}

/// One coverage interval: capture was on from `from` (inclusive) to `to`
/// (exclusive), `to` `None` while it still is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoverageInterval {
    pub from: String,
    pub to: Option<String>,
}

impl CoverageInterval {
    fn to_json(&self) -> Json {
        json!({ "from": self.from, "to": self.to })
    }
}

/// A manifest row as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestRow {
    /// `history` | `semantic`.
    pub capability: String,
    pub state: ManifestState,
    pub interface_v: i64,
    pub data_v: i64,
    pub config: Map<String, Json>,
    pub config_hash: Vec<u8>,
    pub coverage: Vec<CoverageInterval>,
    pub writer_requires: bool,
    pub updated_at: String,
}

/// Canonical JSON (keys sorted bytewise at every level) — what `config_hash`
/// fingerprints, so both engines hash the same bytes.
#[must_use]
pub fn canonical_config_json(config: &Map<String, Json>) -> String {
    canonical_json(&Json::Object(config.clone()))
}

/// `sha256(canonical JSON of config)` — the fingerprint column.
#[must_use]
pub fn config_hash(config: &Map<String, Json>) -> Vec<u8> {
    sha256(canonical_config_json(config).as_bytes()).to_vec()
}

const COLUMNS: &str = "capability, state, interface_v, data_v, config, config_hash, coverage, writer_requires, updated_at";

fn parse_coverage(json: &str) -> Vec<CoverageInterval> {
    let Ok(Json::Array(items)) = serde_json::from_str::<Json>(json) else {
        return Vec::new(); // an unparsable coverage reads as []
    };
    items
        .iter()
        .filter_map(|i| {
            let o = i.as_object()?;
            let from = o.get("from")?.as_str()?.to_owned();
            let to = match o.get("to")? {
                Json::Null => None,
                Json::String(s) => Some(s.clone()),
                _ => return None,
            };
            Some(CoverageInterval { from, to })
        })
        .collect()
}

fn parse_config(json: &str) -> Map<String, Json> {
    match serde_json::from_str::<Json>(json) {
        Ok(Json::Object(m)) => m,
        _ => Map::new(), // an unparsable config reads as {}
    }
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<ManifestRow> {
    let state: String = r.get(1)?;
    let config: String = r.get(4)?;
    let coverage: String = r.get(6)?;
    let writer_requires: i64 = r.get(7)?;
    Ok(ManifestRow {
        capability: r.get(0)?,
        state: ManifestState::parse(&state),
        interface_v: r.get(2)?,
        data_v: r.get(3)?,
        config: parse_config(&config),
        config_hash: r.get(5)?,
        coverage: parse_coverage(&coverage),
        writer_requires: writer_requires == 1,
        updated_at: r.get(8)?,
    })
}

/// Does the `capabilities` table exist on this connection (false only on a
/// pre-3e-ii 17.0 database before the opener finished the step)?
pub fn manifest_table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capabilities'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The manifest row of `(repo_id, capability)`, or `None` — spec/store §3.1
/// rule 1: no row is `disabled` with no coverage.
pub fn read_capability(
    conn: &Connection,
    repo_id: &str,
    capability: &str,
) -> Result<Option<ManifestRow>> {
    if !manifest_table_exists(conn)? {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM capabilities WHERE repo_id = ?1 AND capability = ?2"),
            params![repo_id, capability],
            row_from,
        )
        .optional()?)
}

/// Both rows of a repository (`None` where absent): `(history, semantic)`.
pub fn read_capabilities(
    conn: &Connection,
    repo_id: &str,
) -> Result<(Option<ManifestRow>, Option<ManifestRow>)> {
    Ok((
        read_capability(conn, repo_id, "history")?,
        read_capability(conn, repo_id, "semantic")?,
    ))
}

/// Rule 3: `coverage_from` is the first interval's `from`, `None` when there is none.
#[must_use]
pub fn coverage_from(row: Option<&ManifestRow>) -> Option<&str> {
    row.and_then(|r| r.coverage.first())
        .map(|i| i.from.as_str())
}

struct WriteInput<'a> {
    capability: &'a str,
    state: ManifestState,
    interface_v: i64,
    data_v: i64,
    config: &'a Map<String, Json>,
    coverage: &'a [CoverageInterval],
    writer_requires: bool,
    now: &'a str,
}

fn write_row(conn: &Connection, repo_id: &str, w: &WriteInput<'_>) -> Result<()> {
    let coverage = Json::Array(w.coverage.iter().map(CoverageInterval::to_json).collect());
    conn.execute(
        &format!(
            "INSERT INTO capabilities (repo_id, {COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (repo_id, capability) DO UPDATE SET
               state = excluded.state, interface_v = excluded.interface_v, data_v = excluded.data_v, config = excluded.config,
               config_hash = excluded.config_hash, coverage = excluded.coverage, writer_requires = excluded.writer_requires, updated_at = excluded.updated_at"
        ),
        params![
            repo_id,
            w.capability,
            w.state.as_str(),
            w.interface_v,
            w.data_v,
            canonical_config_json(w.config),
            config_hash(w.config),
            coverage.to_string(),
            i64::from(w.writer_requires),
            w.now,
        ],
    )?;
    Ok(())
}

fn read_written(conn: &Connection, repo_id: &str, capability: &str) -> Result<ManifestRow> {
    read_capability(conn, repo_id, capability)?.ok_or_else(|| {
        Error::Other(format!(
            "the {capability} manifest row of {repo_id} was not written"
        ))
    })
}

/// The history row a repository gets at `create_repo` / migration 17: with
/// `enable` (the composition carries the recorder and the caller did not ask
/// for history off — `omg source add --no-history`, a fixture's
/// `capabilities: { history: false }`) `enabled`, interface/data 1, `config
/// {}`, one open coverage interval from `from`, `writer_requires` per
/// `writer_requires` (default 1 — resolution 17), and the history bundle's
/// DDL executed; otherwise (a core-only build, Phase 4a, or the explicit
/// opt-out) `disabled` with no coverage and `writer_requires = 0` — a build
/// that cannot capture does not require what it cannot do, and `history
/// enable` through a full build turns it on later. Idempotent: an existing
/// row is left alone (the manifest is engine state, never re-derived from
/// elsewhere).
pub fn ensure_history_manifest(
    conn: &Connection,
    repo_id: &str,
    from: &str,
    now: &str,
    enable: bool,
    writer_requires: bool,
) -> Result<ManifestRow> {
    if let Some(existing) = read_capability(conn, repo_id, "history")? {
        return Ok(existing);
    }
    if enable {
        apply_history_bundle(conn)?;
    }
    let open = [CoverageInterval {
        from: from.to_owned(),
        to: None,
    }];
    write_row(
        conn,
        repo_id,
        &WriteInput {
            capability: "history",
            state: if enable {
                ManifestState::Enabled
            } else {
                ManifestState::Disabled
            },
            interface_v: HISTORY_INTERFACE_V,
            data_v: HISTORY_DATA_V,
            config: &Map::new(),
            coverage: if enable { &open } else { &[] },
            writer_requires: enable && writer_requires,
            now,
        },
    )?;
    read_written(conn, repo_id, "history")
}

// ---- the history bundle's presence (`spec/store` §3.1 "Which bundles a database holds", Phase 4a) ----

/// Do the history bundle's tables exist on this connection? (Probed on
/// `sqlite_master`; [`apply_history_bundle`] is the only way they appear.)
pub fn history_bundle_present(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'commits'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Execute the history bundle's DDL (`schema-history.sql`; every statement
/// `IF NOT EXISTS`) — `history enable`, `create_repo` with the recorder, the
/// opener.
pub fn apply_history_bundle(conn: &Connection) -> Result<()> {
    if history_bundle_present(conn)? {
        return Ok(());
    }
    conn.execute_batch(crate::schema::HISTORY_SQL)?;
    Ok(())
}

/// Is any repository's history row `enabled` (the opener's rule for executing
/// the bundle's DDL: one database holds every repository)?
pub fn any_history_enabled(conn: &Connection) -> Result<bool> {
    if !manifest_table_exists(conn)? {
        return Ok(false);
    }
    Ok(conn
        .query_row(
            "SELECT 1 FROM capabilities WHERE capability = 'history' AND state = 'enabled' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The recorder a commit on `repo_id` captures through (`spec/store` §5.4
/// step 15, Phase 4a): the composition's module (`history`) when the
/// repository's manifest row is `enabled`, else `None` — the capture is
/// simply skipped and no history row is written. With `repo_id` `None` (a
/// store-wide maintenance path — `gc`, `rebuild-index`, the size report): the
/// module when the bundle's tables exist.
pub fn capture_for<'a>(
    conn: &Connection,
    history: Option<&'a dyn HistoryRecorder>,
    repo_id: Option<&str>,
) -> Result<Option<&'a dyn HistoryRecorder>> {
    let Some(history) = history else {
        return Ok(None);
    };
    let Some(repo_id) = repo_id else {
        return Ok(history_bundle_present(conn)?.then_some(history));
    };
    let row = read_capability(conn, repo_id, "history")?;
    Ok(row
        .is_some_and(|r| r.state == ManifestState::Enabled)
        .then_some(history))
}

/// The recorder a READ goes through (`docs_read { at }`, `docs_diff*`,
/// `docs_history`, `blocks_history`, the `revisions` query root): the module
/// when the bundle's tables exist — what was captured is readable whatever the
/// repository's current state (`spec/surface` §2.1: a disabled repository
/// reads what it captured earlier) — else `None` (nothing was ever captured
/// in this database, or the build has no module).
pub fn history_reader<'a>(
    conn: &Connection,
    history: Option<&'a dyn HistoryRecorder>,
) -> Result<Option<&'a dyn HistoryRecorder>> {
    match history {
        Some(h) if history_bundle_present(conn)? => Ok(Some(h)),
        _ => Ok(None),
    }
}

/// The recorder a history TOOL reads through, or the refusal (`spec/surface`
/// §2.1; Phase 4a): [`Error::HistoryUnavailable`] (`capability_unavailable {
/// history, unavailable }`) on a composition without the module,
/// [`Error::HistoryDisabled`] (`{ history, disabled }`) when nothing was ever
/// captured in this database (no bundle) — the reads of a repository whose
/// capture is off but whose rows exist go through (what was captured stays
/// readable).
pub fn require_history_reader<'a>(
    conn: &Connection,
    history: Option<&'a dyn HistoryRecorder>,
) -> Result<&'a dyn HistoryRecorder> {
    let Some(history) = history else {
        return Err(Error::HistoryUnavailable);
    };
    if !history_bundle_present(conn)? {
        return Err(Error::HistoryDisabled { rev: None });
    }
    Ok(history)
}

// ---- the read-state decision table (`spec/surface` §3; 17.2 Phase 4b, D3) -----------------

/// `spec/surface` §3 `outside_coverage` (Phase 4b), byte for byte in both engines.
#[must_use]
pub fn history_outside_coverage_message(rev: &str, coverage_from: &str) -> String {
    format!(
        "revision {} was minted outside this repository's history coverage (capture started {coverage_from})",
        Json::String(rev.to_owned())
    )
}

/// `spec/surface` §3 `pruned` (Phase 4b), byte for byte in both engines.
#[must_use]
pub fn history_pruned_message(rev: &str) -> String {
    format!(
        "revision {} was captured but its history has been purged",
        Json::String(rev.to_owned())
    )
}

/// `spec/store` §3.1 `coverage`: does some interval hold `ts` — `from ≤ ts`
/// and (`to` null or `ts < to`)?
#[must_use]
pub fn in_coverage(coverage: &[CoverageInterval], ts: &str) -> bool {
    coverage
        .iter()
        .any(|i| i.from.as_str() <= ts && i.to.as_deref().is_none_or(|to| ts < to))
}

/// Does `ts` lie after the last interval's end (or is there no interval at
/// all)? — the `disabled` state's condition (`spec/surface` §3).
fn after_coverage(coverage: &[CoverageInterval], ts: &str) -> bool {
    match coverage.last() {
        None => true,
        Some(last) => last.to.as_deref().is_some_and(|to| ts >= to),
    }
}

/// The claim's `minted_at` for an id (`spec/store` §2.1 `id_claims`), `None`
/// when no claim exists (never minted here, or pruned under
/// `identity.claims_retain_days`).
pub fn claim_minted_at(conn: &Connection, id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT minted_at FROM id_claims WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?)
}

/// The history read states, decided in the spec's order (`spec/surface` §3's
/// table; phase-1-contracts §2.1, D3 — Phase 4b) for a revision token `rev`
/// the recorder holds NO row for, on a repository whose current head `rev` is
/// not (the head is served from the rows, resolution 11). The error returned:
///   - [`Error::HistoryUnavailable`] — no module (retriable);
///   - [`Error::HistoryDisabled`] `{ rev }` — the row is absent or `disabled`
///     and the token was minted after the last coverage interval (or there is
///     none), or the token is no claim at all (nothing says it was ever minted
///     here);
///   - [`Error::HistoryOutsideCoverage`] `{ rev, coverage_from, fix? }` — the
///     claim's `minted_at` falls in no interval: capture was off when it was
///     minted;
///   - [`Error::HistoryPruned`] `{ rev, fix? }` — minted within coverage, no
///     row: the history was purged (`spec/store` §7.6);
///   - [`Error::TargetMissingRevision`] — an unclaimed token on an enabled
///     repository (the 4a answer, kept: the token is nobody's).
///
/// A token the recorder DOES hold — another document's revision — is
/// `target_missing` on every composition, as before. `doc_id` names the
/// document asked about (the `target_missing` data); `read_fix` adds the
/// current document (`docs_read {"_id":"<id>"}`) as the `fix` of
/// `outside_coverage`/`pruned` — the caller is `docs_read { at }` /
/// `docs_read_at`. A failing read of the manifest or the claims is returned
/// as that failure. The reference's `historyReadRefusal`.
pub fn history_read_refusal(
    conn: &Connection,
    history: Option<&dyn HistoryRecorder>,
    repo_id: &str,
    rev: &str,
    doc_id: Option<&str>,
    read_fix: bool,
) -> Error {
    let decide = || -> Result<Error> {
        let Some(module) = history else {
            return Ok(Error::HistoryUnavailable);
        };
        let target_missing = || Error::TargetMissingRevision {
            rev: rev.to_owned(),
            doc: doc_id.map(str::to_owned),
        };
        if let Some(reader) = history_reader(conn, Some(module))?
            && reader.has_revision(conn, rev)?
        {
            return Ok(target_missing());
        }
        let row = read_capability(conn, repo_id, "history")?;
        let enabled = row
            .as_ref()
            .is_some_and(|r| r.state == ManifestState::Enabled);
        let Some(minted_at) = claim_minted_at(conn, rev)? else {
            if enabled {
                return Ok(target_missing());
            }
            return Ok(Error::HistoryDisabled {
                rev: Some(rev.to_owned()),
            });
        };
        let coverage: &[CoverageInterval] = row.as_ref().map_or(&[], |r| &r.coverage);
        if !enabled && after_coverage(coverage, &minted_at) {
            return Ok(Error::HistoryDisabled {
                rev: Some(rev.to_owned()),
            });
        }
        let fix = match doc_id {
            Some(id) if read_fix => Some(format!("docs_read {}", json!({ "_id": id }))),
            _ => None,
        };
        if !in_coverage(coverage, &minted_at) {
            let Some(first) = coverage.first() else {
                return Ok(Error::HistoryDisabled {
                    rev: Some(rev.to_owned()),
                });
            };
            return Ok(Error::HistoryOutsideCoverage {
                rev: rev.to_owned(),
                coverage_from: first.from.clone(),
                fix,
            });
        }
        Ok(Error::HistoryPruned {
            rev: rev.to_owned(),
            fix,
        })
    };
    match decide() {
        Ok(e) | Err(e) => e,
    }
}

/// Step 0 then step 15's recorder: the refusal check ([`require_writer`]),
/// then the recorder a commit on `repo_id` captures through
/// ([`capture_for`]; `None` = uncaptured).
pub fn writer_for<'a>(
    conn: &Connection,
    history: Option<&'a dyn HistoryRecorder>,
    repo_id: &str,
    now: &str,
) -> Result<Option<&'a dyn HistoryRecorder>> {
    require_writer(conn, history.is_some(), repo_id, now)?;
    capture_for(conn, history, Some(repo_id))
}

/// Run one of the recorder's capture calls (`spec/store` §5.4 step 15,
/// resolution 18): a failure becomes [`Error::CaptureFailed`] for the
/// transaction's owner to roll back on, name the member and raise the alert
/// after. `path` is the member when the caller knows it (`None` for the
/// batch's commit row). `body` is the call itself, run inside the wrapper so
/// the `recorder.capture` fault site (§9.7) sits before the recorder.
pub fn capture<T>(path: Option<&str>, body: impl FnOnce() -> Result<T>) -> Result<T> {
    // OMGBASE_FAULT (Phase 5a, `spec/store` §9.7): a fault here is a recorder
    // throw — raised before the recorder runs, wrapped like any other.
    let result = fault_point(FaultSite::RecorderCapture).and_then(|()| body());
    match result {
        Ok(v) => Ok(v),
        Err(e @ Error::CaptureFailed { .. }) => Err(e),
        Err(e) => Err(Error::CaptureFailed {
            path: path.map(str::to_owned),
            reason: e.to_string(),
        }),
    }
}

// ---- the capture lifecycle: `history enable` / `history disable` (`spec/store` §5.9, Phase 4a) ----

/// The feed row's `reason` on the baseline commit, byte for byte in both engines.
pub const HISTORY_ENABLED_REASON: &str = "history enabled";

/// `phase-1-contracts.md` §2.1, byte for byte in both engines: a history read on a build without the module.
pub const HISTORY_UNAVAILABLE_MESSAGE: &str =
    "history is unavailable in this build — run an engine with the history module to read it";

/// `phase-1-contracts.md` §2.1, byte for byte in both engines: a history read on a repository whose capture is off.
pub const HISTORY_DISABLED_MESSAGE: &str = "history is disabled for this repository — enable it with `omg history enable` (reads of what was captured earlier still work)";

/// What `history enable` / `history disable` return: the row as it now is,
/// whether anything changed, and — on an `enable` that changed something —
/// the baseline commit's id and the revisions it wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryLifecycleResult {
    pub row: ManifestRow,
    /// `false`: the verb was a no-op — already in that state.
    pub changed: bool,
    /// `enable`: `(commit id, revisions written)` of the baseline; `None` when nothing changed.
    pub baseline: Option<(String, usize)>,
}

impl HistoryLifecycleResult {
    /// The `--json` shape `{ state, coverage, writer_requires, changed,
    /// baseline?: { commit, revisions } }` (`spec/cli` §6; the fixture
    /// runners' `history` outcome), in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert(
            "state".to_owned(),
            Json::String(self.row.state.as_str().to_owned()),
        );
        m.insert(
            "coverage".to_owned(),
            Json::Array(
                self.row
                    .coverage
                    .iter()
                    .map(CoverageInterval::to_json)
                    .collect(),
            ),
        );
        m.insert(
            "writer_requires".to_owned(),
            Json::Bool(self.row.writer_requires),
        );
        m.insert("changed".to_owned(), Json::Bool(self.changed));
        if let Some((commit, revisions)) = &self.baseline {
            m.insert(
                "baseline".to_owned(),
                json!({ "commit": commit, "revisions": revisions }),
            );
        }
        Json::Object(m)
    }
}

/// `history enable` (`spec/store` §5.9; `phase-1-contracts.md` §1.14): in one
/// transaction — the bundle's DDL when absent; the BASELINE: one feed row
/// (`origin = 'import'`, `reason = 'history enabled'`, its own batch) with
/// one `changed` entry per live document under its EXISTING head (no head is
/// minted, so every `_rev` a client holds stays valid), handed to the recorder
/// as [`HistoryRecorder::baseline`] — the `commits` row, a checkpoint revision
/// for every live document whose head has none, the recorder's holds, the
/// edge record reconciled; then the manifest row: `state = 'enabled'`,
/// `coverage += { from: now, to: null }`, `writer_requires` per the flag
/// (default 1, resolution 17). Idempotent: an `enabled` row is returned
/// unchanged (even when `writer_requires` differs — the flag is the enable's,
/// not a setting). Refuses on a composition without the recorder
/// ([`Error::HistoryUnavailable`]: nothing can capture here). The caller
/// holds the writer lock and no transaction (the baseline is one of its own).
pub fn enable_history(
    conn: &Connection,
    mint: &mut Mint<'_>,
    history: Option<&dyn HistoryRecorder>,
    repo_id: &str,
    now: &str,
    writer_requires: bool,
) -> Result<HistoryLifecycleResult> {
    let Some(history) = history else {
        return Err(Error::HistoryUnavailable);
    };
    let existing = read_capability(conn, repo_id, "history")?;
    if let Some(row) = existing
        .as_ref()
        .filter(|r| r.state == ManifestState::Enabled)
    {
        return Ok(HistoryLifecycleResult {
            row: row.clone(),
            changed: false,
            baseline: None,
        });
    }
    let tx = conn.unchecked_transaction()?;
    apply_history_bundle(&tx)?;
    // The feed row is the core's; the row is still `disabled` here, so no
    // recorder is handed to it — the `commits` row is the baseline's own.
    let commit = append_feed_row(
        &tx,
        mint,
        None,
        &NewFeedRow {
            repo_id,
            ts: now,
            origin: Origin::Import,
            actor: None,
            reason: Some(HISTORY_ENABLED_REASON),
            batch_id: None,
            plan_id: None,
            ops: None,
        },
    )?;
    let live: Vec<(String, String, String, Vec<u8>)> = {
        let mut stmt = tx.prepare(
            "SELECT doc_id, path, head, file_hash FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL AND head IS NOT NULL ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![repo_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (doc_id, path, head, hash) in &live {
        append_feed_entry(
            &tx,
            &NewFeedEntry {
                repo_id,
                epoch: &commit.epoch,
                seq: commit.seq,
                doc_id,
                path,
                head: Some(head),
                hash: Some(hash),
                kind: FeedEntryKind::Changed,
                from_path: None,
            },
        )?;
    }
    let revisions = history.baseline(
        &tx,
        &CommitRecord {
            commit_id: &commit.commit_id,
            repo_id,
            epoch: &commit.epoch,
            seq: commit.seq,
            ts: now,
            origin: Origin::Import,
            actor: None,
            reason: Some(HISTORY_ENABLED_REASON),
            batch_id: &commit.batch_id,
            ops: None,
        },
    )?;
    let mut coverage = existing
        .as_ref()
        .map(|e| e.coverage.clone())
        .unwrap_or_default();
    coverage.push(CoverageInterval {
        from: now.to_owned(),
        to: None,
    });
    let empty = Map::new();
    write_row(
        &tx,
        repo_id,
        &WriteInput {
            capability: "history",
            state: ManifestState::Enabled,
            interface_v: existing
                .as_ref()
                .map_or(HISTORY_INTERFACE_V, |e| e.interface_v),
            data_v: existing.as_ref().map_or(HISTORY_DATA_V, |e| e.data_v),
            config: existing.as_ref().map_or(&empty, |e| &e.config),
            coverage: &coverage,
            writer_requires,
            now,
        },
    )?;
    let row = read_written(&tx, repo_id, "history")?;
    tx.commit()?;
    Ok(HistoryLifecycleResult {
        row,
        changed: true,
        baseline: Some((commit.commit_id, revisions)),
    })
}

/// `history disable` (`spec/store` §5.9): the open coverage interval closes
/// (`to = now`), `state = 'disabled'`, `writer_requires = 0`. The rows stay
/// (`history purge`, Phase 4b, is what removes them); reads of what was
/// captured keep working; step 15 stops for this repository from the next
/// commit on, in this process and every other (every commit reads the row).
/// Idempotent: a `disabled` or absent row is a no-op (an absent one is written
/// `disabled` with no coverage — rule 1 made explicit). Needs no recorder: a
/// core-only build may switch capture off on a repository it cannot write.
pub fn disable_history(
    conn: &Connection,
    repo_id: &str,
    now: &str,
) -> Result<HistoryLifecycleResult> {
    let existing = read_capability(conn, repo_id, "history")?;
    let Some(existing) = existing.filter(|e| e.state == ManifestState::Enabled) else {
        let row = match read_capability(conn, repo_id, "history")? {
            Some(row) => row,
            None => {
                write_row(
                    conn,
                    repo_id,
                    &WriteInput {
                        capability: "history",
                        state: ManifestState::Disabled,
                        interface_v: HISTORY_INTERFACE_V,
                        data_v: HISTORY_DATA_V,
                        config: &Map::new(),
                        coverage: &[],
                        writer_requires: false,
                        now,
                    },
                )?;
                read_written(conn, repo_id, "history")?
            }
        };
        return Ok(HistoryLifecycleResult {
            row,
            changed: false,
            baseline: None,
        });
    };
    let mut coverage = existing.coverage.clone();
    if let Some(last) = coverage.last_mut()
        && last.to.is_none()
    {
        last.to = Some(now.to_owned());
    }
    write_row(
        conn,
        repo_id,
        &WriteInput {
            capability: "history",
            state: ManifestState::Disabled,
            interface_v: existing.interface_v,
            data_v: existing.data_v,
            config: &existing.config,
            coverage: &coverage,
            writer_requires: false,
            now,
        },
    )?;
    Ok(HistoryLifecycleResult {
        row: read_written(conn, repo_id, "history")?,
        changed: true,
        baseline: None,
    })
}

/// What `history purge` returns (`spec/store` §7.6): the rows removed per
/// history table, the recorder's holds released (claims left with no holder
/// deleted), the manifest's coverage — unchanged by a purge: coverage records
/// when capture was ON, not what is retained — and whether the bundle's
/// tables were dropped (no repository enabled and every history table empty
/// after the purge).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryPurgeResult {
    pub purged: PurgedCounts,
    pub claims_released: usize,
    pub coverage: Vec<CoverageInterval>,
    pub tables_dropped: bool,
}

impl HistoryPurgeResult {
    /// The receipt `{ purged: { <table>: n }, claims_released, coverage,
    /// tables_dropped }` (`spec/cli` §6 `--json`; the fixture runners'
    /// `purge` outcome), in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("purged".to_owned(), self.purged.to_json());
        m.insert(
            "claims_released".to_owned(),
            Json::from(self.claims_released),
        );
        m.insert(
            "coverage".to_owned(),
            Json::Array(
                self.coverage
                    .iter()
                    .map(CoverageInterval::to_json)
                    .collect(),
            ),
        );
        m.insert("tables_dropped".to_owned(), Json::Bool(self.tables_dropped));
        Json::Object(m)
    }
}

/// `history purge [--before <ts>]` (`spec/store` §7.6, Phase 4b;
/// phase-1-contracts §1.14, D2 step two): in one transaction — the recorder
/// removes the repository's history rows ([`HistoryRecorder::purge`]: every
/// commit, or those before `before`, never a live head's revision while
/// capture is on), the recorder's hold (bit 1) is released on every claim no
/// history row names any more (a claim with no holder left is deleted), and —
/// when NO repository is `enabled` and every history table is empty — the
/// bundle's tables are dropped (a workspace-wide decision taken automatically
/// and reported as `tables_dropped`, so a database that purged its last
/// history is a core database again; the next `history enable` re-executes
/// the DDL). The manifest's `coverage` and `state` are NOT touched: coverage
/// is the record of when capture was on, which a purge does not change — it
/// is what tells a purged token (`pruned`) from one minted while capture was
/// off (`outside_coverage`), `spec/surface` §3. Needs the module
/// ([`Error::HistoryUnavailable`] otherwise); a database without the bundle
/// has nothing to purge (every count 0). The caller holds the writer lock and
/// no transaction.
pub fn purge_history(
    conn: &Connection,
    history: Option<&dyn HistoryRecorder>,
    repo_id: &str,
    before: Option<&str>,
) -> Result<HistoryPurgeResult> {
    let Some(history) = history else {
        return Err(Error::HistoryUnavailable);
    };
    let row = read_capability(conn, repo_id, "history")?;
    let coverage = row.as_ref().map(|r| r.coverage.clone()).unwrap_or_default();
    if !history_bundle_present(conn)? {
        return Ok(HistoryPurgeResult {
            purged: PurgedCounts::default(),
            claims_released: 0,
            coverage,
            tables_dropped: false,
        });
    }
    let tx = conn.unchecked_transaction()?;
    let drop_if_empty = !any_history_enabled(&tx)?;
    let protect_heads = row
        .as_ref()
        .is_some_and(|r| r.state == ManifestState::Enabled);
    let outcome = history.purge(&tx, repo_id, before, drop_if_empty, protect_heads)?;
    tx.commit()?;
    Ok(HistoryPurgeResult {
        purged: outcome.purged,
        claims_released: outcome.claims_released,
        coverage,
        tables_dropped: outcome.tables_dropped,
    })
}

/// The open coverage interval's `from` (the current capture's start), or
/// `None` when capture is off.
#[must_use]
pub fn open_coverage_from(row: Option<&ManifestRow>) -> Option<&str> {
    let last = row?.coverage.last()?;
    last.to.is_none().then_some(last.from.as_str())
}

// ---- the `capture_failed` alert (`spec/store` §5.8; resolution 18) --------------------------

/// The `capture_failed` message (the alert's and the envelope's), byte for
/// byte in both engines: `path` the member (`None` → "a commit").
#[must_use]
pub fn capture_failed_message(path: Option<&str>, reason: &str) -> String {
    let where_ = path.unwrap_or("a commit");
    format!(
        "history capture of {where_} failed: {reason} — the write was rolled back and is retried by the next sweep; fix the recorder or run omg history disable"
    )
}

/// An alert names a path in the reference form (`/a.md`), as the
/// materialization alerts do.
fn alert_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    }
}

/// Raise `capture_failed` for the member whose capture failed (after the
/// rollback — the transaction's owner calls this): `error`, detail `{ path,
/// reason }` (`path` omitted when unknown). The row is retried by the next
/// sweep; a later capture of the same path clears it
/// ([`clear_capture_failed`]).
pub fn raise_capture_failed(
    conn: &Connection,
    repo_id: &str,
    path: Option<&str>,
    reason: &str,
    now: &str,
) -> Result<()> {
    let path = path.map(alert_path);
    let mut detail = Map::new();
    if let Some(p) = &path {
        detail.insert("path".to_owned(), Json::String(p.clone()));
    }
    detail.insert("reason".to_owned(), Json::String(reason.to_owned()));
    raise_alert(
        conn,
        repo_id,
        &AlertInput {
            code: CAPTURE_FAILED_ALERT,
            severity: AlertSeverity::Error,
            message: &capture_failed_message(path.as_deref(), reason),
            detail: Some(&detail),
        },
        now,
    )
}

/// A successful capture of `path` ends its failure condition: the active
/// `capture_failed` alert about this path is cleared. Runs in the commit's
/// transaction.
pub fn clear_capture_failed(conn: &Connection, repo_id: &str, path: &str, now: &str) -> Result<()> {
    conn.execute(
        "UPDATE alerts SET cleared_at = ?1 WHERE repo_id = ?2 AND code = ?3 AND cleared_at IS NULL AND json_extract(detail, '$.path') = ?4",
        params![now, repo_id, CAPTURE_FAILED_ALERT, alert_path(path)],
    )?;
    Ok(())
}

/// Is `embedding.provider` configured for the repository (the workspace layer
/// with the repo's own over it) — a non-blank string?
pub fn semantic_provider_configured(conn: &Connection, repo_id: &str) -> Result<bool> {
    let settings = effective_settings(conn, repo_id)?;
    Ok(settings
        .get("embedding")
        .and_then(Json::as_object)
        .and_then(|e| e.get("provider"))
        .and_then(Json::as_str)
        .is_some_and(|p| !p.trim().is_empty()))
}

/// The semantic row's `config`: `{ model, dim }` from the effective
/// `embedding.*` settings — only the keys that are set.
pub fn semantic_config_of(conn: &Connection, repo_id: &str) -> Result<Map<String, Json>> {
    let settings = effective_settings(conn, repo_id)?;
    let mut out = Map::new();
    let Some(embedding) = settings.get("embedding").and_then(Json::as_object) else {
        return Ok(out);
    };
    if let Some(model) = embedding.get("model").and_then(Json::as_str)
        && !model.is_empty()
    {
        out.insert("model".to_owned(), Json::String(model.to_owned()));
    }
    if let Some(dim) = embedding.get("dim").filter(|d| d.is_number()) {
        out.insert("dim".to_owned(), dim.clone());
    }
    Ok(out)
}

/// Re-derive the semantic row from the settings (resolution 1: `enabled` iff
/// a provider is configured; stored vectors are never consulted). The row is
/// inserted when missing; when the state flips an interval opens (`{ from:
/// now, to: null }`) or the open one closes (`to = now`); when only the
/// config changed the config and its hash move; an unchanged row is not
/// touched (its `updated_at` stands). Returns the row as it now is. Called by
/// `create_repo`, migration 17 and the settings writers. `flip` (`spec/store`
/// §5.10, Phase 4b) is the caller's word that the effective provider CHANGED:
/// once the row exists, a write with `flip` false leaves the STATE alone —
/// `omg embed disable` is sticky across unrelated settings writes — and
/// moves the config when it changed; a missing row is always derived.
pub fn refresh_semantic_manifest(
    conn: &Connection,
    repo_id: &str,
    now: &str,
    flip: bool,
) -> Result<ManifestRow> {
    if !manifest_table_exists(conn)? {
        return Err(Error::Other(
            "the capabilities table is missing — open the store through Store first".to_owned(),
        ));
    }
    let derived = if semantic_provider_configured(conn, repo_id)? {
        ManifestState::Enabled
    } else {
        ManifestState::Disabled
    };
    let config = semantic_config_of(conn, repo_id)?;
    let existing = read_capability(conn, repo_id, "semantic")?;
    let state = match &existing {
        Some(e) if !flip => e.state,
        _ => derived,
    };
    let Some(existing) = existing else {
        let open = [CoverageInterval {
            from: now.to_owned(),
            to: None,
        }];
        write_row(
            conn,
            repo_id,
            &WriteInput {
                capability: "semantic",
                state,
                interface_v: SEMANTIC_INTERFACE_V,
                data_v: SEMANTIC_DATA_V,
                config: &config,
                coverage: if state == ManifestState::Enabled {
                    &open
                } else {
                    &[]
                },
                writer_requires: false,
                now,
            },
        )?;
        return read_written(conn, repo_id, "semantic");
    };
    let same_config = existing.config_hash == config_hash(&config);
    if existing.state == state && same_config {
        return Ok(existing);
    }
    let mut coverage = existing.coverage.clone();
    if existing.state != state {
        if state == ManifestState::Enabled {
            coverage.push(CoverageInterval {
                from: now.to_owned(),
                to: None,
            });
        } else if let Some(last) = coverage.last_mut()
            && last.to.is_none()
        {
            last.to = Some(now.to_owned());
        }
    }
    write_row(
        conn,
        repo_id,
        &WriteInput {
            capability: "semantic",
            state,
            interface_v: existing.interface_v,
            data_v: existing.data_v,
            config: &config,
            coverage: &coverage,
            writer_requires: existing.writer_requires,
            now,
        },
    )?;
    read_written(conn, repo_id, "semantic")
}

/// Both rows for a repository that has none yet: the history row with
/// coverage from `from` (its birth at `create_repo`; its first commit's `ts`
/// on migration) when `enable_history` (the composition carries the recorder
/// and the caller did not opt out), else `disabled`; the semantic row from the
/// settings. Idempotent.
pub fn ensure_manifest(
    conn: &Connection,
    repo_id: &str,
    from: &str,
    now: &str,
    enable_history: bool,
) -> Result<()> {
    ensure_history_manifest(conn, repo_id, from, now, enable_history, true)?;
    // An existing semantic row keeps its state (`spec/store` §5.10: the verbs
    // and a provider change flip it, not a re-open).
    refresh_semantic_manifest(conn, repo_id, now, false)?;
    Ok(())
}

/// Every repository's semantic row re-derived (a WORKSPACE-layer settings
/// write touches them all); `flipped` names the repositories whose effective
/// provider changed (`spec/store` §5.10) — the others keep their state;
/// `None` flips every row.
pub fn refresh_semantic_manifests(
    conn: &Connection,
    now: &str,
    flipped: Option<&HashSet<String>>,
) -> Result<()> {
    if !manifest_table_exists(conn)? {
        return Ok(());
    }
    let repos: Vec<String> = {
        let mut stmt = conn.prepare("SELECT repo_id FROM repos ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for repo_id in &repos {
        let flip = flipped.is_none_or(|f| f.contains(repo_id));
        refresh_semantic_manifest(conn, repo_id, now, flip)?;
    }
    Ok(())
}

// ---- the semantic lifecycle: `embed enable` / `embed disable` (`spec/store` §5.10, Phase 4b) ----

/// `spec/store` §5.10 (Phase 4b), byte for byte in both engines: the semantic
/// row switched off by `omg embed disable` with a provider still configured.
pub const SEMANTIC_SWITCHED_OFF_MESSAGE: &str = "semantic search is disabled for this repository — enable it with `omg embed enable` (the embedding provider stays configured)";
/// The `fix` that goes with [`SEMANTIC_SWITCHED_OFF_MESSAGE`].
pub const SEMANTIC_SWITCHED_OFF_FIX: &str = "omg embed enable";
/// `embed enable` without a configured provider (`spec/store` §5.10), byte for byte in both engines.
pub const SEMANTIC_PROVIDER_MISSING_MESSAGE: &str = "no embedding provider configured — pass --provider <command|url>, or set one with omg config set embedding.provider <command|url>";

/// What `embed enable` / `embed disable` return: the row as it now is and
/// whether anything changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticLifecycleResult {
    pub row: ManifestRow,
    pub changed: bool,
}

impl SemanticLifecycleResult {
    /// The `--json` shape `{ state, coverage, provider, changed }` (`spec/cli`
    /// §6; the surface runner's `semantic` outcome), in that key order —
    /// `provider` the effective `embedding.provider` ([`semantic_provider_of`]).
    #[must_use]
    pub fn to_json(&self, provider: Option<&str>) -> Json {
        let mut m = Map::new();
        m.insert(
            "state".to_owned(),
            Json::String(self.row.state.as_str().to_owned()),
        );
        m.insert(
            "coverage".to_owned(),
            Json::Array(
                self.row
                    .coverage
                    .iter()
                    .map(CoverageInterval::to_json)
                    .collect(),
            ),
        );
        m.insert("provider".to_owned(), json!(provider));
        m.insert("changed".to_owned(), Json::Bool(self.changed));
        Json::Object(m)
    }
}

/// `embed enable` (`spec/store` §5.10, Phase 4b; phase-1-contracts §1.14): the
/// semantic row is the verb's to flip. Needs the module (`semantic_present`
/// — [`crate::core::capabilities::unavailable`]`("semantic")` otherwise; the
/// surface renders `capability_unavailable { semantic, disabled }`) and a
/// configured provider ([`Error::SemanticProviderMissing`] — the CLI passes
/// `--provider` to set one first); sets `state = 'enabled'`, opens a coverage
/// interval, writes the config `{ model?, dim? }` from the effective
/// settings. An `enabled` row is returned unchanged (a config change moves
/// the config alone). Idempotent.
pub fn enable_semantic(
    conn: &Connection,
    semantic_present: bool,
    repo_id: &str,
    now: &str,
) -> Result<SemanticLifecycleResult> {
    if !semantic_present {
        return Err(crate::core::capabilities::unavailable("semantic"));
    }
    if !semantic_provider_configured(conn, repo_id)? {
        return Err(Error::SemanticProviderMissing);
    }
    let existing = read_capability(conn, repo_id, "semantic")?;
    let config = semantic_config_of(conn, repo_id)?;
    if let Some(existing) = existing
        .as_ref()
        .filter(|e| e.state == ManifestState::Enabled)
    {
        if existing.config_hash == config_hash(&config) {
            return Ok(SemanticLifecycleResult {
                row: existing.clone(),
                changed: false,
            });
        }
        write_row(
            conn,
            repo_id,
            &WriteInput {
                capability: "semantic",
                state: ManifestState::Enabled,
                interface_v: existing.interface_v,
                data_v: existing.data_v,
                config: &config,
                coverage: &existing.coverage,
                writer_requires: existing.writer_requires,
                now,
            },
        )?;
        return Ok(SemanticLifecycleResult {
            row: read_written(conn, repo_id, "semantic")?,
            changed: true,
        });
    }
    let mut coverage = existing
        .as_ref()
        .map(|e| e.coverage.clone())
        .unwrap_or_default();
    coverage.push(CoverageInterval {
        from: now.to_owned(),
        to: None,
    });
    write_row(
        conn,
        repo_id,
        &WriteInput {
            capability: "semantic",
            state: ManifestState::Enabled,
            interface_v: existing
                .as_ref()
                .map_or(SEMANTIC_INTERFACE_V, |e| e.interface_v),
            data_v: existing.as_ref().map_or(SEMANTIC_DATA_V, |e| e.data_v),
            config: &config,
            coverage: &coverage,
            writer_requires: existing.as_ref().is_some_and(|e| e.writer_requires),
            now,
        },
    )?;
    Ok(SemanticLifecycleResult {
        row: read_written(conn, repo_id, "semantic")?,
        changed: true,
    })
}

/// `embed disable` (`spec/store` §5.10): `coverage[last].to = now`, `state =
/// 'disabled'`; the vectors stay (`embed drain --prune` is the vectors'
/// purge), the provider setting stays — `semantic()`, `blocks_resolve`'s
/// vector leg and the drain then refuse with [`Error::SemanticSwitchedOff`].
/// Idempotent: a `disabled` row is a no-op, an absent one is written
/// `disabled` with no coverage. Needs no module.
pub fn disable_semantic(
    conn: &Connection,
    repo_id: &str,
    now: &str,
) -> Result<SemanticLifecycleResult> {
    let existing = read_capability(conn, repo_id, "semantic")?;
    let Some(existing) = existing.filter(|e| e.state == ManifestState::Enabled) else {
        let row = match read_capability(conn, repo_id, "semantic")? {
            Some(row) => row,
            None => {
                write_row(
                    conn,
                    repo_id,
                    &WriteInput {
                        capability: "semantic",
                        state: ManifestState::Disabled,
                        interface_v: SEMANTIC_INTERFACE_V,
                        data_v: SEMANTIC_DATA_V,
                        config: &semantic_config_of(conn, repo_id)?,
                        coverage: &[],
                        writer_requires: false,
                        now,
                    },
                )?;
                read_written(conn, repo_id, "semantic")?
            }
        };
        return Ok(SemanticLifecycleResult {
            row,
            changed: false,
        });
    };
    let mut coverage = existing.coverage.clone();
    if let Some(last) = coverage.last_mut()
        && last.to.is_none()
    {
        last.to = Some(now.to_owned());
    }
    write_row(
        conn,
        repo_id,
        &WriteInput {
            capability: "semantic",
            state: ManifestState::Disabled,
            interface_v: existing.interface_v,
            data_v: existing.data_v,
            config: &existing.config,
            coverage: &coverage,
            writer_requires: existing.writer_requires,
            now,
        },
    )?;
    Ok(SemanticLifecycleResult {
        row: read_written(conn, repo_id, "semantic")?,
        changed: true,
    })
}

/// `spec/store` §5.10 (Phase 4b): is the repository's semantic row switched
/// OFF while a provider is configured — the state only `omg embed disable`
/// leaves (a row born `disabled` has no provider, and a provider change
/// re-derives the row)? `semantic_present` is whether the composition carries
/// the module (a host whose configured provider failed to start still does);
/// without it the answer is `false` — the semantic paths refuse with the
/// module's own state. When true they refuse with [`Error::SemanticSwitchedOff`].
pub fn semantic_switched_off(
    conn: &Connection,
    semantic_present: bool,
    repo_id: &str,
) -> Result<bool> {
    if !semantic_present {
        return Ok(false);
    }
    let Some(row) = read_capability(conn, repo_id, "semantic")? else {
        return Ok(false);
    };
    Ok(row.state == ManifestState::Disabled && semantic_provider_configured(conn, repo_id)?)
}

/// The effective `embedding.provider` of a repository (the string, or `None`)
/// — what a settings write compares before and after (`spec/store` §5.10).
pub fn semantic_provider_of(conn: &Connection, repo_id: &str) -> Result<Option<String>> {
    let settings = effective_settings(conn, repo_id)?;
    Ok(settings
        .get("embedding")
        .and_then(Json::as_object)
        .and_then(|e| e.get("provider"))
        .and_then(Json::as_str)
        .filter(|p| !p.trim().is_empty())
        .map(str::to_owned))
}

/// The alert a refused writer raises (spec/store §3.1 `alerts`; §7 resolution 17).
pub const WRITER_REFUSED_ALERT: &str = "writer_refused";

/// The `writer_refused` alert's message, byte for byte in both engines.
pub const WRITER_REFUSED_MESSAGE: &str = "a writer without the history module was refused: this repository requires capture (writer_requires) — write through an engine that carries the history module, or run omg history disable";

/// The refusal's message (resolution 17), byte for byte what the reference
/// spells (`HISTORY_WRITER_REQUIRED_MESSAGE`).
pub const HISTORY_WRITER_REQUIRED_MESSAGE: &str = "history capture is required on this repository (writer_requires) and this engine runs without the history module — write through an engine that carries it, or run omg history disable";

/// `spec/store` §5.4 step 0 (17.0, 3e-ii — resolution 17; reachable since
/// Phase 4a): a writer without the history module must refuse to write on a
/// repository whose manifest says `history` is `enabled` with
/// `writer_requires = 1`. The refusal is [`Error::HistoryWriterRequired`]
/// (the surface's `capability_unavailable { capability: "history", state:
/// "unavailable" }`, retriable: the right engine can) and raises the
/// `writer_refused` alert so the stall is visible where the user works; a
/// write that passes clears it (through an engine with the module, or
/// because capture was switched off). A repository whose row is `disabled`
/// writes freely and captures nothing. `history_present` is whether this
/// store runs with the recorder. Call it OUTSIDE the write transaction (the
/// alert must survive the refusal): `commit_ingest`, `observe_batch` and
/// `commit_effects` do.
pub fn require_writer(
    conn: &Connection,
    history_present: bool,
    repo_id: &str,
    now: &str,
) -> Result<()> {
    let row = read_capability(conn, repo_id, "history")?;
    let required = row.is_some_and(|r| r.state == ManifestState::Enabled && r.writer_requires);
    if required && !history_present {
        let mut detail = Map::new();
        detail.insert("capability".to_owned(), Json::String("history".to_owned()));
        raise_alert(
            conn,
            repo_id,
            &AlertInput {
                code: WRITER_REFUSED_ALERT,
                severity: AlertSeverity::Error,
                message: WRITER_REFUSED_MESSAGE,
                detail: Some(&detail),
            },
            now,
        )?;
        return Err(Error::HistoryWriterRequired);
    }
    // A write that passes ends the condition — through an engine with the
    // module, or because capture was turned off.
    clear_alert(conn, repo_id, WRITER_REFUSED_ALERT, now)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::alerts::list_active_alerts;
    use crate::{Capabilities, SequentialMinter, Store};

    const T0: &str = "2026-09-26T10:00:00.000Z";
    const T1: &str = "2026-09-26T11:00:00.000Z";
    const T2: &str = "2026-09-26T12:00:00.000Z";

    fn settings(v: Json) -> Map<String, Json> {
        v.as_object().cloned().unwrap()
    }

    fn write_workspace(store: &Store, s: &Map<String, Json>) {
        store
            .conn()
            .execute(
                "INSERT INTO workspace_settings (id, settings) VALUES (0, ?1) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings",
                params![Json::Object(s.clone()).to_string()],
            )
            .unwrap();
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_level_and_the_hash_is_sha256_of_it() {
        let config = settings(json!({ "b": 1, "a": { "d": [1, { "z": 1, "y": 2 }], "c": "x" } }));
        assert_eq!(
            canonical_config_json(&config),
            r#"{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}"#
        );
        let c = settings(json!({ "model": "m", "dim": 3 }));
        assert_eq!(
            config_hash(&c),
            sha256(br#"{"dim":3,"model":"m"}"#).to_vec()
        );
        // The empty config's fingerprint, as `migrations::v16-to-v17-…` projects it.
        assert_eq!(
            omgbase_format::hash::hex(&config_hash(&Map::new())),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }

    #[test]
    fn create_repo_writes_both_rows_history_enabled_semantic_following_the_provider() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo_at("fixture", T0).unwrap();
        let (history, semantic) = read_capabilities(store.conn(), &repo).unwrap();
        let history = history.unwrap();
        assert_eq!(history.state, ManifestState::Enabled);
        assert_eq!((history.interface_v, history.data_v), (1, 1));
        assert!(history.config.is_empty());
        assert_eq!(history.config_hash, config_hash(&Map::new()));
        assert_eq!(
            history.coverage,
            [CoverageInterval {
                from: T0.into(),
                to: None
            }]
        );
        assert!(history.writer_requires);
        assert_eq!(history.updated_at, T0);
        let semantic = semantic.unwrap();
        assert_eq!(semantic.state, ManifestState::Disabled);
        assert!(semantic.coverage.is_empty());
        assert!(!semantic.writer_requires);
        assert_eq!(coverage_from(Some(&history)), Some(T0));
        assert_eq!(coverage_from(Some(&semantic)), None);
        // Idempotent: a second ensure leaves the rows alone.
        ensure_manifest(store.conn(), &repo, T1, T1, true).unwrap();
        assert_eq!(
            read_capability(store.conn(), &repo, "history")
                .unwrap()
                .unwrap(),
            history
        );
        // A provider at the workspace layer: the row flips with an open
        // interval and the config from the settings.
        write_workspace(
            &store,
            &settings(
                json!({ "embedding": { "provider": "omgbase-embedder", "model": "m1", "dim": 768 } }),
            ),
        );
        let row = refresh_semantic_manifest(store.conn(), &repo, T1, true).unwrap();
        assert_eq!(row.state, ManifestState::Enabled);
        assert_eq!(
            row.coverage,
            [CoverageInterval {
                from: T1.into(),
                to: None
            }]
        );
        assert_eq!(row.config, settings(json!({ "model": "m1", "dim": 768 })));
        assert_eq!(row.updated_at, T1);
        let stored: String = store
            .conn()
            .query_row(
                "SELECT config FROM capabilities WHERE capability = 'semantic'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, r#"{"dim":768,"model":"m1"}"#);
        // A model switch is a rebuild, not a boundary: the hash moves, the interval stays.
        write_workspace(
            &store,
            &settings(json!({ "embedding": { "provider": "omgbase-embedder", "model": "m2" } })),
        );
        let row = refresh_semantic_manifest(store.conn(), &repo, T2, true).unwrap();
        assert_eq!(row.state, ManifestState::Enabled);
        assert_eq!(row.coverage[0].to, None);
        assert_eq!(row.config, settings(json!({ "model": "m2" })));
        assert_eq!(
            row.config_hash,
            config_hash(&settings(json!({ "model": "m2" })))
        );
        // Unchanged: not touched.
        assert_eq!(
            refresh_semantic_manifest(store.conn(), &repo, "2026-09-26T13:00:00.000Z", true)
                .unwrap()
                .updated_at,
            T2
        );
        // The provider gone: the interval closes.
        write_workspace(&store, &Map::new());
        let row = refresh_semantic_manifest(store.conn(), &repo, "2026-09-26T13:00:00.000Z", true)
            .unwrap();
        assert_eq!(row.state, ManifestState::Disabled);
        assert_eq!(
            row.coverage,
            [CoverageInterval {
                from: T1.into(),
                to: Some("2026-09-26T13:00:00.000Z".into())
            }]
        );
        assert!(row.config.is_empty());
    }

    #[test]
    fn a_recorder_less_writer_is_refused_where_the_manifest_requires_capture() {
        // A repository born under a full composition (history `enabled`,
        // `writer_requires` 1), then opened by a core-only build (Phase 4a):
        // the refusal, the alert, `history disable` from the bare build, the
        // write that then lands and clears the alert.
        let dir = std::env::temp_dir().join(format!(
            "omgbase-manifest-refusal-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let items = [crate::BatchItem::observed("a.md", "# A\n")];
        let repo = {
            let mut full =
                Store::open_with_minter(&path, Box::new(SequentialMinter::new())).unwrap();
            let repo = full.create_repo_at("fixture", T0).unwrap();
            assert!(
                read_capability(full.conn(), &repo, "history")
                    .unwrap()
                    .unwrap()
                    .writer_requires
            );
            require_writer(full.conn(), true, &repo, T1).unwrap();
            full.observe_batch(&repo, &items, T1, &crate::Config::default())
                .unwrap();
            assert!(list_active_alerts(full.conn(), &repo).unwrap().is_empty());
            full.close().unwrap();
            repo
        };
        let mut bare = Store::open_with(
            &path,
            Box::new(SequentialMinter::new()),
            Capabilities::core_only(),
        )
        .unwrap();
        let err = require_writer(bare.conn(), false, &repo, T1).unwrap_err();
        assert!(matches!(err, Error::HistoryWriterRequired));
        assert_eq!(err.to_string(), HISTORY_WRITER_REQUIRED_MESSAGE);
        let active = list_active_alerts(bare.conn(), &repo).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(
            active[0].to_json(),
            json!({
                "code": WRITER_REFUSED_ALERT,
                "severity": "error",
                "message": WRITER_REFUSED_MESSAGE,
                "since": T1,
                "detail": { "capability": "history" },
            })
        );
        // An observation through the recorder-less store is the same refusal.
        let edited = [crate::BatchItem::observed("a.md", "# A\n\nedited\n")];
        let refused = bare
            .observe_batch(&repo, &edited, T2, &crate::Config::default())
            .unwrap_err();
        assert!(matches!(refused, Error::HistoryWriterRequired));
        // The same repository written through an engine that carries the
        // recorder passes and clears the alert.
        require_writer(bare.conn(), true, &repo, T2).unwrap();
        assert!(list_active_alerts(bare.conn(), &repo).unwrap().is_empty());
        // `history disable` needs no module: capture off, the interval
        // closed, and the recorder-less writer goes through — writing the
        // feed and the head, no history row.
        let err = require_writer(bare.conn(), false, &repo, T2).unwrap_err();
        assert!(matches!(err, Error::HistoryWriterRequired));
        let r = bare.disable_history(&repo, T2).unwrap();
        assert!(r.changed);
        assert_eq!(r.row.state, ManifestState::Disabled);
        assert_eq!(
            r.row.coverage,
            [CoverageInterval {
                from: T0.into(),
                to: Some(T2.into())
            }]
        );
        assert!(!r.row.writer_requires);
        let out = bare
            .observe_batch(&repo, &edited, T2, &crate::Config::default())
            .unwrap();
        assert!(!out[0].as_observed().unwrap().echo);
        assert!(list_active_alerts(bare.conn(), &repo).unwrap().is_empty());
        let revisions: i64 = bare
            .conn()
            .query_row("SELECT count(*) FROM revisions", [], |r| r.get(0))
            .unwrap();
        let feed: i64 = bare
            .conn()
            .query_row("SELECT count(*) FROM feed", [], |r| r.get(0))
            .unwrap();
        assert_eq!((revisions, feed), (1, 2), "the feed grew, the log did not");
        // A repository a core-only build creates starts `disabled` with no
        // coverage and requires nothing; `history enable` is refused there.
        let born = bare.create_repo_at("born-bare", T2).unwrap();
        let row = read_capability(bare.conn(), &born, "history")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, ManifestState::Disabled);
        assert!(row.coverage.is_empty());
        assert!(!row.writer_requires);
        assert!(matches!(
            bare.enable_history(&born, T2, true).unwrap_err(),
            Error::HistoryUnavailable
        ));
        bare.close().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enable_writes_the_baseline_and_disable_closes_the_interval() {
        // `spec/store` §5.9 on an in-memory store: born disabled, two
        // documents written uncaptured (no history table), `enable` executes
        // the bundle and writes the baseline, `disable` closes the interval.
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo_with("fixture", T0, false).unwrap();
        assert!(!history_bundle_present(store.conn()).unwrap());
        let cfg = crate::Config::default();
        store
            .observe_batch(
                &repo,
                &[
                    crate::BatchItem::observed("a.md", "# A\n\nOne.\n"),
                    crate::BatchItem::observed("b.md", "# B\n\nTwo [a](a.md).\n"),
                ],
                T1,
                &cfg,
            )
            .unwrap();
        assert!(!history_bundle_present(store.conn()).unwrap());
        assert!(store.read_at_revision("d_0", "r_0").unwrap().is_none());
        let r = store.enable_history(&repo, T2, true).unwrap();
        assert!(r.changed);
        assert_eq!(r.baseline.as_ref().map(|b| b.1), Some(2));
        assert_eq!(r.row.state, ManifestState::Enabled);
        assert_eq!(
            r.row.coverage,
            [CoverageInterval {
                from: T2.into(),
                to: None
            }]
        );
        assert!(r.row.writer_requires);
        let (commit, _) = r.baseline.unwrap();
        let (reason, origin): (String, String) = store
            .conn()
            .query_row(
                "SELECT reason, origin FROM commits WHERE commit_id = ?1",
                params![commit],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (reason.as_str(), origin.as_str()),
            (HISTORY_ENABLED_REASON, "import")
        );
        let entries: i64 = store
            .conn()
            .query_row(
                "SELECT count(*) FROM feed_entries fe JOIN feed f ON f.repo_id = fe.repo_id AND f.epoch = fe.epoch AND f.seq = fe.seq WHERE f.commit_id = ?1 AND fe.kind = 'changed'",
                params![commit],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(entries, 2);
        let read = store.read_at_revision("d_0", "r_0").unwrap().unwrap();
        assert_eq!(read.content, "# A\n\nOne.\n");
        assert!(read.rendered_hash_match);
        // The edge opened while capture was off has an open transition from the baseline.
        let open: i64 = store
            .conn()
            .query_row(
                "SELECT count(*) FROM edge_transitions WHERE to_commit IS NULL AND from_commit = ?1",
                params![commit],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(open, 1);
        // Idempotent.
        let again = store
            .enable_history(&repo, "2026-09-26T13:00:00.000Z", false)
            .unwrap();
        assert!(!again.changed && again.baseline.is_none());
        assert!(again.row.writer_requires, "the flag is the enable's");
        let off = store
            .disable_history(&repo, "2026-09-26T14:00:00.000Z")
            .unwrap();
        assert!(off.changed);
        assert_eq!(
            off.row.coverage[0].to.as_deref(),
            Some("2026-09-26T14:00:00.000Z")
        );
        assert!(!off.row.writer_requires);
        assert!(
            !store
                .disable_history(&repo, "2026-09-26T15:00:00.000Z")
                .unwrap()
                .changed
        );
        assert_eq!(open_coverage_from(Some(&off.row)), None);
    }

    #[test]
    fn a_17_database_without_the_two_tables_gets_them_on_open() {
        let dir = std::env::temp_dir().join(format!(
            "omgbase-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        {
            let mut first =
                Store::open_with_minter(&path, Box::new(SequentialMinter::new())).unwrap();
            let repo = first.create_repo_at("fixture", T0).unwrap();
            first
                .observe_batch(
                    &repo,
                    &[crate::BatchItem::observed("a.md", "# A\n\nbody\n")],
                    T1,
                    &crate::Config::default(),
                )
                .unwrap();
            first
                .conn()
                .execute_batch("DROP TABLE capabilities; DROP TABLE alerts;")
                .unwrap();
            first.close().unwrap();
        }
        let before: Vec<(String, String, String, String)> = {
            let reopened = Store::from_connection_at(
                rusqlite::Connection::open(&path).unwrap(),
                Box::new(SequentialMinter::new()),
                Capabilities::standard(),
                T2,
            )
            .unwrap();
            let (history, semantic) = read_capabilities(reopened.conn(), "rp_0").unwrap();
            let history = history.unwrap();
            assert_eq!(history.state, ManifestState::Enabled);
            assert!(history.writer_requires);
            assert_eq!(
                history.coverage,
                [CoverageInterval {
                    from: T1.into(),
                    to: None
                }],
                "anchored on the repository's first commit"
            );
            assert_eq!(history.updated_at, T2, "the opener's clock");
            let semantic = semantic.unwrap();
            assert_eq!(semantic.state, ManifestState::Disabled);
            assert!(semantic.coverage.is_empty());
            let alerts: i64 = reopened
                .conn()
                .query_row("SELECT count(*) FROM alerts", [], |r| r.get(0))
                .unwrap();
            assert_eq!(alerts, 0);
            let mut stmt = reopened
                .conn()
                .prepare("SELECT capability, state, coverage, updated_at FROM capabilities ORDER BY capability")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            drop(stmt);
            reopened.close().unwrap();
            rows
        };
        // Idempotent: a second open leaves the rows alone.
        let third = Store::open_with_minter(&path, Box::new(SequentialMinter::new())).unwrap();
        let mut stmt = third
            .conn()
            .prepare("SELECT capability, state, coverage, updated_at FROM capabilities ORDER BY capability")
            .unwrap();
        let after = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<(String, String, String, String)>, _>>()
            .unwrap();
        drop(stmt);
        assert_eq!(after, before);
        third.close().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
