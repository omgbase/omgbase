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

/// `apply { ops }` (4.0, `spec/surface` §4): the kernel ops `apply` took
/// through 3.x are a library/fixture contract (`spec/mutate` §4).
pub const OPS_RETIRED: &str = "`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0)";
/// `dry_run` on `apply` and every sugar tool (4.0): the preview is `plan`.
pub const DRY_RUN_RETIRED: &str =
    "`dry_run` is no longer an argument — preview with `plan { effects: [...] }`";

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
    argument_error_fix(tool, message, schema, None)
}

/// [`argument_error`] with a `fix` (4.5, `spec/surface` §4 "Arguments")
/// when the corrected call can be spelled.
#[must_use]
pub fn argument_error_fix(
    tool: &str,
    message: &str,
    schema: &Json,
    fix: Option<String>,
) -> SurfaceError {
    let full = format!("{message} ({})", arguments_hint(tool, schema));
    let mut data = json!({ "reason": full, "hint": "arguments" });
    if let Some(fix) = fix
        && let Some(d) = data.as_object_mut()
    {
        d.insert("fix".to_owned(), json!(fix));
    }
    SurfaceError::with_data("filter_invalid", full, data)
}

// ---- string lists (`spec/surface` §4 "Arguments", 4.5) -----------------------------------
//
// Every list-of-strings argument (`docs`, `ids`, `roots`, `blocks`, `select`,
// `unset`) also takes ONE bare string as a one-element list — the first guess
// of a caller who has one ref. A comma-joined string is still "must be an
// array of strings", but that error carries a `fix`: the same call with the
// string split on commas (each part trimmed, empty parts dropped), canonical
// JSON.

/// Is this argument's schema a string list (`{ type: array, items: { type: string } }`)?
fn is_string_list(schema: &Json) -> bool {
    type_of(schema) == Some("array") && schema.get("items").and_then(type_of) == Some("string")
}

/// The parts of a comma-joined string: split on `,`, trimmed, empty parts dropped.
#[must_use]
pub fn comma_split(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Check `args` against the tool's schema: unknown names first (bytewise
/// order), then each declared argument (bytewise order) for presence and
/// type. Nested shapes (`ops`, `expect`, `at`) are checked by their handlers.
/// Returns the arguments as the handler sees them when the check normalized
/// one (4.5: a bare string in a string-list slot becomes `[s]`), else `None`.
pub fn validate_arguments(tool: &str, schema: &Json, args: &Json) -> Result<Option<Json>> {
    let Some(obj) = args.as_object() else {
        if args.is_null() {
            return Ok(None);
        }
        return Err(argument_error(tool, "arguments must be an object", schema));
    };
    let mut normalized: Option<Map<String, Json>> = None;
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
                if is_string_list(prop)
                    && let Some(s) = value.as_str()
                {
                    // (4.5) one bare string is a one-element list; a
                    // comma-joined one is the array error with the split
                    // list as its `fix`.
                    if s.contains(',') {
                        let mut fixed = obj.clone();
                        fixed.insert(key.clone(), json!(comma_split(s)));
                        return Err(argument_error_fix(
                            tool,
                            &format!("`{key}` must be an array of strings"),
                            schema,
                            Some(omgbase_mutate::canonical_json(&Json::Object(fixed))),
                        ));
                    }
                    normalized
                        .get_or_insert_with(|| obj.clone())
                        .insert(key.clone(), json!([s]));
                    continue;
                }
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
    Ok(normalized.map(Json::Object))
}

/// What to say about an argument name the tool does not take: the names 3.0
/// retired are called out with their replacement (`doc` → `id`/`path`,
/// `block`/`node` → `id`, `heading` → `section`, `markdown` → `text`) when
/// the tool has the replacement, and so are the inputs 4.0 retired — `ops`
/// (where the tool takes `effects`: the kernel ops are a library/fixture
/// contract), `dry_run` (every preview is `plan`), `attrs` (where the tool
/// takes `checked`); otherwise the nearest valid name (Levenshtein ≤ 2, or
/// one a prefix of the other).
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
    if key == "ops" && has("effects") {
        return OPS_RETIRED.to_owned();
    }
    if key == "dry_run" {
        return DRY_RUN_RETIRED.to_owned();
    }
    if key == "attrs" && has("checked") {
        return retired("`checked`");
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

    /// The inputs 4.0 retired name their replacement (`spec/surface` §4).
    #[test]
    fn retired_write_inputs_name_their_replacement() {
        let apply = json!({ "type": "object", "properties": { "effects": { "type": "array" }, "reason": { "type": "string" } }, "required": ["effects"] });
        let e = validate_arguments("apply", &apply, &json!({ "ops": [] })).unwrap_err();
        assert_eq!(
            e.message,
            "`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0) (apply takes effects, reason?)"
        );
        let e = validate_arguments("apply", &apply, &json!({ "effects": [], "dry_run": true }))
            .unwrap_err();
        assert_eq!(
            e.message,
            "`dry_run` is no longer an argument — preview with `plan { effects: [...] }` (apply takes effects, reason?)"
        );
        let e = validate_arguments("apply", &apply, &json!({})).unwrap_err();
        assert_eq!(
            e.message,
            "`effects` is required (apply takes effects, reason?)"
        );
        let update = json!({ "type": "object", "properties": { "id": { "type": "string" }, "checked": { "type": "boolean" } }, "required": ["id"] });
        let e = validate_arguments(
            "blocks_update",
            &update,
            &json!({ "id": "b_1", "attrs": {} }),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "`attrs` is no longer an argument — pass `checked` (blocks_update takes checked?, id)"
        );
        // Unknown names are never stripped: the check runs before the handler.
        let e = validate_arguments("blocks_update", &update, &json!({ "id": "b_1", "zzz": 1 }))
            .unwrap_err();
        assert!(e.message.starts_with("unknown argument `zzz` ("));
    }

    #[test]
    fn distance_and_nearest() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("", "ab"), 2);
        assert_eq!(nearest("q", &["query", "limit"]), Some("query"));
        assert_eq!(nearest("id", &["id", "path"]), Some("id"));
        assert_eq!(nearest("zzzz", &["id", "path"]), None);
    }

    /// `spec/surface` §4 "Arguments" (4.5): a string list takes one bare
    /// string; a comma-joined one is the array error with the split call as
    /// its `fix`; anything else is the array error alone.
    #[test]
    fn string_lists_take_one_bare_string_and_fix_a_comma_joined_one() {
        let s = json!({ "type": "object", "properties": {
            "docs": { "type": "array", "items": { "type": "string" } }, "include_ids": { "type": "boolean" }, "repo": { "type": "string" }
        }, "required": ["docs"] });
        assert_eq!(
            validate_arguments("docs_read_many", &s, &json!({ "docs": "a.md" })).unwrap(),
            Some(json!({ "docs": ["a.md"] }))
        );
        assert_eq!(
            validate_arguments("docs_read_many", &s, &json!({ "docs": ["a.md"] })).unwrap(),
            None
        );
        let e = validate_arguments(
            "docs_read_many",
            &s,
            &json!({ "docs": "a.md, b.md,", "include_ids": true }),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "`docs` must be an array of strings (docs_read_many takes docs, include_ids?, repo?)"
        );
        let d = e.data.unwrap();
        assert_eq!(d["hint"], "arguments");
        assert_eq!(d["fix"], r#"{"docs":["a.md","b.md"],"include_ids":true}"#);
        let e = validate_arguments("docs_read_many", &s, &json!({ "docs": 7 })).unwrap_err();
        assert!(
            e.message
                .starts_with("`docs` must be an array of strings (")
        );
        assert!(e.data.unwrap().get("fix").is_none());
        assert_eq!(comma_split(" a , ,b,"), ["a", "b"]);
    }
}
