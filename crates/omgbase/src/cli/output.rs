//! The output contract (`spec/cli` §3): stdout is data, stderr is everything
//! else; the exit codes 0 / 1 / 2; the two error renderings (`usage: …` and
//! `error[<code>]: …` with the pretty payload, or the machine-mode JSON
//! object on stderr); JSON printed exactly as `JSON.stringify` prints it;
//! the truncation footer; the query hit table (§4).

use std::io::{IsTerminal, Write};

use omgbase_surface::SurfaceError;
use serde_json::Value as Json;

use super::render::{Style, columns, visible_width};

pub const EXIT_OK: i32 = 0;
pub const EXIT_ERROR: i32 = 1;
pub const EXIT_USAGE: i32 = 2;

/// Every failure a verb reports.
#[derive(Clone, Debug, PartialEq)]
pub enum CliError {
    /// A CLI-level mistake → `usage: <message>`, exit 2.
    Usage {
        message: String,
        hint: Option<String>,
    },
    /// An engine's typed error (or anything else) → `error[<code>]:
    /// <message>` with its payload, exit 1.
    Engine {
        code: String,
        message: String,
        hint: Option<String>,
        data: Option<Json>,
    },
}

impl CliError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self::Usage {
            message: message.into(),
            hint: None,
        }
    }
    pub fn usage_hint(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::Usage {
            message: message.into(),
            hint: Some(hint.into()),
        }
    }
    pub fn engine(code: &str, message: impl Into<String>) -> Self {
        Self::Engine {
            code: code.to_owned(),
            message: message.into(),
            hint: None,
            data: None,
        }
    }
    pub fn engine_hint(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::Engine {
            code: code.to_owned(),
            message: message.into(),
            hint: Some(hint.into()),
            data: None,
        }
    }
    pub fn engine_data(code: &str, message: impl Into<String>, data: Json) -> Self {
        Self::Engine {
            code: code.to_owned(),
            message: message.into(),
            hint: None,
            data: Some(data),
        }
    }
    pub fn message(&self) -> &str {
        match self {
            Self::Usage { message, .. } | Self::Engine { message, .. } => message,
        }
    }
}

impl From<SurfaceError> for CliError {
    fn from(e: SurfaceError) -> Self {
        Self::Engine {
            code: e.code,
            message: e.message,
            hint: None,
            data: e.data,
        }
    }
}

impl From<omgbase_sync::Error> for CliError {
    fn from(e: omgbase_sync::Error) -> Self {
        Self::from(SurfaceError::from(e))
    }
}

impl From<omgbase_store::Error> for CliError {
    fn from(e: omgbase_store::Error) -> Self {
        Self::from(SurfaceError::from(e))
    }
}

impl From<rusqlite::Error> for CliError {
    fn from(e: rusqlite::Error) -> Self {
        Self::from(SurfaceError::from(e))
    }
}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        Self::engine("error", e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, CliError>;

// ---- IO -----------------------------------------------------------------------------------

/// stdout is data; stderr is everything else (§3.1). Every line ends in
/// `\n`. A closed pipe downstream is not an error (`omg … | head`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Io;

impl Io {
    pub fn out(&self, s: &str) {
        let mut h = std::io::stdout().lock();
        let _ = h.write_all(s.as_bytes());
        if !s.ends_with('\n') {
            let _ = h.write_all(b"\n");
        }
        let _ = h.flush();
    }
    pub fn err(&self, s: &str) {
        let mut h = std::io::stderr().lock();
        let _ = h.write_all(s.as_bytes());
        if !s.ends_with('\n') {
            let _ = h.write_all(b"\n");
        }
        let _ = h.flush();
    }
    pub fn stdout_tty(&self) -> bool {
        std::io::stdout().is_terminal()
    }
    pub fn stdin_tty(&self) -> bool {
        std::io::stdin().is_terminal()
    }
}

// ---- JSON as JavaScript prints it ---------------------------------------------------------

/// `JSON.stringify(s)`: the string escaping is `serde_json`'s (the same set
/// of escapes — `"`, `\`, the C0 controls with their short forms).
pub fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())
}

/// A number as `String(n)` prints it: integral doubles without a fraction,
/// exponents past 1e21 / under 1e-6 in JavaScript's spelling.
fn js_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if !f.is_finite() {
        return "null".to_owned();
    }
    if f == 0.0 {
        return "0".to_owned();
    }
    let abs = f.abs();
    if !(1e-6..1e21).contains(&abs) {
        // `1.5e21` → `1.5e+21`; `1e-7` stays.
        let s = format!("{f:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    if f.fract() == 0.0 {
        return format!("{f:.0}");
    }
    // Rust's shortest round-trip repr equals JavaScript's in this range.
    f.to_string()
}

fn write_compact(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(n) => out.push_str(&js_number(n)),
        Json::String(s) => out.push_str(&js_string(s)),
        Json::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_compact(x, out);
            }
            out.push(']');
        }
        Json::Object(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&js_string(k));
                out.push(':');
                write_compact(x, out);
            }
            out.push('}');
        }
    }
}

fn write_pretty(v: &Json, out: &mut String, depth: usize) {
    let pad = |d: usize| "  ".repeat(d);
    match v {
        Json::Array(a) if !a.is_empty() => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&pad(depth + 1));
                write_pretty(x, out, depth + 1);
            }
            out.push('\n');
            out.push_str(&pad(depth));
            out.push(']');
        }
        Json::Object(m) if !m.is_empty() => {
            out.push_str("{\n");
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&pad(depth + 1));
                out.push_str(&js_string(k));
                out.push_str(": ");
                write_pretty(x, out, depth + 1);
            }
            out.push('\n');
            out.push_str(&pad(depth));
            out.push('}');
        }
        other => write_compact(other, out),
    }
}

/// `JSON.stringify(v)`.
pub fn js_json(v: &Json) -> String {
    let mut s = String::new();
    write_compact(v, &mut s);
    s
}

/// `JSON.stringify(v, null, 2)`.
pub fn js_json_pretty(v: &Json) -> String {
    let mut s = String::new();
    write_pretty(v, &mut s, 0);
    s
}

// ---- errors (§3.5) ------------------------------------------------------------------------

/// Render `err` to stderr and return the exit code. `machine` selects the
/// JSON object (`hint` kept, §9 Fixed); else the human form with the
/// payload pretty-printed under the message (an empty payload prints
/// nothing, §9 Fixed).
pub fn render_error(err: &CliError, io: Io, style: &Style, machine: bool) -> i32 {
    match err {
        CliError::Usage { message, hint } => {
            if machine {
                let mut m = serde_json::Map::new();
                m.insert("error".into(), Json::String("usage".into()));
                m.insert("message".into(), Json::String(message.clone()));
                if let Some(h) = hint {
                    m.insert("hint".into(), Json::String(h.clone()));
                }
                m.insert("retriable".into(), Json::Bool(false));
                io.err(&js_json(&Json::Object(m)));
            } else {
                io.err(&format!("{}: {message}", style.err("usage")));
                if let Some(h) = hint {
                    io.err(&style.dim(&format!("  hint: {h}")));
                }
            }
            EXIT_USAGE
        }
        CliError::Engine {
            code,
            message,
            hint,
            data,
        } => {
            if machine {
                let mut m = serde_json::Map::new();
                m.insert("error".into(), Json::String(code.clone()));
                m.insert("message".into(), Json::String(message.clone()));
                if let Some(h) = hint {
                    m.insert("hint".into(), Json::String(h.clone()));
                }
                if let Some(d) = data {
                    m.insert("data".into(), d.clone());
                }
                m.insert("retriable".into(), Json::Bool(false));
                io.err(&js_json(&Json::Object(m)));
                return EXIT_ERROR;
            }
            io.err(&format!(
                "{}: {message}",
                style.err(&format!("error[{code}]"))
            ));
            if let Some(h) = hint {
                io.err(&style.dim(&format!("  hint: {h}")));
            }
            if let Some(d) = data {
                let empty = d.is_null()
                    || d.as_object().is_some_and(|m| m.is_empty())
                    || d.as_array().is_some_and(|a| a.is_empty());
                if !empty {
                    let text = js_json_pretty(d)
                        .split('\n')
                        .map(|l| format!("  {l}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    io.err(&style.dim(&text));
                }
            }
            EXIT_ERROR
        }
    }
}

/// §3.4: the footer, on stderr, exit 0.
pub fn truncation_footer(io: Io, style: &Style, cursor: &str) {
    io.err(&style.dim(&format!("… truncated; continue with --cursor {cursor}")));
}

// ---- the query hit table (§4) -------------------------------------------------------------

pub const HIT_CELL_MAX: usize = 60;

/// Clip to `max` visible characters, the last one `…`.
pub fn truncate_cell(s: &str, max: usize) -> String {
    if visible_width(s) <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// One projected value as a cell: strings verbatim to their first newline
/// (`…` marks a cut), numbers and booleans as JavaScript prints them,
/// null/absent empty, lists and records as compact JSON; clipped.
pub fn hit_cell(v: Option<&Json>) -> String {
    match v {
        None | Some(Json::Null) => String::new(),
        Some(Json::String(s)) => match s.find('\n') {
            None => truncate_cell(s, HIT_CELL_MAX),
            Some(nl) => truncate_cell(&format!("{}…", &s[..nl]), HIT_CELL_MAX),
        },
        Some(Json::Bool(b)) => b.to_string(),
        Some(Json::Number(n)) => js_number(n),
        Some(other) => truncate_cell(&js_json(other), HIT_CELL_MAX),
    }
}

/// The projected keys: `projected` (the query's `select` names, in order),
/// then every other key of `hits` but `id`/`path`, first-seen order.
pub fn hit_columns(hits: &[Json], projected: &[String]) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    for k in projected {
        if k != "id" && k != "path" && !cols.iter().any(|c| c == k) {
            cols.push(k.clone());
        }
    }
    for h in hits {
        if let Some(m) = h.as_object() {
            for k in m.keys() {
                if k != "id" && k != "path" && !cols.iter().any(|c| c == k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    cols
}

/// Human-tier hit list: `<id>  <path>` lines, or an aligned table when projected.
pub fn render_hits(io: Io, style: &Style, hits: &[Json], projected: &[String]) {
    let str_of = |h: &Json, k: &str| -> String {
        h.get(k)
            .and_then(Json::as_str)
            .map(str::to_owned)
            .unwrap_or_default()
    };
    let projected = hit_columns(hits, projected);
    if projected.is_empty() {
        for h in hits {
            let line = format!(
                "{}  {}",
                style.id(&str_of(h, "id")),
                style.accent(&str_of(h, "path"))
            );
            io.out(line.trim_end());
        }
        return;
    }
    let mut cols: Vec<String> = vec!["id".to_owned()];
    if !projected.iter().any(|c| c == "$path") {
        cols.push("path".to_owned());
    }
    cols.extend(projected);
    let mut rows: Vec<Vec<String>> = vec![cols.iter().map(|c| style.dim(c)).collect()];
    for h in hits {
        rows.push(
            cols.iter()
                .map(|c| match c.as_str() {
                    "id" => style.id(&str_of(h, "id")),
                    "path" => style.accent(&str_of(h, "path")),
                    "$path" if h.get("$path").is_some_and(Json::is_string) => {
                        style.accent(&str_of(h, "$path"))
                    }
                    other => hit_cell(h.get(other)),
                })
                .collect(),
        );
    }
    for line in columns(&rows, &[]) {
        io.out(&line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_like_javascript() {
        let v = json!({ "a": 1.0, "b": 0.016129032258064516, "c": [], "d": {}, "e": "x\ny", "f": 1677, "g": true, "h": null });
        assert_eq!(
            js_json(&v),
            r#"{"a":1,"b":0.016129032258064516,"c":[],"d":{},"e":"x\ny","f":1677,"g":true,"h":null}"#
        );
        assert_eq!(js_json(&json!(1.5e21)), "1.5e+21");
        assert_eq!(js_json(&json!(1e-7)), "1e-7");
        assert_eq!(js_json(&json!(-2.5)), "-2.5");
        assert_eq!(
            js_json_pretty(&json!({ "candidates": ["fixture"], "e": {} })),
            "{\n  \"candidates\": [\n    \"fixture\"\n  ],\n  \"e\": {}\n}"
        );
    }

    #[test]
    fn cells() {
        assert_eq!(hit_cell(Some(&json!("a\nb"))), "a…");
        assert_eq!(hit_cell(Some(&json!(false))), "false");
        assert_eq!(hit_cell(Some(&json!([1, 2]))), "[1,2]");
        assert_eq!(hit_cell(None), "");
        let long = "x".repeat(70);
        let c = hit_cell(Some(&json!(long)));
        assert_eq!(c.chars().count(), 60);
        assert!(c.ends_with('…'));
        assert_eq!(
            hit_columns(
                &[
                    json!({ "id": "a", "path": "p", "x": 1 }),
                    json!({ "id": "b", "y": 2 })
                ],
                &[]
            ),
            vec!["x", "y"]
        );
        assert_eq!(
            hit_columns(
                &[json!({ "id": "a", "path": "p", "x": 1 })],
                &["x".into(), "nope".into()]
            ),
            vec!["x", "nope"]
        );
    }
}
