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
//! `doc` is no longer an argument — pass `_id` or `_path` (docs_read takes …)
//! `query` is required (query takes …)
//! `limit` must be an integer (query takes …)
//! pass _id or _path (docs_read takes …)                      — a locator tool called with neither
//! _id "d_x" and _path "/a.md" name different documents (…)    — both given, disagreeing
//! ```
//!
//! A bare `id`/`path`/`ids`/`paths` where the tool takes its `_` spelling is
//! no longer refused outright (`spec/surface` §4, 6.6; through 6.5, 5.0's "no
//! tolerance" policy): when the `_` form is ABSENT from the call, the bare
//! name is silently respelled to it and the call proceeds — the response then
//! carries `argument_corrections` (one string per corrected key, last key,
//! absent when nothing was corrected). When the `_` form is ALSO given (a
//! real collision, not an obvious mistake), the bare name is still the
//! refusal below, unchanged — aliasing there would mean silently picking a
//! side.
//!
//! (6.7) A SEPARATE, small per-tool alias table (`TOOL_ARGUMENT_ALIASES`)
//! catches the same class of mistake for an argument name that is common
//! elsewhere in the catalog but is not an engine-field confusion: the
//! `query` tool takes `query`, but `blocks_search` takes `q` for the same
//! role, so a caller reaching for `q` on `query` out of habit is treated the
//! same way — safely respelled with a correction when the real name is
//! absent, refused as a collision when both are given. This is deliberately
//! its own mechanism, not an extension of `BARE_ENGINE_ARGUMENTS`: it has
//! nothing to do with the `_`-prefix convention.

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

// ---- string lists (`spec/surface` §4 "Arguments", 4.5 / 4.11) ----------------------------
//
// Every list-of-strings argument (`docs`, `ids`, `roots`, `blocks`, `select`,
// `unset`) also takes ONE bare string as a one-element list — the first guess
// of a caller who has one ref — and (4.11) a string that IS a JSON array of
// strings (`"[\"b_1\",\"b_2\"]"`, the list stringified by a client that
// serializes every argument) as that array: the intent is unambiguous, the
// same tolerance class as the bare string. A comma-joined string is still
// "must be an array of strings", but that error carries a `fix`: the same
// call with the string split on commas (each part trimmed, empty parts
// dropped), canonical JSON. A string opening `[` that is not a JSON array of
// strings is the same error, its `fix` the parsed array when it parsed (a
// JSON array of numbers) and the comma split otherwise (a malformed `[`).

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

/// What a string opening `[` in a string-list slot reads as (4.11, the
/// reference's `jsonArrayString`).
#[derive(Clone, Debug, PartialEq)]
pub enum JsonArrayString {
    /// A JSON array of strings: accepted as that list.
    List(Vec<String>),
    /// Anything else: the list the error's corrected call carries — the
    /// parsed array when the text parsed (a JSON array that is not all
    /// strings), else the comma split.
    Fix(Vec<Json>),
}

/// A string whose trimmed form opens `[`, read as JSON; `None` when it does
/// not open `[` (the 4.5 rules apply unchanged).
#[must_use]
pub fn json_array_string(s: &str) -> Option<JsonArrayString> {
    let trimmed = s.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    let comma = || JsonArrayString::Fix(comma_split(s).into_iter().map(Json::String).collect());
    let Ok(parsed) = serde_json::from_str::<Json>(trimmed) else {
        return Some(comma());
    };
    let Json::Array(items) = parsed else {
        return Some(comma());
    };
    if items.iter().all(Json::is_string) {
        return Some(JsonArrayString::List(
            items
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
        ));
    }
    Some(JsonArrayString::Fix(items))
}

/// The result of [`validate_arguments`]: the arguments the handler should
/// see (`None` when nothing needed normalizing — the caller's own `args`
/// still apply), plus one correction message per bare engine-field argument
/// that was safely respelled (`spec/surface` §4, 6.6) — empty when nothing
/// was.
#[derive(Debug, Default)]
pub struct ValidatedArguments {
    pub args: Option<Json>,
    pub corrections: Vec<String>,
}

/// Check `args` against the tool's schema: unknown names first (bytewise
/// order), then each declared argument (bytewise order) for presence and
/// type. Nested shapes (`ops`, `expect`, `at`) are checked by their handlers.
/// A bare `id`/`path`/`ids`/`paths` whose `_` spelling the tool takes AND the
/// call does not already give is safely respelled rather than refused (6.6)
/// — collected into `corrections`, not returned as an error.
pub fn validate_arguments(tool: &str, schema: &Json, args: &Json) -> Result<ValidatedArguments> {
    let Some(obj) = args.as_object() else {
        if args.is_null() {
            return Ok(ValidatedArguments::default());
        }
        return Err(argument_error(tool, "arguments must be an object", schema));
    };
    let mut normalized: Option<Map<String, Json>> = None;
    let props = properties(schema);
    let mut given: Vec<&String> = obj.keys().collect();
    given.sort_unstable();
    let mut corrections = Vec::new();
    // Each respelled key's real name — `_<key>` for a bare engine-field alias
    // (6.6), or the per-tool alias table's real name (6.7).
    let mut to_respell: Vec<(&str, String)> = Vec::new();
    for key in given {
        if props.contains_key(key) {
            continue;
        }
        if safe_to_alias_engine_argument(key, props, obj) {
            to_respell.push((key, format!("_{key}")));
            corrections.push(bare_engine_argument_correction(tool, key));
            continue;
        }
        if safe_to_alias_tool_argument(tool, key, props, obj) {
            let real = tool_argument_alias(tool, key, props).expect("checked above");
            to_respell.push((key, real.to_owned()));
            corrections.push(tool_argument_alias_correction(tool, key, props));
            continue;
        }
        // (5.0 / 6.7) A bare engine-field name, or a per-tool alias, where
        // the real spelling is also given (a collision, not aliased — see
        // above): the error still carries the corrected call (every such
        // key the call holds respelled at once), never a silent acceptance.
        let fix = if bare_engine_argument(key, props) {
            Some(omgbase_mutate::canonical_json(&Json::Object(
                respell_engine_arguments(obj, props),
            )))
        } else if tool_argument_alias(tool, key, props).is_some() {
            Some(omgbase_mutate::canonical_json(&Json::Object(
                respell_tool_arguments(tool, obj, props),
            )))
        } else {
            None
        };
        return Err(argument_error_fix(
            tool,
            &unknown_argument_message(tool, key, props),
            schema,
            fix,
        ));
    }
    // A safely-aliased key is respelled into its own map (6.6/6.7), kept
    // separate from `normalized` (4.5/4.11's own lazily-cloned copy below) so
    // the two compose — a call needing both ends up respelled AND
    // string-list-fixed — without `obj` ever borrowing out of the thing
    // `normalized` mutates.
    let respelled: Option<Map<String, Json>> = (!to_respell.is_empty()).then(|| {
        obj.iter()
            .map(|(k, v)| {
                let key = to_respell
                    .iter()
                    .find(|(mistaken, _)| *mistaken == k.as_str())
                    .map_or_else(|| k.clone(), |(_, real)| real.clone());
                (key, v.clone())
            })
            .collect()
    });
    let obj: &Map<String, Json> = respelled.as_ref().unwrap_or(obj);
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
                    // (4.11) a stringified JSON array of strings is that list
                    // — checked against the list schema itself (the `roots`
                    // minimum holds for it too); any other `[…` is the array
                    // error with the parsed array (or the comma split) as its
                    // `fix`.
                    if let Some(json) = json_array_string(s) {
                        match json {
                            JsonArrayString::Fix(list) => {
                                let mut fixed = obj.clone();
                                fixed.insert(key.clone(), Json::Array(list));
                                return Err(argument_error_fix(
                                    tool,
                                    &format!("`{key}` must be an array of strings"),
                                    schema,
                                    Some(omgbase_mutate::canonical_json(&Json::Object(fixed))),
                                ));
                            }
                            JsonArrayString::List(list) => {
                                let list = json!(list);
                                if !matches_schema(prop, &list) {
                                    return Err(argument_error(
                                        tool,
                                        &format!("`{key}` must be {}", phrase_for(prop)),
                                        schema,
                                    ));
                                }
                                normalized
                                    .get_or_insert_with(|| obj.clone())
                                    .insert(key.clone(), list);
                                continue;
                            }
                        }
                    }
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
    Ok(ValidatedArguments {
        args: normalized.or(respelled).map(Json::Object),
        corrections,
    })
}

/// The bare engine-field names a tool may be called with by mistake
/// (`spec/surface` §4, 5.0): each has its `_` spelling in the shape.
const BARE_ENGINE_ARGUMENTS: [&str; 4] = ["id", "path", "ids", "paths"];

/// Whether `key` is a bare engine-field name whose `_` spelling the tool takes.
#[must_use]
pub fn bare_engine_argument(key: &str, props: &Map<String, Json>) -> bool {
    BARE_ENGINE_ARGUMENTS.contains(&key) && props.contains_key(&format!("_{key}"))
}

/// Whether `key` is safe to silently alias to its `_` spelling (`spec/surface`
/// §4, 6.6): a bare engine-field name the tool takes AND the call does not
/// already give the `_` form — no collision to resolve silently.
#[must_use]
pub fn safe_to_alias_engine_argument(
    key: &str,
    props: &Map<String, Json>,
    args: &Map<String, Json>,
) -> bool {
    bare_engine_argument(key, props) && !args.contains_key(&format!("_{key}"))
}

/// The success-path notice for a bare engine-field argument safely respelled
/// (`spec/surface` §4, 6.6): names the mistake, says the call ran as the `_`
/// form on the caller's behalf, and asks the caller to remember the `_` form.
#[must_use]
pub fn bare_engine_argument_correction(tool: &str, key: &str) -> String {
    format!(
        "`{tool}` was called with `{key}` instead of `_{key}` — the bare namespace is the user's, `_{key}` is the engine field. This call ran as `_{key}` on your behalf; update your memory to use `_{key}` (not `{key}`) with `{tool}`."
    )
}

/// The call with every bare engine-field argument respelled to its `_` form
/// (the `fix` of the no-tolerance error).
#[must_use]
pub fn respell_engine_arguments(
    args: &Map<String, Json>,
    props: &Map<String, Json>,
) -> Map<String, Json> {
    let mut out = Map::new();
    for (k, v) in args {
        let key = if bare_engine_argument(k, props) {
            format!("_{k}")
        } else {
            k.clone()
        };
        out.insert(key, v.clone());
    }
    out
}

// ---- per-tool argument aliases (`spec/surface` §4 "Arguments", 6.7) ---------------------
//
// A mistake that is NOT an engine-field confusion: an argument name familiar
// from one tool, reached for on another tool that means the same thing by a
// different name. Kept as its own small, explicit table (one entry today)
// rather than folded into `BARE_ENGINE_ARGUMENTS` — the `_`-prefix mechanism
// above is specifically about the bare/engine-field split, and this is not.

/// The real argument name `key` is a known alias for on `tool`, when `tool`
/// actually takes that name (`props` has it) — `None` otherwise (no alias
/// for this tool/key, or the table names a real argument the tool doesn't
/// have).
#[must_use]
pub fn tool_argument_alias(
    tool: &str,
    key: &str,
    props: &Map<String, Json>,
) -> Option<&'static str> {
    let real: &'static str = match (tool, key) {
        // `blocks_search` takes `q`; `query` (the tool) takes `query` for
        // the same role (the search/filter expression) — an easy habit to
        // carry over.
        ("query", "q") => "query",
        _ => return None,
    };
    props.contains_key(real).then_some(real)
}

/// Whether `key` is a per-tool alias safe to silently respell on `tool`'s
/// call: a known alias the tool takes AND the call does not already give —
/// no collision to resolve silently.
#[must_use]
pub fn safe_to_alias_tool_argument(
    tool: &str,
    key: &str,
    props: &Map<String, Json>,
    args: &Map<String, Json>,
) -> bool {
    tool_argument_alias(tool, key, props).is_some_and(|real| !args.contains_key(real))
}

/// The success-path notice for a per-tool alias safely respelled
/// (`spec/surface` §4, 6.7) — the same shape as
/// [`bare_engine_argument_correction`], for a mistake that is a borrowed
/// argument name rather than a bare engine field.
#[must_use]
pub fn tool_argument_alias_correction(tool: &str, key: &str, props: &Map<String, Json>) -> String {
    let real = tool_argument_alias(tool, key, props).expect("checked by the caller");
    format!(
        "`{tool}` was called with `{key}` instead of `{real}` — `{key}` is another tool's argument name, `{real}` is `{tool}`'s. This call ran as `{real}` on your behalf; update your memory to use `{real}` (not `{key}`) with `{tool}`."
    )
}

/// The call with every per-tool alias on `tool` respelled to its real name
/// (the `fix` of the collision error).
#[must_use]
pub fn respell_tool_arguments(
    tool: &str,
    args: &Map<String, Json>,
    props: &Map<String, Json>,
) -> Map<String, Json> {
    let mut out = Map::new();
    for (k, v) in args {
        let key = tool_argument_alias(tool, k, props)
            .map(str::to_owned)
            .unwrap_or_else(|| k.clone());
        out.insert(key, v.clone());
    }
    out
}

/// What to say about an argument name the tool does not take. A bare engine
/// field (`id`, `path`, `ids`) where the tool takes its `_` spelling is the
/// no-tolerance error of 5.0 (`spec/surface` §4 "Arguments": the bare
/// namespace is the user's, an engine field is matched by its exact name);
/// a per-tool alias (6.7, [`tool_argument_alias`]) whose real name `tool`
/// ALSO takes is the same kind of refusal, for a mistake that borrows
/// another tool's argument name. The names 3.0 retired are called out with
/// their replacement (`doc` → `_id`/`_path`, `block`/`node` → `_id`,
/// `heading` → `section`, `markdown` → `text`) when the tool has the
/// replacement, and so are the inputs 4.0 retired — `ops` (where the tool
/// takes `effects`: the kernel ops are a library/fixture contract), `dry_run`
/// (every preview is `plan`), `attrs` (where the tool takes `checked`);
/// otherwise the nearest valid name (Levenshtein ≤ 2, or one a prefix of the
/// other).
#[must_use]
pub fn unknown_argument_message(tool: &str, key: &str, props: &Map<String, Json>) -> String {
    let has = |n: &str| props.contains_key(n);
    let retired =
        |replacement: &str| format!("`{key}` is no longer an argument — pass {replacement}");
    if bare_engine_argument(key, props) {
        return format!(
            "`{key}` is not an argument — the engine field is `_{key}` (the bare namespace is the user's); pass `_{key}`"
        );
    }
    if let Some(alias) = tool_argument_alias(tool, key, props) {
        return format!(
            "`{key}` is not an argument on `{tool}` — `{key}` is a different tool's argument name; pass `{alias}`"
        );
    }
    if key == "doc" && has("_id") && has("_path") {
        return retired("`_id` or `_path`");
    }
    if (key == "block" || key == "node") && has("_id") {
        return retired("`_id`");
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
            "_id": { "type": "string" }, "_path": { "type": "string" }, "include_ids": { "type": "boolean" }, "repo": { "type": "string" }
        }, "required": [] })
    }

    #[test]
    fn hints_list_the_shape_in_bytewise_order() {
        assert_eq!(
            arguments_hint("docs_read", &schema()),
            "docs_read takes _id?, _path?, include_ids?, repo?"
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
            "`doc` is no longer an argument — pass `_id` or `_path` (docs_read takes _id?, _path?, include_ids?, repo?)"
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

    /// (6.6, `spec/surface` §4 "Arguments"; through 6.5, 5.0's "no tolerance")
    /// a bare `id`/`path`/`ids` where the tool takes the `_` spelling and the
    /// call does not already give it is safely aliased: the call succeeds
    /// with the respelled args and a correction message per key, never an
    /// error.
    #[test]
    fn bare_engine_arguments_are_safely_aliased() {
        let s = schema();
        let v = validate_arguments("docs_read", &s, &json!({ "id": "d_1" })).unwrap();
        assert_eq!(v.args, Some(json!({ "_id": "d_1" })));
        assert_eq!(
            v.corrections,
            [
                "`docs_read` was called with `id` instead of `_id` — the bare namespace is the user's, `_id` is the engine field. This call ran as `_id` on your behalf; update your memory to use `_id` (not `id`) with `docs_read`."
            ]
        );
        // every bare engine field of the call is respelled at once, each its own correction
        let v = validate_arguments(
            "docs_read",
            &s,
            &json!({ "path": "a.md", "id": "d_1", "include_ids": true }),
        )
        .unwrap();
        assert_eq!(
            v.args,
            Some(json!({ "_id": "d_1", "_path": "a.md", "include_ids": true }))
        );
        assert_eq!(v.corrections.len(), 2);
        assert!(v.corrections[0].starts_with("`docs_read` was called with `id`"));
        assert!(v.corrections[1].starts_with("`docs_read` was called with `path`"));
        let many = json!({ "type": "object", "properties": { "_ids": { "type": "array", "items": { "type": "string" } } }, "required": ["_ids"] });
        let v = validate_arguments("blocks_read_many", &many, &json!({ "ids": ["b_1"] })).unwrap();
        assert_eq!(v.args, Some(json!({ "_ids": ["b_1"] })));
        assert!(v.corrections[0].starts_with("`blocks_read_many` was called with `ids`"));
        // a tool without the `_` spelling: the plain unknown-argument message, no fix, no alias
        let q = json!({ "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] });
        let e =
            validate_arguments("blocks_search", &q, &json!({ "q": "x", "id": "b_1" })).unwrap_err();
        assert!(e.message.starts_with("unknown argument `id`"));
        assert!(e.data.unwrap().get("fix").is_none());
    }

    /// When the `_` form is ALSO given — a real collision, not an obvious
    /// mistake — the bare name is still refused (the 5.0 message, `data.fix`
    /// the same call respelled): aliasing there would mean silently picking
    /// a side.
    #[test]
    fn a_bare_engine_argument_colliding_with_its_own_spelling_is_still_refused() {
        let s = schema();
        let e =
            validate_arguments("docs_read", &s, &json!({ "_id": "d_0", "id": "d_1" })).unwrap_err();
        assert_eq!(
            e.message,
            "`id` is not an argument — the engine field is `_id` (the bare namespace is the user's); pass `_id` (docs_read takes _id?, _path?, include_ids?, repo?)"
        );
        let d = e.data.unwrap();
        assert_eq!(d["hint"], "arguments");
        assert_eq!(d["fix"], r#"{"_id":"d_1"}"#);
    }

    /// (6.7) A per-tool alias — `query` (the tool) called with `q` instead
    /// of `query` (the `blocks_search` habit) — is safely respelled exactly
    /// like a bare engine-field argument: aliased with a correction when
    /// `query` is absent, refused as a collision when both are given.
    #[test]
    fn a_per_tool_argument_alias_is_safely_aliased_or_refused_as_a_collision() {
        let s = json!({ "type": "object", "properties": {
            "query": { "type": "string" }, "limit": { "type": "integer" }
        }, "required": ["query"] });
        let v = validate_arguments("query", &s, &json!({ "q": "docs { }" })).unwrap();
        assert_eq!(v.args, Some(json!({ "query": "docs { }" })));
        assert_eq!(
            v.corrections,
            [
                "`query` was called with `q` instead of `query` — `q` is another tool's argument name, `query` is `query`'s. This call ran as `query` on your behalf; update your memory to use `query` (not `q`) with `query`."
            ]
        );
        // both given: a real collision, refused exactly like the bare
        // engine-field case, `data.fix` the same call respelled.
        let e = validate_arguments(
            "query",
            &s,
            &json!({ "q": "docs { }", "query": "blocks { }" }),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "`q` is not an argument on `query` — `q` is a different tool's argument name; pass `query` (query takes limit?, query)"
        );
        // bytewise order: `q` < `query`, so `query`'s own given value is the
        // one applied last and wins — the same last-key-wins rule the bare
        // `_id`/`id` collision fix follows above.
        assert_eq!(e.data.unwrap()["fix"], r#"{"query":"blocks { }"}"#);
        // a tool without the alias (e.g. `blocks_search` itself, which takes
        // `q` natively): unaffected, the plain unknown-argument message.
        let bs = json!({ "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] });
        let e = validate_arguments("blocks_search", &bs, &json!({ "q": "x", "query": "y" }))
            .unwrap_err();
        assert!(
            e.message
                .starts_with("unknown argument `query`; did you mean `q`?")
        );
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
        let update = json!({ "type": "object", "properties": { "_id": { "type": "string" }, "checked": { "type": "boolean" } }, "required": ["_id"] });
        let e = validate_arguments(
            "blocks_update",
            &update,
            &json!({ "_id": "b_1", "attrs": {} }),
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "`attrs` is no longer an argument — pass `checked` (blocks_update takes _id, checked?)"
        );
        // Unknown names are never stripped: the check runs before the handler.
        let e = validate_arguments("blocks_update", &update, &json!({ "_id": "b_1", "zzz": 1 }))
            .unwrap_err();
        assert!(e.message.starts_with("unknown argument `zzz` ("));
    }

    #[test]
    fn distance_and_nearest() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("", "ab"), 2);
        assert_eq!(nearest("q", &["query", "limit"]), Some("query"));
        assert_eq!(nearest("_id", &["_id", "_path"]), Some("_id"));
        assert_eq!(nearest("zzzz", &["_id", "_path"]), None);
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
            validate_arguments("docs_read_many", &s, &json!({ "docs": "a.md" }))
                .unwrap()
                .args,
            Some(json!({ "docs": ["a.md"] }))
        );
        assert_eq!(
            validate_arguments("docs_read_many", &s, &json!({ "docs": ["a.md"] }))
                .unwrap()
                .args,
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

    /// (4.11) a stringified JSON array of strings is that list; any other
    /// `[…` is the array error with the parsed array (or the comma split) as
    /// its `fix` (`reads::arguments` steps 42–46).
    #[test]
    fn string_lists_take_a_stringified_json_array_of_strings() {
        let s = json!({ "type": "object", "properties": {
            "docs": { "type": "array", "items": { "type": "string" } }, "include_ids": { "type": "boolean" }, "repo": { "type": "string" }
        }, "required": ["docs"] });
        assert_eq!(
            validate_arguments(
                "docs_read_many",
                &s,
                &json!({ "docs": "[\"a.md\",\"b.md\"]" })
            )
            .unwrap()
            .args,
            Some(json!({ "docs": ["a.md", "b.md"] }))
        );
        // surrounding whitespace is trimmed before the `[` is seen
        assert_eq!(
            validate_arguments("docs_read_many", &s, &json!({ "docs": " [\"a.md\"] " }))
                .unwrap()
                .args,
            Some(json!({ "docs": ["a.md"] }))
        );
        // a JSON array that is not all strings: the parsed array is the fix
        let e = validate_arguments("docs_read_many", &s, &json!({ "docs": "[1, 2]" })).unwrap_err();
        assert_eq!(
            e.message,
            "`docs` must be an array of strings (docs_read_many takes docs, include_ids?, repo?)"
        );
        assert_eq!(e.data.unwrap()["fix"], r#"{"docs":[1,2]}"#);
        // a malformed `[`: the comma split is the fix
        let e = validate_arguments(
            "docs_read_many",
            &s,
            &json!({ "docs": "[\"a.md\", \"b.md\"", "include_ids": true }),
        )
        .unwrap_err();
        assert_eq!(
            e.data.unwrap()["fix"],
            r#"{"docs":["[\"a.md\"","\"b.md\""],"include_ids":true}"#
        );
        // a JSON object is not a list either
        let e = validate_arguments("docs_read_many", &s, &json!({ "docs": "[{}]" })).unwrap_err();
        assert_eq!(e.data.unwrap()["fix"], r#"{"docs":[{}]}"#);
        assert_eq!(json_array_string("a.md"), None);
        assert_eq!(
            json_array_string("[\"x\"]"),
            Some(JsonArrayString::List(vec!["x".to_owned()]))
        );
        assert_eq!(
            json_array_string("[x"),
            Some(JsonArrayString::Fix(vec![json!("[x")]))
        );
    }
}
