//! The `version` tool (`spec/surface` §4, 1.4): which engine and which
//! versions — the serving binary's own, every component crate's, the spec
//! versions they were built against, the database schema, the MCP protocol,
//! the runtime, the build's commit and time.
//!
//! Who knows what. This crate knows the components (every `omgbase-*` crate
//! and `oqx` are its dependencies, each with a `VERSION` and a
//! `SPEC_VERSION`), the schema (the open store) and the protocol revision the
//! catalog is written against. It does **not** know the binary: the `omgbase`
//! crate depends on this one, not the other way round, so the host passes a
//! [`BuildInfo`] — its version, its `spec/cli` version, the build's commit
//! and time (`build.rs`), the compiler. Without one (a library embedding)
//! the tool answers with this crate's own version and nulls, which is the
//! shape the fixture runner records. Port of `packages/core/src/version.ts`.

use omgbase_store::Store;
use serde_json::{Map, Value as Json, json};

use crate::catalog::Profile;

/// The MCP protocol revision the catalog (§4) is written against and the
/// `omgbase` binary serves by default when a client names none (the
/// reference's SDK `LATEST_PROTOCOL_VERSION`). A client's own revision is
/// echoed at `initialize`; the four methods the server speaks are identical
/// across revisions.
pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

/// What the serving binary knows about itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildInfo {
    /// The binary's own version (the `omgbase` crate's; what `--version` prints).
    pub version: String,
    /// The `spec/cli/VERSION` the binary renders (`specs.cli`); `None` for a
    /// host without a CLI (`null` on the wire).
    pub cli_spec: Option<String>,
    /// The build's short git revision; `None` when unknown.
    pub commit: Option<String>,
    /// The build's RFC 3339 time; `None` when unknown.
    pub built: Option<String>,
    /// `rustc --version` at build time; `None` → `"rustc"`.
    pub rustc: Option<String>,
}

impl Default for BuildInfo {
    /// The library embedding: this crate's own version, no CLI, no build.
    fn default() -> Self {
        Self {
            version: crate::VERSION.to_owned(),
            cli_spec: None,
            commit: None,
            built: None,
            rustc: None,
        }
    }
}

/// Every omgbase crate the binary is built from, with its version — the
/// binary's own first (its version is the host's), then the dependency
/// crates; keys sorted bytewise.
fn components(build: &BuildInfo) -> Json {
    let mut m: Vec<(&str, &str)> = vec![
        ("omgbase", build.version.as_str()),
        ("omgbase-format", omgbase_format::VERSION),
        ("omgbase-graph", omgbase_graph::VERSION),
        ("omgbase-mutate", omgbase_mutate::VERSION),
        ("omgbase-properties", omgbase_properties::VERSION),
        ("omgbase-reconcile", omgbase_reconcile::VERSION),
        ("omgbase-search", omgbase_search::VERSION),
        ("omgbase-store", omgbase_store::VERSION),
        ("omgbase-surface", crate::VERSION),
        ("omgbase-sync", omgbase_sync::VERSION),
        ("oqx", oqx::VERSION),
    ];
    m.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Json::Object(
        m.into_iter()
            .map(|(k, v)| (k.to_owned(), Json::String(v.to_owned())))
            .collect::<Map<_, _>>(),
    )
}

/// The `spec/<x>/VERSION` each crate implements, in the order §4 lists them.
fn specs(build: &BuildInfo) -> Json {
    json!({
        "oqx": oqx::LANGUAGE_VERSION,
        "format": omgbase_format::SPEC_VERSION,
        "reconcile": omgbase_reconcile::SPEC_VERSION,
        "store": omgbase_store::SPEC_VERSION,
        "properties": omgbase_properties::SPEC_VERSION,
        "graph": omgbase_graph::SPEC_VERSION,
        "search": omgbase_search::SPEC_VERSION,
        "mutate": omgbase_mutate::SPEC_VERSION,
        "sync": omgbase_sync::SPEC_VERSION,
        "surface": crate::SPEC_VERSION,
        "cli": build.cli_spec,
    })
}

/// Is an `embedding.provider` configured for `repo_id` (`None`: the
/// workspace layer alone) — `spec/sync` §3 resolution, a non-blank string?
/// (The sync layer's, re-exported: `sync_status` reports the same states.)
pub fn semantic_configured(store: &Store, repo_id: Option<&str>) -> bool {
    omgbase_sync::semantic_configured(store, repo_id)
}

/// The capability manifest as `version` reports it (`spec/surface` §4, 6.1;
/// byte for byte the reference's `capabilityStates`): `{ history: { state,
/// coverage_from, writer_requires }, semantic: { state, model } }` — since
/// store 17.0 (3e-ii) read from the repository's `capabilities` rows
/// (`omgbase_store::manifest`): `history` the row's state (`unavailable`
/// when the composition lacks the recorder — a core-only build, Phase 4a),
/// `semantic` the row's state overlaid with what the host knows —
/// `disabled` when the store runs without the module, `unavailable` when the
/// configured provider failed to start — never from the vectors
/// (`phase-1-contracts.md` §7 resolution 1). Without a repository the
/// workspace layer's setting answers, as Phase 2 did; without a store nothing
/// is configured and no module runs: both `disabled`. The computation is the
/// sync layer's ([`omgbase_sync::capability_states`]), which `sync_status`
/// shares (4.0).
pub fn capabilities(store: Option<&Store>, repo_id: Option<&str>) -> Json {
    omgbase_sync::capability_states(store, repo_id)
}

/// The `version` result: `{ engine, version, components, specs, schema,
/// mcp, runtime, commit, built, profile, capabilities, epoch }`. `store`
/// supplies `schema` (its `PRAGMA user_version`; `null` without one) and the
/// capability states ([`capabilities`]); `profile` is the catalog profile
/// the host serves (§4 "Profiles", 4.3) — a server's `--tools`, and `Full`
/// for the CLI's own `version` verb and a library embedding; `epoch` (6.0,
/// the last key) the default repository's feed epoch (`spec/store` §3.1
/// `repos.epoch` — the first half of a `changes_since` cursor), `null`
/// without a repository.
pub fn version_info(
    store: Option<&Store>,
    build: &BuildInfo,
    profile: Profile,
) -> crate::Result<Json> {
    version_info_for(store, None, build, profile)
}

/// [`version_info`] with the repository whose capability states `capabilities`
/// reports (`None`: the workspace layer's configuration).
pub fn version_info_for(
    store: Option<&Store>,
    repo_id: Option<&str>,
    build: &BuildInfo,
    profile: Profile,
) -> crate::Result<Json> {
    let schema = match store {
        Some(s) => Json::from(s.user_version()?),
        None => Json::Null,
    };
    let runtime = build.rustc.clone().unwrap_or_else(|| "rustc".to_owned());
    // The default repository's feed epoch (`spec/surface` §4 `version.epoch`,
    // 6.0); null when none selects or the store does not know it.
    let epoch: Option<String> = match (store, repo_id) {
        (Some(s), Some(r)) => omgbase_store::repo_epoch(s.conn(), r).ok(),
        _ => None,
    };
    Ok(json!({
        "engine": "rust",
        "version": build.version,
        "components": components(build),
        "specs": specs(build),
        "schema": schema,
        "mcp": { "protocol": MCP_PROTOCOL_VERSION },
        "runtime": runtime,
        "commit": build.commit,
        "built": build.built,
        "profile": profile.as_str(),
        "capabilities": capabilities(store, repo_id),
        "epoch": epoch,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_embedding_answers_with_its_own_version_and_nulls() {
        let store = Store::open_in_memory().unwrap();
        let v = version_info(Some(&store), &BuildInfo::default(), Profile::Full).unwrap();
        assert_eq!(v["engine"], "rust");
        assert_eq!(v["version"], crate::VERSION);
        assert_eq!(v["components"]["omgbase-surface"], crate::VERSION);
        assert_eq!(v["components"]["omgbase"], crate::VERSION);
        assert_eq!(v["components"]["oqx"], oqx::VERSION);
        let keys: Vec<&String> = v["components"].as_object().unwrap().keys().collect();
        let mut sorted = keys.clone();
        sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        assert_eq!(keys, sorted);
        assert_eq!(keys.len(), 11);
        assert_eq!(v["specs"]["surface"], crate::SPEC_VERSION);
        assert_eq!(v["specs"]["store"], omgbase_store::SPEC_VERSION);
        assert_eq!(v["specs"]["cli"], Json::Null);
        assert_eq!(
            v["specs"].as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "oqx",
                "format",
                "reconcile",
                "store",
                "properties",
                "graph",
                "search",
                "mutate",
                "sync",
                "surface",
                "cli"
            ]
        );
        assert_eq!(v["schema"], omgbase_store::schema::SCHEMA_VERSION);
        assert_eq!(v["mcp"], json!({ "protocol": MCP_PROTOCOL_VERSION }));
        assert_eq!(v["runtime"], "rustc");
        assert_eq!(v["commit"], Json::Null);
        assert_eq!(v["built"], Json::Null);
        assert_eq!(v["profile"], "full");
        assert_eq!(
            v.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "engine",
                "version",
                "components",
                "specs",
                "schema",
                "mcp",
                "runtime",
                "commit",
                "built",
                "profile",
                "capabilities",
                "epoch"
            ]
        );
        assert_eq!(v["epoch"], Json::Null, "no repository selected");
        let none = version_info(None, &BuildInfo::default(), Profile::Full).unwrap();
        assert_eq!(none["schema"], Json::Null);
        assert_eq!(none["epoch"], Json::Null);
        assert_eq!(
            none["capabilities"],
            json!({
                "history": { "state": "disabled", "coverage_from": null, "writer_requires": false },
                "semantic": { "state": "disabled", "model": null },
            })
        );
    }

    /// The manifest member, byte for byte as both engines emit it (Phase 2 →
    /// 4a; the TypeScript twin prints the same literal, `spec/surface` §4
    /// 6.1's key order): `history` is `enabled` with the repository's birth
    /// as `coverage_from` and `writer_requires` on every full store,
    /// `semantic` follows the discovery rule — `enabled` iff a provider is
    /// configured for the repository; without a repository the history leaves
    /// read `null`/`false`.
    #[test]
    fn capabilities_is_the_literal_both_engines_agree_on() {
        let literal = |s: &Store, repo: Option<&str>| {
            let v = version_info_for(Some(s), repo, &BuildInfo::default(), Profile::Full).unwrap();
            // The repository's birth varies; it is asserted a timestamp and masked.
            let mut caps = v["capabilities"].clone();
            if let Some(from) = caps["history"]["coverage_from"].as_str() {
                assert!(
                    from.starts_with("20"),
                    "coverage_from is a timestamp: {from}"
                );
                caps["history"]["coverage_from"] = json!("<birth>");
            }
            serde_json::to_string(&json!({ "capabilities": caps })).unwrap()
        };
        const DISABLED: &str = r#"{"capabilities":{"history":{"state":"enabled","coverage_from":"<birth>","writer_requires":true},"semantic":{"state":"disabled","model":null}}}"#;
        const ENABLED: &str = r#"{"capabilities":{"history":{"state":"enabled","coverage_from":"<birth>","writer_requires":true},"semantic":{"state":"enabled","model":null}}}"#;
        const WS_DISABLED: &str = r#"{"capabilities":{"history":{"state":"enabled","coverage_from":null,"writer_requires":false},"semantic":{"state":"disabled","model":null}}}"#;
        const WS_ENABLED: &str = r#"{"capabilities":{"history":{"state":"enabled","coverage_from":null,"writer_requires":false},"semantic":{"state":"enabled","model":null}}}"#;
        // The module installed, nothing configured: disabled.
        let mut store = Store::open_in_memory().unwrap();
        let repo = store.create_repo("r").unwrap();
        assert_eq!(literal(&store, Some(&repo)), DISABLED);
        assert_eq!(literal(&store, None), WS_DISABLED);
        // The default repository's epoch rides `version` (6.0, the last key).
        let v = version_info_for(
            Some(&store),
            Some(&repo),
            &BuildInfo::default(),
            Profile::Full,
        )
        .unwrap();
        assert!(v["epoch"].as_str().is_some_and(|e| e.starts_with("ep_")));
        assert_eq!(
            v.as_object()
                .unwrap()
                .keys()
                .next_back()
                .map(String::as_str),
            Some("epoch")
        );
        // A provider configured at the workspace layer: enabled, for the
        // repo and for the workspace alone.
        let mut ws = omgbase_sync::Settings::new();
        ws.insert(
            "embedding".to_owned(),
            json!({ "provider": "omgbase-embedder" }),
        );
        omgbase_sync::write_workspace_settings(&store, &ws).unwrap();
        assert_eq!(literal(&store, Some(&repo)), ENABLED);
        assert_eq!(literal(&store, None), WS_ENABLED);
        // The repo's own layer turns it off for the repo alone.
        let mut own = omgbase_sync::Settings::new();
        own.insert("embedding".to_owned(), json!({ "provider": "" }));
        omgbase_sync::write_repo_settings(&store, &repo, &own).unwrap();
        assert_eq!(literal(&store, Some(&repo)), DISABLED);
        assert_eq!(literal(&store, None), WS_ENABLED);
        // Configured, but the composition detached the module: disabled, or
        // unavailable with the host's reason.
        let mut detached = Store::open_in_memory().unwrap();
        omgbase_sync::write_workspace_settings(&detached, &ws).unwrap();
        detached.detach_semantic(None);
        assert_eq!(literal(&detached, None), WS_DISABLED);
        detached.detach_semantic(Some("spawn ./embedder: ENOENT".to_owned()));
        let v = version_info(Some(&detached), &BuildInfo::default(), Profile::Full).unwrap();
        assert_eq!(v["capabilities"]["semantic"]["state"], "unavailable");
        // The core-only build (Phase 4a): no recorder either — history
        // `unavailable`; the repository it created has no coverage and
        // requires nothing.
        let mut core = Store::open_in_memory_with_capabilities(
            Box::new(omgbase_store::RandomMinter),
            omgbase_store::Capabilities::core_only(),
        )
        .unwrap();
        let bare = core.create_repo("bare").unwrap();
        assert_eq!(
            literal(&core, Some(&bare)),
            r#"{"capabilities":{"history":{"state":"unavailable","coverage_from":null,"writer_requires":false},"semantic":{"state":"disabled","model":null}}}"#
        );
    }
}
