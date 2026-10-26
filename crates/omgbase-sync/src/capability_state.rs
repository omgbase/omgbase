//! The capability states as `version` and `sync_status` report them
//! (`spec/surface` §4, 5.1/6.0/6.1; modular-core Phase 2 → 3e-ii → 4a;
//! `docs/modular-core/phase-1-contracts.md` §1.5, §2.3 and §7 resolution 1):
//! `{ history: { state, coverage_from, writer_requires }, semantic: { state,
//! model } }`, in that key order. Port of
//! `packages/core/src/sync/capability-state.ts`. Since store 17.0 (3e-ii) the
//! states are READ FROM THE MANIFEST — the `capabilities` table
//! (`omgbase_store::manifest`): `history` is its row's state (`unavailable`
//! when the composition lacks the recorder — a core-only build, Phase 4a),
//! `semantic` its row's state overlaid with what the host knows
//! (`unavailable` when a configured provider failed to start — a runtime
//! fact, never persisted) and `disabled` when the store runs without the
//! module. The row itself follows resolution 1 — `enabled` iff a provider is
//! configured, stored vectors never consulted — written at `create_repo`, by
//! migration 17 and by every settings write until the Phase 4 `embed` verbs
//! own it. Without a repository there is no row to read: the answer is the
//! composition's for history and the workspace layer's provider setting for
//! semantic — exactly what Phase 2 derived.

use omgbase_store::manifest::{
    ManifestRow, ManifestState, coverage_from, read_capabilities, read_capability,
    semantic_provider_configured,
};
use omgbase_store::{CapabilityState, Store};
use serde_json::{Value as Json, json};

use crate::settings::resolve_settings;

/// Is an `embedding.provider` configured for `repo_id` (`None`: the
/// workspace layer alone) — `spec/sync` §3 resolution, a non-blank string?
#[must_use]
pub fn semantic_configured(store: &Store, repo_id: Option<&str>) -> bool {
    match repo_id {
        Some(r) => semantic_provider_configured(store.conn(), r).unwrap_or(false),
        None => resolve_settings(store, None)
            .ok()
            .and_then(|s| s.get("embedding").cloned())
            .and_then(|e| e.get("provider").and_then(Json::as_str).map(str::to_owned))
            .is_some_and(|p| !p.trim().is_empty()),
    }
}

/// The history capability's state for `repo_id`: the manifest row's
/// (`disabled` when absent); `unavailable` when the composition lacks the
/// recorder (reachable since Phase 4a — the core-only build); `enabled` for
/// the workspace layer alone.
#[must_use]
pub fn history_state(store: &Store, repo_id: Option<&str>) -> CapabilityState {
    if store.history().is_none() {
        return CapabilityState::Unavailable;
    }
    let Some(repo_id) = repo_id else {
        return CapabilityState::Enabled;
    };
    match read_capability(store.conn(), repo_id, "history") {
        Ok(Some(row)) if row.state == ManifestState::Enabled => CapabilityState::Enabled,
        _ => CapabilityState::Disabled,
    }
}

/// The semantic capability's state for `repo_id`: `disabled` when the store
/// runs without the module or the manifest row is absent or `disabled`;
/// `unavailable` when the row is `enabled` but the host reports the
/// configured provider failed to start ([`Store::semantic_state`]); `enabled`
/// otherwise.
#[must_use]
pub fn semantic_state(store: &Store, repo_id: Option<&str>) -> CapabilityState {
    let composition = store.semantic_state();
    if composition == CapabilityState::Disabled {
        return CapabilityState::Disabled;
    }
    let enabled = match repo_id {
        None => semantic_configured(store, None),
        Some(r) => matches!(
            read_capability(store.conn(), r, "semantic"),
            Ok(Some(row)) if row.state == ManifestState::Enabled
        ),
    };
    if !enabled {
        return CapabilityState::Disabled;
    }
    composition
}

/// The `version` tool's `capabilities` member (and the CLI's,
/// `sync_status`'s; byte for byte the reference's `capabilityStates`): both
/// capabilities' states from the manifest ([`history_state`],
/// [`semantic_state`]), with (`spec/surface` §4 `version`, 6.1 —
/// `phase-1-contracts.md` §2.3) `history.coverage_from` (the first coverage
/// interval's `from`, `spec/store` §3.1 rule 2; null when capture never ran)
/// and `writer_requires` (the manifest flag, resolution 17), and
/// `semantic.model` (the row's `config.model`, null when none is
/// configured), read from the rows; without a repository or a store
/// `null`/`false`.
#[must_use]
pub fn capability_states(store: Option<&Store>, repo_id: Option<&str>) -> Json {
    let (history, semantic) = match store {
        Some(s) => (history_state(s, repo_id), semantic_state(s, repo_id)),
        None => (CapabilityState::Disabled, CapabilityState::Disabled),
    };
    let (history_row, semantic_row): (Option<ManifestRow>, Option<ManifestRow>) =
        match (store, repo_id) {
            (Some(s), Some(r)) => read_capabilities(s.conn(), r).unwrap_or((None, None)),
            _ => (None, None),
        };
    json!({
        "history": {
            "state": history.as_str(),
            "coverage_from": coverage_from(history_row.as_ref()),
            "writer_requires": history_row.as_ref().is_some_and(|r| r.writer_requires),
        },
        "semantic": {
            "state": semantic.as_str(),
            "model": model_of(semantic_row.as_ref()),
        },
    })
}

/// The semantic row's `config.model` as a non-empty string, else `None`.
fn model_of(row: Option<&ManifestRow>) -> Option<&str> {
    row?.config.get("model")?.as_str().filter(|m| !m.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Settings, write_repo_settings, write_workspace_settings};

    fn provider(name: &str) -> Settings {
        let mut s = Settings::new();
        s.insert("embedding".to_owned(), json!({ "provider": name }));
        s
    }

    /// `version.capabilities` is the table's rendering: enabled/enabled with
    /// a provider, semantic disabled without one; the host's fault overlays
    /// `unavailable` on an enabled row; without a repository the workspace
    /// layer answers.
    #[test]
    fn the_states_are_the_manifests_rendering() {
        let mut store = Store::open_in_memory().unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let states = |s: &Store, r: Option<&str>| capability_states(Some(s), r).to_string();
        let birth = read_capability(store.conn(), &repo, "history")
            .unwrap()
            .unwrap()
            .coverage[0]
            .from
            .clone();
        // The wire shape (`spec/surface` §4 `version`, 6.1): the key order both engines pin.
        let disabled = format!(
            r#"{{"history":{{"state":"enabled","coverage_from":"{birth}","writer_requires":true}},"semantic":{{"state":"disabled","model":null}}}}"#
        );
        let enabled = format!(
            r#"{{"history":{{"state":"enabled","coverage_from":"{birth}","writer_requires":true}},"semantic":{{"state":"enabled","model":null}}}}"#
        );
        // Without a repository: the workspace layer's states, `null`/`false`.
        const WORKSPACE_DISABLED: &str = r#"{"history":{"state":"enabled","coverage_from":null,"writer_requires":false},"semantic":{"state":"disabled","model":null}}"#;
        const WORKSPACE_ENABLED: &str = r#"{"history":{"state":"enabled","coverage_from":null,"writer_requires":false},"semantic":{"state":"enabled","model":null}}"#;
        assert_eq!(states(&store, Some(&repo)), disabled);
        assert_eq!(states(&store, None), WORKSPACE_DISABLED);
        write_workspace_settings(&store, &provider("omgbase-embedder")).unwrap();
        assert_eq!(states(&store, Some(&repo)), enabled);
        assert_eq!(states(&store, None), WORKSPACE_ENABLED);
        // The row, not the setting, answers for a repository: a row left
        // `disabled` while the setting says otherwise reads `disabled`.
        store
            .conn()
            .execute(
                "UPDATE capabilities SET state = 'disabled' WHERE capability = 'semantic'",
                [],
            )
            .unwrap();
        assert_eq!(states(&store, Some(&repo)), disabled);
        assert_eq!(
            states(&store, None),
            WORKSPACE_ENABLED,
            "the workspace layer has no row"
        );
        // A settings write that leaves the effective provider as it was keeps
        // the row's state (`spec/store` §5.10, Phase 4b: `embed disable` is
        // sticky across unrelated writes) …
        write_repo_settings(&store, &repo, &Settings::new()).unwrap();
        assert_eq!(states(&store, Some(&repo)), disabled);
        // … and a provider CHANGE re-derives it — the repo layer naming
        // another provider, then handing back to the workspace's.
        write_repo_settings(&store, &repo, &provider("other-embedder")).unwrap();
        assert_eq!(states(&store, Some(&repo)), enabled);
        write_repo_settings(&store, &repo, &Settings::new()).unwrap();
        assert_eq!(states(&store, Some(&repo)), enabled);
        // The host's fault: unavailable where the row is enabled, disabled
        // where it is not.
        store.detach_semantic(Some("spawn ./embedder: ENOENT".to_owned()));
        assert_eq!(
            capability_states(Some(&store), Some(&repo))["semantic"]["state"],
            "unavailable"
        );
        write_workspace_settings(&store, &Settings::new()).unwrap();
        assert_eq!(states(&store, Some(&repo)), disabled);
        assert_eq!(states(&store, None), WORKSPACE_DISABLED);
        assert_eq!(
            capability_states(None, None).to_string(),
            r#"{"history":{"state":"disabled","coverage_from":null,"writer_requires":false},"semantic":{"state":"disabled","model":null}}"#
        );
        // A model configured: `semantic.model` reads it from the row.
        let mut with_model = provider("omgbase-embedder");
        with_model.insert(
            "embedding".to_owned(),
            json!({ "provider": "omgbase-embedder", "model": "gte-base" }),
        );
        write_workspace_settings(&store, &with_model).unwrap();
        assert_eq!(
            capability_states(Some(&store), Some(&repo))["semantic"]["model"],
            "gte-base"
        );
        // The core-only build (Phase 4a): history `unavailable`; a repository
        // it created has no coverage and requires nothing.
        let mut core = Store::open_in_memory_with_capabilities(
            Box::new(omgbase_store::RandomMinter),
            omgbase_store::Capabilities::core_only(),
        )
        .unwrap();
        let bare = core.create_repo("bare").unwrap();
        assert_eq!(
            states(&core, Some(&bare)),
            r#"{"history":{"state":"unavailable","coverage_from":null,"writer_requires":false},"semantic":{"state":"disabled","model":null}}"#
        );
    }
}
