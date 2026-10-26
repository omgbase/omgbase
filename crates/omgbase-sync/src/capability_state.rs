//! The capability states as `version` and `sync_status` report them
//! (`spec/surface` §4, 5.1/6.0; modular-core Phase 2 → 3e-ii; `docs/
//! modular-core/phase-1-contracts.md` §1.5, §2.3 and §7 resolution 1): `{
//! history: { state }, semantic: { state } }`. Port of
//! `packages/core/src/sync/capability-state.ts`. Since store 17.0 (3e-ii) the
//! states are READ FROM THE MANIFEST — the `capabilities` table
//! (`omgbase_store::manifest`): `history` is its row's state (`unavailable`
//! when the composition lacks the recorder — unreachable through 17.0),
//! `semantic` its row's state overlaid with what the host knows
//! (`unavailable` when a configured provider failed to start — a runtime
//! fact, never persisted) and `disabled` when the store runs without the
//! module. The row itself follows resolution 1 — `enabled` iff a provider is
//! configured, stored vectors never consulted — written at `create_repo`, by
//! migration 17 and by every settings write until the Phase 4 `embed` verbs
//! own it. Without a repository there is no row to read: the answer is the
//! composition's for history and the workspace layer's provider setting for
//! semantic — exactly what Phase 2 derived.

use omgbase_store::manifest::{ManifestState, read_capability, semantic_provider_configured};
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
/// recorder; `enabled` for the workspace layer alone.
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

/// The capability states (byte for byte the reference's `capabilityStates`):
/// both capabilities' states from the manifest ([`history_state`],
/// [`semantic_state`]). Without a store nothing is configured and no module
/// runs: both `disabled`.
#[must_use]
pub fn capability_states(store: Option<&Store>, repo_id: Option<&str>) -> Json {
    let (history, semantic) = match store {
        Some(s) => (history_state(s, repo_id), semantic_state(s, repo_id)),
        None => (CapabilityState::Disabled, CapabilityState::Disabled),
    };
    json!({
        "history": { "state": history.as_str() },
        "semantic": { "state": semantic.as_str() },
    })
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
        const DISABLED: &str = r#"{"history":{"state":"enabled"},"semantic":{"state":"disabled"}}"#;
        const ENABLED: &str = r#"{"history":{"state":"enabled"},"semantic":{"state":"enabled"}}"#;
        assert_eq!(states(&store, Some(&repo)), DISABLED);
        assert_eq!(states(&store, None), DISABLED);
        write_workspace_settings(&store, &provider("omgbase-embedder")).unwrap();
        assert_eq!(states(&store, Some(&repo)), ENABLED);
        assert_eq!(states(&store, None), ENABLED);
        // The row, not the setting, answers for a repository: a row left
        // `disabled` while the setting says otherwise reads `disabled`.
        store
            .conn()
            .execute(
                "UPDATE capabilities SET state = 'disabled' WHERE capability = 'semantic'",
                [],
            )
            .unwrap();
        assert_eq!(states(&store, Some(&repo)), DISABLED);
        assert_eq!(
            states(&store, None),
            ENABLED,
            "the workspace layer has no row"
        );
        // A settings write re-derives the row.
        write_repo_settings(&store, &repo, &Settings::new()).unwrap();
        assert_eq!(states(&store, Some(&repo)), ENABLED);
        // The host's fault: unavailable where the row is enabled, disabled
        // where it is not.
        store.detach_semantic(Some("spawn ./embedder: ENOENT".to_owned()));
        assert_eq!(
            capability_states(Some(&store), Some(&repo))["semantic"]["state"],
            "unavailable"
        );
        write_workspace_settings(&store, &Settings::new()).unwrap();
        assert_eq!(states(&store, Some(&repo)), DISABLED);
        assert_eq!(states(&store, None), DISABLED);
        assert_eq!(
            capability_states(None, None).to_string(),
            r#"{"history":{"state":"disabled"},"semantic":{"state":"disabled"}}"#
        );
    }
}
