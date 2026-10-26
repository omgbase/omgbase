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
//! without the recorder refuses), semantic `enabled` iff
//! `embedding.provider` resolves for the repository (resolution 1: vectors
//! are never consulted) — and migration 17 step (13) does the same for every
//! existing repository (coverage from its first commit). Until the Phase 4
//! verbs (`history enable|disable|purge`, `embed enable|disable`) exist, the
//! semantic row FOLLOWS the setting: every settings write re-derives it
//! ([`refresh_semantic_manifest`], called by `omgbase-sync`'s settings
//! writers), opening or closing a coverage interval when the state flips.
//! The history row is flipped by nothing in 17.0 (3e-ii): every composition
//! carries the recorder.
//!
//! Who reads it. `version.capabilities` and `capability_unavailable`'s state
//! (`omgbase-sync`'s `capability_state`), `doctor --size`'s `capabilities`
//! member and the `history`/`semantic` file lines ([`crate::size`]), and
//! every writer through [`require_writer`].

use omgbase_format::hash::sha256;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::core::alerts::{AlertInput, AlertSeverity, clear_alert, raise_alert};
use crate::core::codec::canonical_json;
use crate::core::settings::effective_settings;
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

/// The history row a repository gets when capture starts (`create_repo`,
/// migration 17): `enabled`, interface/data 1, `config {}`, one open coverage
/// interval from `from`, `writer_requires` per `writer_requires` (resolution
/// 17: 1). Idempotent: an existing row is left alone (the manifest is engine
/// state, never re-derived from elsewhere).
pub fn ensure_history_manifest(
    conn: &Connection,
    repo_id: &str,
    from: &str,
    now: &str,
    writer_requires: bool,
) -> Result<ManifestRow> {
    if let Some(existing) = read_capability(conn, repo_id, "history")? {
        return Ok(existing);
    }
    write_row(
        conn,
        repo_id,
        &WriteInput {
            capability: "history",
            state: ManifestState::Enabled,
            interface_v: HISTORY_INTERFACE_V,
            data_v: HISTORY_DATA_V,
            config: &Map::new(),
            coverage: &[CoverageInterval {
                from: from.to_owned(),
                to: None,
            }],
            writer_requires,
            now,
        },
    )?;
    read_written(conn, repo_id, "history")
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
/// `create_repo`, migration 17 and every settings write until the Phase 4
/// `embed` verbs own it.
pub fn refresh_semantic_manifest(
    conn: &Connection,
    repo_id: &str,
    now: &str,
) -> Result<ManifestRow> {
    if !manifest_table_exists(conn)? {
        return Err(Error::Other(
            "the capabilities table is missing — open the store through Store first".to_owned(),
        ));
    }
    let state = if semantic_provider_configured(conn, repo_id)? {
        ManifestState::Enabled
    } else {
        ManifestState::Disabled
    };
    let config = semantic_config_of(conn, repo_id)?;
    let Some(existing) = read_capability(conn, repo_id, "semantic")? else {
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
/// on migration) and the semantic row from the settings. Idempotent.
pub fn ensure_manifest(conn: &Connection, repo_id: &str, from: &str, now: &str) -> Result<()> {
    ensure_history_manifest(conn, repo_id, from, now, true)?;
    refresh_semantic_manifest(conn, repo_id, now)?;
    Ok(())
}

/// Every repository's semantic row re-derived (a WORKSPACE-layer settings
/// write touches them all).
pub fn refresh_semantic_manifests(conn: &Connection, now: &str) -> Result<()> {
    if !manifest_table_exists(conn)? {
        return Ok(());
    }
    let repos: Vec<String> = {
        let mut stmt = conn.prepare("SELECT repo_id FROM repos ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for repo_id in &repos {
        refresh_semantic_manifest(conn, repo_id, now)?;
    }
    Ok(())
}

/// The alert a refused writer raises (spec/store §3.1 `alerts`; §7 resolution 17).
pub const WRITER_REFUSED_ALERT: &str = "writer_refused";

/// The `writer_refused` alert's message, byte for byte in both engines.
pub const WRITER_REFUSED_MESSAGE: &str = "a writer without the history module was refused: this repository requires capture (writer_requires) — write through an engine that carries the history module, or run omg history disable";

/// The refusal's message (resolution 17), byte for byte what the reference
/// spells (`HISTORY_WRITER_REQUIRED_MESSAGE`).
pub const HISTORY_WRITER_REQUIRED_MESSAGE: &str = "history capture is required on this repository (writer_requires) and this engine runs without the history module — write through an engine that carries it, or run omg history disable";

/// `spec/store` §5.4 step 0 (17.0, 3e-ii — resolution 17): a writer without
/// the history module must refuse to write on a repository whose manifest
/// says `history` is `enabled` with `writer_requires = 1`. The refusal is
/// [`Error::HistoryWriterRequired`] (the surface's `capability_unavailable {
/// capability: "history", state: "unavailable" }`, retriable: the right
/// engine can) and raises the `writer_refused` alert so the stall is visible
/// where the user works; a write that passes clears it. `history_present` is
/// whether this store runs with the recorder. Through 17.0 every composition
/// carries it, so the refusal is unreachable in production — the check and
/// its shape are pinned here for Phase 4, when the core-only composition
/// drops the recorder.
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
    if history_present {
        clear_alert(conn, repo_id, WRITER_REFUSED_ALERT, now)?;
    }
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
        ensure_manifest(store.conn(), &repo, T1, T1).unwrap();
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
        let row = refresh_semantic_manifest(store.conn(), &repo, T1).unwrap();
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
        let row = refresh_semantic_manifest(store.conn(), &repo, T2).unwrap();
        assert_eq!(row.state, ManifestState::Enabled);
        assert_eq!(row.coverage[0].to, None);
        assert_eq!(row.config, settings(json!({ "model": "m2" })));
        assert_eq!(
            row.config_hash,
            config_hash(&settings(json!({ "model": "m2" })))
        );
        // Unchanged: not touched.
        assert_eq!(
            refresh_semantic_manifest(store.conn(), &repo, "2026-09-26T13:00:00.000Z")
                .unwrap()
                .updated_at,
            T2
        );
        // The provider gone: the interval closes.
        write_workspace(&store, &Map::new());
        let row =
            refresh_semantic_manifest(store.conn(), &repo, "2026-09-26T13:00:00.000Z").unwrap();
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
        // A composition without the recorder — what Phase 4's core-only
        // composition becomes. Fresh database: no migration needs it.
        let mut bare = Store::open_in_memory_with_capabilities(
            Box::new(SequentialMinter::new()),
            Capabilities::core_only(),
        )
        .unwrap();
        let repo = bare.create_repo_at("fixture", T0).unwrap();
        assert!(
            read_capability(bare.conn(), &repo, "history")
                .unwrap()
                .unwrap()
                .writer_requires
        );
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
        let items = [crate::BatchItem::observed("a.md", "# A\n")];
        let refused = bare
            .observe_batch(&repo, &items, T1, &crate::Config::default())
            .unwrap_err();
        assert!(matches!(refused, Error::HistoryWriterRequired));
        // The same repository written through an engine that carries the
        // recorder passes and clears the alert.
        require_writer(bare.conn(), true, &repo, T2).unwrap();
        assert!(list_active_alerts(bare.conn(), &repo).unwrap().is_empty());
        // A repository whose manifest does not require capture lets a
        // recorder-less writer through.
        bare.conn()
            .execute(
                "UPDATE capabilities SET writer_requires = 0 WHERE repo_id = ?1 AND capability = 'history'",
                params![repo],
            )
            .unwrap();
        require_writer(bare.conn(), false, &repo, T2).unwrap();
        // Every 17.0 composition carries the recorder: the check passes.
        let mut full =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = full.create_repo("fixture").unwrap();
        require_writer(full.conn(), true, &repo, T1).unwrap();
        full.observe_batch(&repo, &items, T1, &crate::Config::default())
            .unwrap();
        assert!(list_active_alerts(full.conn(), &repo).unwrap().is_empty());
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
