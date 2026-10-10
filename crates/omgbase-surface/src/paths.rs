//! The two path forms (`spec/surface` §1 "Paths", 2.0). The store keeps a
//! document's path in git's repo-relative form (`projects/oqx.md`: `docs.path`,
//! the adapters, every store/sync spec), while every reference an author
//! writes — a Markdown link, a wikilink, a frontmatter relation — is
//! root-absolute (`/projects/oqx.md`). The surface speaks the reference form:
//! every path a query, a tool or a CLI verb RETURNS is `/`-rooted, and every
//! path they ACCEPT tolerates both forms. These two functions are the whole
//! conversion; the store never sees a rooted path and the surface never hands
//! out a bare one. Port of `packages/core/src/core/paths.ts`.

use serde_json::Value as Json;

/// The reference (surface) form of a storage path: exactly one leading `/`.
/// `""` (the repo root, `docs_tree`'s prefix) becomes `/`.
#[must_use]
pub fn reference_path(path: &str) -> String {
    format!("/{}", storage_path(path))
}

/// The storage form of a path a caller handed in: every leading `/` stripped
/// (a missing slash is fine, an extra one is forgiven).
#[must_use]
pub fn storage_path(path: &str) -> &str {
    path.trim_start_matches('/')
}

/// [`reference_path`] over a JSON string value; anything else passes through.
#[must_use]
pub fn reference_json(v: &Json) -> Json {
    match v.as_str() {
        Some(s) => Json::String(reference_path(s)),
        None => v.clone(),
    }
}

/// Re-key a `{ <path>: … }` object (the dry-run `diffs`) by the reference form,
/// positions kept.
#[must_use]
pub fn reference_keyed(v: &Json) -> Json {
    match v {
        Json::Object(m) => Json::Object(
            m.iter()
                .map(|(k, x)| (reference_path(k), x.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Root the string under `key` of a JSON object in place (a non-string or
/// absent value is left alone).
pub fn root_field(v: &mut Json, key: &str) {
    if let Some(m) = v.as_object_mut()
        && let Some(Json::String(s)) = m.get(key)
    {
        let rooted = reference_path(s);
        m.insert(key.to_owned(), Json::String(rooted));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_two_forms() {
        assert_eq!(reference_path("a/b.md"), "/a/b.md");
        assert_eq!(reference_path("/a/b.md"), "/a/b.md");
        assert_eq!(reference_path("//a.md"), "/a.md");
        assert_eq!(reference_path(""), "/");
        assert_eq!(storage_path("/a.md"), "a.md");
        assert_eq!(storage_path("a.md"), "a.md");
        assert_eq!(storage_path("///a.md"), "a.md");
        assert_eq!(storage_path(""), "");
        assert_eq!(reference_json(&json!("x.md")), json!("/x.md"));
        assert_eq!(reference_json(&json!(null)), json!(null));
        let keyed = reference_keyed(&json!({ "a.md": 1, "/b.md": 2 }));
        assert_eq!(
            keyed.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["/a.md", "/b.md"]
        );
        let mut v = json!({ "path": "a.md", "n": 1 });
        root_field(&mut v, "path");
        root_field(&mut v, "n");
        root_field(&mut v, "nope");
        assert_eq!(v, json!({ "path": "/a.md", "n": 1 }));
    }
}
