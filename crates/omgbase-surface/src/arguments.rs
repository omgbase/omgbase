//! Argument-shape errors (`spec/surface/README.md` §4 "Arguments", 3.0): every
//! tool call is checked against its [`ToolSpec`](crate::catalog::ToolSpec)'s
//! JSON schema ahead of dispatch, and a malformed call is one `filter_invalid`
//! whose message names what was expected — and, for an unknown argument name,
//! the nearest valid one. The reference (`packages/core/src/mcp/arguments.ts`)
//! composes the same messages byte for byte and the surface fixtures pin them
//! (every argument-shape error carries `data.hint = "arguments"`).
//!
//! Message forms (the `(… takes …)` tail lists the tool's arguments in
//! bytewise order, optional ones marked `?`; a tool without arguments "takes
//! no arguments"):
//!
//! ```text
//! unknown argument `q`; did you mean `query`? (blocks_search takes limit?, q, repo?)
//! `doc` is no longer an argument — pass `id` or `path` (docs_read takes …)
//! `query` is required (query takes …)
//! `limit` must be an integer (query takes …)
//! pass id or path (docs_read takes …)                      — a locator tool called with neither
//! id "d_x" and path "/a.md" name different documents (…)    — both given, disagreeing
//! ```

use serde_json::{Map, Value as Json, json};

use crate::error::{Result, SurfaceError};

/// The `(tool takes …)` tail: property names in bytewise order, `?` on the
/// ones not in `required`.
#[must_use]
pub fn arguments_hint(tool: &str, schema: &Json) -> String {
    let mut names: Vec<&str> = properties(schema).keys().map(String::as_str).collect();
    names.sort_unstable();
    if names.is_empty() {
        return format!("{tool} takes no arguments");
    }
    let required = required(schema);
    let list: Vec<String> = names
        .iter()
        .map(|n| {
            if required.contains(n) {
                (*n).to_owned()
            } else {
                format!("{n}?")
            }
        })
        .collect();
    format!("{tool} takes {}", list.join(", "))
}

/// A `filter_invalid` for an argument-shape failure: `message` plus the tool's shape.
#[must_use]
pub fn argument_error(tool: &str, message: &str, schema: &Json) -> SurfaceError {
    let full = format!("{message} ({})", arguments_hint(tool, schema));
    SurfaceError::with_data(
        "filter_invalid",
        full.clone(),
        json!({ "reason": full, "hint": "arguments" }),
    )
}

/// Check `args` against the tool's schema: unknown names first (bytewise
/// order), then each declared argument (bytewise order) for presence and
/// type. Nested shapes (`ops`, `expect`, `at`) are checked by their handlers.
pub fn validate_arguments(tool: &str, schema: &Json, args: &Json) -> Result<()> {
    let Some(obj) = args.as_object() else {
        if args.is_null() {
            return Ok(());
        }
        return Err(argument_error(tool, "arguments must be an object", schema));
    };
    let props = properties(schema);
    let mut given: Vec<&String> = obj.keys().collect();
    given.sort_unstable();
    for key in given {
        if !props.contains_key(key) {
            return Err(argument_error(
                tool,
                &unknown_argument_message(key, props),
                schema,
            ));
        }
    }
    let required = required(schema);
    let mut declared: Vec<(&String, &Json)> = props.iter().collect();
    declared.sort_unstable_by(|a, b| a.0.cmp(b.0));
    for (key, prop) in declared {
        match obj.get(key) {
            None => {
                if required.contains(&key.as_str()) {
                    return Err(argument_error(
                        tool,
                        &format!("`{key}` is required"),
                        schema,
                    ));
                }
            }
            Some(value) => {
                if !matches_schema(prop, value) {
                    return Err(argument_error(
                        tool,
                        &format!("`{key}` must be {}", phrase_for(prop)),
                        schema,
                    ));
                }
            }
        }
    }
    Ok(())
}

/// What to say about an argument name the tool does not take: the names 3.0
/// retired are called out with their replacement (`doc` → `id`/`path`,
/// `block`/`node` → `id`, `heading` → `section`,
/// `markdown` → `text`) when the tool has the replacement; otherwise the
/// nearest valid name (Levenshtein ≤ 2, or one a prefix of the other).
#[must_use]
pub fn unknown_argument_message(key: &str, props: &Map<String, Json>) -> String {
    let has = |n: &str| props.contains_key(n);
    let retired =
        |replacement: &str| format!("`{key}` is no longer an argument — pass {replacement}");
    if key == "doc" && has("id") && has("path") {
        return retired("`id` or `path`");
    }
    if (key == "block" || key == "node") && has("id") {
        return retired("`id`");
    }
    if key == "heading" && has("section") {
        return retired("`section` (the heading's text), or blocks_append with the heading's `id`");
    }
    if key == "markdown" && has("text") {
        return retired("`text`");
    }
    let candidates: Vec<&str> = props.keys().map(String::as_str).collect();
    match nearest(key, &candidates) {
        None => format!("unknown argument `{key}`"),
        Some(n) => format!("unknown argument `{key}`; did you mean `{n}`?"),
    }
}

/// The nearest candidate: Levenshtein distance ≤ 2, or a prefix relation
/// either way; ties → the bytewise-first.
#[must_use]
pub fn nearest<'a>(name: &str, candidates: &[&'a str]) -> Option<&'a str> {
    let mut sorted: Vec<&'a str> = candidates.to_vec();
    sorted.sort_unstable();
    let mut best: Option<(&'a str, usize)> = None;
    for c in sorted {
        let d = levenshtein(name, c);
        let prefix =
            !name.is_empty() && !c.is_empty() && (c.starts_with(name) || name.starts_with(c));
        if d > 2 && !prefix {
            continue;
        }
        let score = if prefix && d > 2 { 3 } else { d };
        if best.is_none_or(|(_, s)| score < s) {
            best = Some((c, score));
        }
    }
    best.map(|(c, _)| c)
}

#[must_use]
pub fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur.push((prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost));
        }
        prev = cur;
    }
    prev[b.len()]
}

// ---- JSON-schema introspection ---------------------------------------------------------

fn properties(schema: &Json) -> &Map<String, Json> {
    static EMPTY: std::sync::LazyLock<Map<String, Json>> = std::sync::LazyLock::new(Map::new);
    schema
        .get("properties")
        .and_then(Json::as_object)
        .unwrap_or(&EMPTY)
}

fn required(schema: &Json) -> Vec<&str> {
    schema
        .get("required")
        .and_then(Json::as_array)
        .map(|a| a.iter().filter_map(Json::as_str).collect())
        .unwrap_or_default()
}

/// The schema's `type` (the first non-null entry of a type list).
fn type_of(schema: &Json) -> Option<&str> {
    match schema.get("type") {
        Some(Json::String(t)) => Some(t.as_str()),
        Some(Json::Array(ts)) => ts.iter().filter_map(Json::as_str).find(|t| *t != "null"),
        _ => None,
    }
}

fn nullable(schema: &Json) -> bool {
    matches!(schema.get("type"), Some(Json::Array(ts)) if ts.iter().any(|t| t == "null"))
}

/// Does `value` fit the (shallow) schema — type, enum, `oneOf` for the `at`
/// spec; array items by their declared type?
fn matches_schema(schema: &Json, value: &Json) -> bool {
    if value.is_null() {
        return nullable(schema);
    }
    if let Some(options) = schema.get("enum").and_then(Json::as_array) {
        return options.contains(value);
    }
    if schema.get("oneOf").is_some() {
        // The `at` spec: "start" | "end" | { before } | { after }.
        return match value {
            Json::String(s) => s == "start" || s == "end",
            Json::Object(o) => {
                o.get("before").is_some_and(Json::is_string)
                    || o.get("after").is_some_and(Json::is_string)
            }
            _ => false,
        };
    }
    match type_of(schema) {
        Some("string") => value.is_string(),
        Some("integer") => value.as_f64().is_some_and(|n| n.fract() == 0.0),
        Some("boolean") => value.is_boolean(),
        Some("object") => value.is_object(),
        Some("array") => value.as_array().is_some_and(|items| {
            let item_type = schema.get("items").and_then(type_of);
            items.iter().all(|v| match item_type {
                Some("string") => v.is_string(),
                Some("integer") => v.as_f64().is_some_and(|n| n.fract() == 0.0),
                Some("object") => v.is_object(),
                _ => true,
            })
        }),
        _ => true,
    }
}

/// The expected-type phrase of an argument, as the reference spells it from
/// its zod schema.
#[must_use]
pub fn phrase_for(schema: &Json) -> String {
    if let Some(options) = schema.get("enum").and_then(Json::as_array) {
        let names: Vec<&str> = options.iter().filter_map(Json::as_str).collect();
        return format!("one of {}", names.join(", "));
    }
    if schema.get("oneOf").is_some() {
        return "\"start\", \"end\", {before} or {after}".to_owned();
    }
    match type_of(schema) {
        Some("string") => "a string".to_owned(),
        Some("integer") => "an integer".to_owned(),
        Some("boolean") => "a boolean".to_owned(),
        Some("object") => "an object".to_owned(),
        Some("array") => {
            let inner = match schema.get("items").and_then(type_of) {
                Some("string") => "strings",
                Some("integer") => "integers",
                _ => "objects",
            };
            format!("an array of {inner}")
        }
        _ => "valid".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Json {
        json!({ "type": "object", "properties": {
            "id": { "type": "string" }, "path": { "type": "string" }, "include_ids": { "type": "boolean" }, "repo": { "type": "string" }
        }, "required": [] })
    }

    #[test]
    fn hints_list_the_shape_in_bytewise_order() {
        assert_eq!(
            arguments_hint("docs_read", &schema()),
            "docs_read takes id?, include_ids?, path?, repo?"
        );
        assert_eq!(
            arguments_hint(
                "repos",
                &json!({ "type": "object", "properties": {}, "required": [] })
            ),
            "repos takes no arguments"
        );
    }

    #[test]
    fn unknown_names_are_corrected() {
        let s = schema();
        let e = validate_arguments("docs_read", &s, &json!({ "doc": "a.md" })).unwrap_err();
        assert_eq!(
            e.message,
            "`doc` is no longer an argument — pass `id` or `path` (docs_read takes id?, include_ids?, path?, repo?)"
        );
        assert_eq!(e.data.unwrap()["hint"], "arguments");
        let e = validate_arguments("docs_read", &s, &json!({ "include_id": true })).unwrap_err();
        assert!(
            e.message
                .starts_with("unknown argument `include_id`; did you mean `include_ids`?")
        );
        let e = validate_arguments("docs_read", &s, &json!({ "zzz": true })).unwrap_err();
        assert!(e.message.starts_with("unknown argument `zzz` ("));
        let q = json!({ "type": "object", "properties": { "q": { "type": "string" }, "limit": { "type": "integer" } }, "required": ["q"] });
        let e = validate_arguments("blocks_search", &q, &json!({ "query": "x" })).unwrap_err();
        assert!(
            e.message
                .starts_with("unknown argument `query`; did you mean `q`?")
        );
        let e = validate_arguments("blocks_search", &q, &json!({})).unwrap_err();
        assert_eq!(e.message, "`q` is required (blocks_search takes limit?, q)");
        let e = validate_arguments("blocks_search", &q, &json!({ "q": "x", "limit": "5" }))
            .unwrap_err();
        assert_eq!(
            e.message,
            "`limit` must be an integer (blocks_search takes limit?, q)"
        );
        assert!(validate_arguments("blocks_search", &q, &json!({ "q": "x", "limit": 5 })).is_ok());
    }

    #[test]
    fn distance_and_nearest() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("", "ab"), 2);
        assert_eq!(nearest("q", &["query", "limit"]), Some("query"));
        assert_eq!(nearest("id", &["id", "path"]), Some("id"));
        assert_eq!(nearest("zzzz", &["id", "path"]), None);
    }
}
