//! The capability states as `version` and `sync_status` report them
//! (`spec/surface` §4, 5.1/6.0; modular-core Phase 2 — `docs/modular-core/
//! phase-1-contracts.md` §2.3 and §7 resolution 1): `{ history: { state },
//! semantic: { state } }`. Port of `packages/core/src/sync/capability-state.ts`
//! — the states derive from the store's composition and the repository's
//! effective settings, never from the stored vectors.

use omgbase_store::{CapabilityState, Store};
use serde_json::{Value as Json, json};

use crate::settings::resolve_settings;

/// Is an `embedding.provider` configured for `repo_id` (`None`: the
/// workspace layer alone) — `spec/sync` §3 resolution, a non-blank string?
#[must_use]
pub fn semantic_configured(store: &Store, repo_id: Option<&str>) -> bool {
    resolve_settings(store, repo_id)
        .ok()
        .and_then(|s| s.get("embedding").cloned())
        .and_then(|e| e.get("provider").and_then(Json::as_str).map(str::to_owned))
        .is_some_and(|p| !p.trim().is_empty())
}

/// The capability states (byte for byte the reference's `capabilityStates`):
/// `history` is `enabled` while the store carries the recorder, else
/// `disabled` (no manifest row exists before Phase 3e); `semantic` follows
/// the discovery rule — `disabled` when the store runs without the module or
/// no provider is configured for the repository, `unavailable` when the
/// configured one failed to start, `enabled` otherwise. Without a store
/// nothing is configured and no module runs: both `disabled`.
#[must_use]
pub fn capability_states(store: Option<&Store>, repo_id: Option<&str>) -> Json {
    let (history, semantic) = match store {
        Some(s) => {
            let history = if s.history().is_some() {
                CapabilityState::Enabled
            } else {
                CapabilityState::Disabled
            };
            let semantic = match s.semantic_state() {
                CapabilityState::Enabled if !semantic_configured(s, repo_id) => {
                    CapabilityState::Disabled
                }
                state => state,
            };
            (history, semantic)
        }
        None => (CapabilityState::Disabled, CapabilityState::Disabled),
    };
    json!({
        "history": { "state": history.as_str() },
        "semantic": { "state": semantic.as_str() },
    })
}
