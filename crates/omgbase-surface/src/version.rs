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

/// The `version` result: `{ engine, version, components, specs, schema,
/// mcp, runtime, commit, built }`. `store` supplies `schema` (its
/// `PRAGMA user_version`; `null` without one).
pub fn version_info(store: Option<&Store>, build: &BuildInfo) -> crate::Result<Json> {
    let schema = match store {
        Some(s) => Json::from(s.user_version()?),
        None => Json::Null,
    };
    let runtime = build.rustc.clone().unwrap_or_else(|| "rustc".to_owned());
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
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_embedding_answers_with_its_own_version_and_nulls() {
        let store = Store::open_in_memory().unwrap();
        let v = version_info(Some(&store), &BuildInfo::default()).unwrap();
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
                "built"
            ]
        );
        let none = version_info(None, &BuildInfo::default()).unwrap();
        assert_eq!(none["schema"], Json::Null);
    }

    #[test]
    fn a_host_supplies_its_own_identity() {
        let build = BuildInfo {
            version: "9.9.9".to_owned(),
            cli_spec: Some("1.1".to_owned()),
            commit: Some("abc1234".to_owned()),
            built: Some("2026-09-27T00:00:00Z".to_owned()),
            rustc: Some("rustc 1.97.0".to_owned()),
        };
        let v = version_info(None, &build).unwrap();
        assert_eq!(v["version"], "9.9.9");
        assert_eq!(v["components"]["omgbase"], "9.9.9");
        assert_eq!(v["specs"]["cli"], "1.1");
        assert_eq!(v["runtime"], "rustc 1.97.0");
        assert_eq!(v["commit"], "abc1234");
        assert_eq!(v["built"], "2026-09-27T00:00:00Z");
    }
}
