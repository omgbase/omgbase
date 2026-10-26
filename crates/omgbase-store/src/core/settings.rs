//! The store's own read of the settings layers (`spec/sync` §3: the
//! workspace layer with the repo's own deep-merged over it at the leaf) —
//! shared by the core's readers of a policy (the claims prune, §7.3; the feed
//! retention, §7.4) and the recorder's (`history::retention`, which
//! re-exports these for its existing importers). Port of
//! `packages/core/src/core/store/settings.ts`.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json};

use crate::error::Result;

/// A settings blob as stored (`workspace_settings.settings`, `repos.settings`):
/// an object, or `{}` for anything else.
#[must_use]
pub fn parse_settings_json(json: Option<&str>) -> Map<String, Json> {
    json.and_then(|s| serde_json::from_str::<Json>(s).ok())
        .and_then(|v| match v {
            Json::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// `over` deep-merged onto `base` at the leaf (objects merge, anything else replaces).
#[must_use]
pub fn deep_merge(base: &Map<String, Json>, over: &Map<String, Json>) -> Map<String, Json> {
    let mut out = base.clone();
    for (k, v) in over {
        let merged = match (out.get(k), v) {
            (Some(Json::Object(b)), Json::Object(o)) => Json::Object(deep_merge(b, o)),
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    out
}

/// The repo's own settings blob (`repos.settings`, the repo layer of
/// `spec/sync`'s two-layer settings).
pub fn repo_settings(conn: &Connection, repo_id: &str) -> Result<Map<String, Json>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT settings FROM repos WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(parse_settings_json(raw.as_deref()))
}

/// The repo's effective settings (`spec/sync` settings: the workspace layer
/// with the repo's own deep-merged over it at the leaf).
pub fn effective_settings(conn: &Connection, repo_id: &str) -> Result<Map<String, Json>> {
    // A migration's partial pre-state (`spec/store` §9.3) may lack the
    // workspace layer's table; the layer then reads as `{}` (a real database
    // always has it).
    let has_workspace: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_settings'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    let ws: Option<String> = if has_workspace {
        conn.query_row(
            "SELECT settings FROM workspace_settings WHERE id = 0",
            [],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    let ws = parse_settings_json(ws.as_deref());
    let own = repo_settings(conn, repo_id)?;
    Ok(deep_merge(&ws, &own))
}
