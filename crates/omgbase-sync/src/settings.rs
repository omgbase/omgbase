//! Settings (`spec/sync/README.md` §3): one schema at two layers — the
//! `workspace_settings` singleton (defaults) and `repos.settings`
//! (overrides) — resolved by a deep merge.

use omgbase_store::Store;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value};

use crate::error::Result;

/// A settings blob: a JSON object.
pub type Settings = Map<String, Value>;

/// Unparsable or non-object text reads as `{}`.
fn parse(text: Option<String>) -> Settings {
    match text.and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(m)) => m,
        _ => Settings::new(),
    }
}

/// The workspace default layer (row `id = 0`).
pub fn workspace_settings(store: &Store) -> Result<Settings> {
    let text: Option<String> = store
        .conn()
        .query_row(
            "SELECT settings FROM workspace_settings WHERE id = 0",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(parse(text))
}

/// A repo's own (override) blob — not merged.
pub fn repo_own_settings(store: &Store, repo_id: &str) -> Result<Settings> {
    let text: Option<String> = store
        .conn()
        .query_row(
            "SELECT settings FROM repos WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(parse(text))
}

/// Replace the workspace blob.
pub fn write_workspace_settings(store: &Store, settings: &Settings) -> Result<()> {
    store.conn().execute(
        "INSERT INTO workspace_settings (id, settings) VALUES (0, ?1)
         ON CONFLICT(id) DO UPDATE SET settings = excluded.settings",
        params![Value::Object(settings.clone()).to_string()],
    )?;
    Ok(())
}

/// Replace a repo's blob.
pub fn write_repo_settings(store: &Store, repo_id: &str, settings: &Settings) -> Result<()> {
    store.conn().execute(
        "UPDATE repos SET settings = ?1 WHERE repo_id = ?2",
        params![Value::Object(settings.clone()).to_string(), repo_id],
    )?;
    Ok(())
}

/// `over` wins at the leaf; a plain object over a plain object merges
/// recursively; anything else (scalars, arrays, `null`) replaces wholesale.
/// Key order: `base`'s keys in place, new keys appended (JavaScript's
/// `{ ...base }` then assignment).
#[must_use]
pub fn deep_merge(base: &Settings, over: &Settings) -> Settings {
    let mut out = base.clone();
    for (k, v) in over {
        let merged = match (out.get(k), v) {
            (Some(Value::Object(b)), Value::Object(o)) => Value::Object(deep_merge(b, o)),
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    out
}

/// `deep_merge(workspace, repo_own)`; the workspace layer alone for `None`.
pub fn resolve_settings(store: &Store, repo_id: Option<&str>) -> Result<Settings> {
    let defaults = workspace_settings(store)?;
    match repo_id {
        None => Ok(defaults),
        Some(id) => Ok(deep_merge(&defaults, &repo_own_settings(store, id)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Settings {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn deep_merge_rules() {
        let base = obj(json!({"a": 1, "e": {"m": "x", "d": 768}, "arr": [1, 2], "keep": true}));
        let over = obj(json!({"e": {"d": 384, "new": 1}, "arr": [3], "a": null, "z": {"q": 1}}));
        let merged = deep_merge(&base, &over);
        assert_eq!(
            Value::Object(merged.clone()),
            json!({"a": null, "e": {"m": "x", "d": 384, "new": 1}, "arr": [3], "keep": true, "z": {"q": 1}})
        );
        assert_eq!(
            merged.keys().collect::<Vec<_>>(),
            ["a", "e", "arr", "keep", "z"],
            "base order kept, new keys appended"
        );
        // A scalar over an object and an object over a scalar both replace.
        assert_eq!(
            Value::Object(deep_merge(
                &obj(json!({"x": {"a": 1}})),
                &obj(json!({"x": 2}))
            )),
            json!({"x": 2})
        );
        assert_eq!(
            Value::Object(deep_merge(
                &obj(json!({"x": 2})),
                &obj(json!({"x": {"a": 1}}))
            )),
            json!({"x": {"a": 1}})
        );
        assert_eq!(
            deep_merge(&Settings::new(), &Settings::new()),
            Settings::new()
        );
    }

    #[test]
    fn layers_round_trip_and_bad_text_reads_as_empty() {
        let mut s = Store::open_in_memory().unwrap();
        let repo = s.create_repo("r").unwrap();
        assert!(workspace_settings(&s).unwrap().is_empty());
        assert!(repo_own_settings(&s, &repo).unwrap().is_empty());
        write_workspace_settings(&s, &obj(json!({"embedding": {"model": "a", "dim": 1}}))).unwrap();
        write_repo_settings(&s, &repo, &obj(json!({"embedding": {"dim": 2}}))).unwrap();
        assert_eq!(
            Value::Object(resolve_settings(&s, Some(&repo)).unwrap()),
            json!({"embedding": {"model": "a", "dim": 2}})
        );
        assert_eq!(
            Value::Object(resolve_settings(&s, None).unwrap()),
            json!({"embedding": {"model": "a", "dim": 1}})
        );
        assert!(
            resolve_settings(&s, Some("rp_nope"))
                .unwrap()
                .contains_key("embedding")
        );
        s.conn()
            .execute("UPDATE workspace_settings SET settings = 'not json'", [])
            .unwrap();
        assert!(workspace_settings(&s).unwrap().is_empty());
        s.conn()
            .execute("UPDATE workspace_settings SET settings = '[1]'", [])
            .unwrap();
        assert!(workspace_settings(&s).unwrap().is_empty());
        write_workspace_settings(&s, &obj(json!({"k": 1}))).unwrap();
        assert_eq!(workspace_settings(&s).unwrap(), obj(json!({"k": 1})));
    }
}
