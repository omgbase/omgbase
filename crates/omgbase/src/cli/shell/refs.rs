//! Session references (`spec/cli` §7). The shell stores typed command
//! results and dereferences them; it does NOT filter/map/traverse — that
//! stays OQX's job.
//!
//! Three reference roots, all written with `@` (OQX already owns `$…`):
//!   `@N`     row N (1-based) of the most recent displayed collection frame
//!   `@_`     the previous command's typed result
//!   `@name`  a named binding (`@name = …`)
//! Each may carry a shallow tail: an optional `[i]` (1-based collection
//! index) then an optional `.field`. That is the whole grammar — deeper
//! access is a signal to use OQX instead.

use serde_json::Value as Json;

use crate::cli::output::js_json;

/// A reference error (a usage error for that line).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefError(pub String);

impl std::fmt::Display for RefError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A selectable item within a displayed collection or a bound collection.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// The argv string this row substitutes to (an id, locator, path, or scalar).
    pub r#ref: String,
    /// Human label for `bindings` / frame listings.
    pub label: String,
    /// The underlying typed value (for `.field` access).
    pub value: Json,
}

/// A captured command result: the whole typed value plus any selectable rows.
#[derive(Clone, Debug, PartialEq)]
pub struct Captured {
    pub value: Json,
    /// `Some` ⇒ this result is a selectable collection (replaces the frame).
    pub rows: Option<Vec<Row>>,
}

impl Captured {
    pub fn of(value: Json) -> Self {
        let rows = derive_rows(&value);
        Self { value, rows }
    }
}

/// A parsed whole-token reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedRef {
    /// `"1"`, `"_"`, or a name.
    pub base: String,
    /// 1-based, if `[i]` present.
    pub index: Option<usize>,
    pub field: Option<String>,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// A binding name: `[A-Za-z][\w-]*`.
pub fn is_name(s: &str) -> bool {
    let mut it = s.chars();
    it.next().is_some_and(|c| c.is_ascii_alphabetic()) && it.all(|c| is_word(c) || c == '-')
}

fn bad(token: &str) -> RefError {
    RefError(format!(
        "bad reference '{token}' (use @N, @_, @name, optional [i] and .field)"
    ))
}

/// Parse a whole-token reference; `None` if the token isn't a reference
/// (does not start with `@`); an error for a malformed `@…`. The grammar is
/// `^@(\d+|_|[A-Za-z][\w-]*)(?:\[(\d+)\])?(?:\.([A-Za-z_]\w*))?$`.
pub fn parse_ref(token: &str) -> Result<Option<ParsedRef>, RefError> {
    let Some(body) = token.strip_prefix('@') else {
        return Ok(None);
    };
    let chars: Vec<char> = body.chars().collect();
    let n = chars.len();
    let mut i = 0;
    // base
    let base: String = if i < n && chars[i].is_ascii_digit() {
        while i < n && chars[i].is_ascii_digit() {
            i += 1;
        }
        chars[..i].iter().collect()
    } else if i < n && chars[i] == '_' {
        i += 1;
        "_".to_owned()
    } else if i < n && chars[i].is_ascii_alphabetic() {
        i += 1;
        while i < n && (is_word(chars[i]) || chars[i] == '-') {
            i += 1;
        }
        chars[..i].iter().collect()
    } else {
        return Err(bad(token));
    };
    // [i]
    let mut index = None;
    if i < n && chars[i] == '[' {
        let start = i + 1;
        let mut j = start;
        while j < n && chars[j].is_ascii_digit() {
            j += 1;
        }
        if j == start || j >= n || chars[j] != ']' {
            return Err(bad(token));
        }
        let digits: String = chars[start..j].iter().collect();
        index = Some(digits.parse::<usize>().unwrap_or(usize::MAX));
        i = j + 1;
    }
    // .field
    let mut field = None;
    if i < n && chars[i] == '.' {
        let start = i + 1;
        if start >= n || !(chars[start].is_ascii_alphabetic() || chars[start] == '_') {
            return Err(bad(token));
        }
        let mut j = start + 1;
        while j < n && is_word(chars[j]) {
            j += 1;
        }
        field = Some(chars[start..j].iter().collect());
        i = j;
    }
    if i != n {
        return Err(bad(token));
    }
    Ok(Some(ParsedRef { base, index, field }))
}

/// Derive the selectable rows of a captured value. `None` when the value is
/// a card / scalar / text (no collection) — the caller then leaves the
/// numbered frame intact. `Some` (possibly empty) when the value IS a
/// collection.
pub fn derive_rows(value: &Json) -> Option<Vec<Row>> {
    if let Some(a) = value.as_array() {
        return Some(a.iter().map(row_of).collect());
    }
    let o = value.as_object()?;
    if let Some(hits) = o.get("hits").and_then(Json::as_array) {
        return Some(hits.iter().map(row_of).collect()); // query/run
    }
    if let Some(digests) = o.get("digests").and_then(Json::as_array) {
        return Some(digests.iter().map(row_of).collect()); // log
    }
    if let (Some(results), Some(_)) = (
        o.get("results").and_then(Json::as_array),
        o.get("revisions").and_then(Json::as_array),
    ) {
        // ApplyResult: the minted/affected ids, flattened (one row per id).
        let mut rows = Vec::new();
        for r in results {
            if let Some(ids) = r.get("ids").and_then(Json::as_array) {
                for id in ids.iter().filter_map(Json::as_str) {
                    rows.push(Row {
                        r#ref: id.to_owned(),
                        label: id.to_owned(),
                        value: Json::String(id.to_owned()),
                    });
                }
            }
        }
        return Some(rows);
    }
    let out = o.get("out").and_then(Json::as_array);
    let inbound = o.get("in").and_then(Json::as_array);
    if out.is_some() || inbound.is_some() {
        // links: both directions, each edge's far node is the selectable ref.
        let edges = out
            .into_iter()
            .flatten()
            .chain(inbound.into_iter().flatten());
        return Some(edges.map(row_of).collect());
    }
    None
}

/// `String(x)` for a scalar as JavaScript prints it.
fn scalar_string(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        other => js_json(other),
    }
}

fn row_of(el: &Json) -> Row {
    if let Some(s) = el.as_str() {
        return Row {
            r#ref: s.to_owned(),
            label: s.to_owned(),
            value: el.clone(),
        };
    }
    if let Some(o) = el.as_object() {
        let r#ref = first_string(o, &["id", "node", "block", "locator", "path"]);
        let label = first_string(o, &["path", "locator", "name", "id", "node"])
            .or_else(|| r#ref.clone())
            .unwrap_or_else(|| preview(el));
        return Row {
            r#ref: r#ref.unwrap_or_else(|| label.clone()),
            label,
            value: el.clone(),
        };
    }
    let s = scalar_string(el);
    Row {
        r#ref: s.clone(),
        label: s,
        value: el.clone(),
    }
}

fn first_string(o: &serde_json::Map<String, Json>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| o.get(*k).and_then(Json::as_str).map(str::to_owned))
}

fn preview(v: &Json) -> String {
    let s = js_json(v);
    if s.chars().count() > 60 {
        let mut out: String = s.chars().take(57).collect();
        out.push('…');
        out
    } else {
        s
    }
}

/// Coerce a resolved value to a single argv string. Entities collapse to
/// their id/locator; scalars stringify; a bare collection is an error (the
/// caller must pick a row with `[i]`) — the shell never flattens a
/// collection into one arg.
pub fn coerce(value: &Json) -> Result<String, RefError> {
    match value {
        Json::String(s) => Ok(s.clone()),
        Json::Number(_) | Json::Bool(_) => Ok(scalar_string(value)),
        Json::Null => Err(RefError("reference is empty".to_owned())),
        Json::Array(a) => Err(RefError(format!(
            "reference is a collection of {}; select one with [i]",
            a.len()
        ))),
        Json::Object(o) => {
            if let Some(r) = first_string(o, &["id", "node", "block", "locator", "path"]) {
                return Ok(r);
            }
            // A collection-shaped result object (e.g. {hits:[…]}) can't be one arg.
            if derive_rows(value).is_some() {
                return Err(RefError(
                    "reference is a collection; select one with [i]".to_owned(),
                ));
            }
            Err(RefError(
                "reference has no id/locator to use as an argument".to_owned(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(t: &str) -> ParsedRef {
        parse_ref(t).unwrap().unwrap()
    }

    #[test]
    fn parses() {
        assert_eq!(parse_ref("ls").unwrap(), None);
        assert_eq!(
            p("@1"),
            ParsedRef {
                base: "1".into(),
                index: None,
                field: None
            }
        );
        assert_eq!(p("@_").base, "_");
        assert_eq!(p("@t[2].path").index, Some(2));
        assert_eq!(p("@t[2].path").field.as_deref(), Some("path"));
        assert_eq!(p("@my-name_2").base, "my-name_2");
        assert_eq!(p("@_.kind").field.as_deref(), Some("kind"));
        for bad in [
            "@",
            "@9x",
            "@t..",
            "@t[x]",
            "@t[]",
            "@t[1",
            "@t.",
            "@t.1",
            "@_x",
            "@t[1].a.b",
        ] {
            let e = parse_ref(bad).unwrap_err();
            assert_eq!(
                e.0,
                format!("bad reference '{bad}' (use @N, @_, @name, optional [i] and .field)")
            );
        }
        assert!(is_name("t") && is_name("a-b_c1") && !is_name("9x") && !is_name("_"));
    }

    #[test]
    fn rows_and_coercion() {
        let hits = json!({ "hits": [{ "id": "d_1", "path": "a.md" }, { "id": "d_2" }] });
        let rows = derive_rows(&hits).unwrap();
        assert_eq!(rows[0].r#ref, "d_1");
        assert_eq!(rows[0].label, "a.md");
        assert_eq!(rows[1].label, "d_2");
        assert_eq!(
            coerce(&hits).unwrap_err().0,
            "reference is a collection; select one with [i]"
        );
        assert_eq!(
            coerce(&json!([1, 2, 3])).unwrap_err().0,
            "reference is a collection of 3; select one with [i]"
        );
        assert_eq!(coerce(&json!(13)).unwrap(), "13");
        assert_eq!(coerce(&json!(true)).unwrap(), "true");
        assert_eq!(coerce(&json!({ "node": "d_3" })).unwrap(), "d_3");
        assert!(derive_rows(&json!({ "kind": "document" })).is_none());
        assert!(derive_rows(&json!("text")).is_none());
        let apply = json!({ "results": [{ "ids": ["b_1", "b_2"] }], "revisions": [] });
        assert_eq!(derive_rows(&apply).unwrap().len(), 2);
        let links = json!({ "out": [{ "node": "d_1" }], "in": [{ "node": "d_0" }] });
        let rows = derive_rows(&links).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.r#ref.as_str()).collect::<Vec<_>>(),
            ["d_1", "d_0"]
        );
        assert_eq!(derive_rows(&json!({ "out": [] })).unwrap().len(), 0);
    }
}
