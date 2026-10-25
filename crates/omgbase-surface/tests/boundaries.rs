//! The surface's half of the modular-core dependency-direction check
//! (`docs/modular-core/README.md` §5, Phase 1; the data boundary, Phase 2):
//! the query path — `context.rs`, `translate.rs`, `planner.rs`, `query.rs`,
//! `select.rs` — reaches the store's history and semantic extensions only
//! through the capability traits (`omgbase_store::{HistoryRecorder,
//! SemanticProvider}` and the `Store` accessors), never by naming an
//! extension item, and no SQL of the surface names a vector table
//! (`embeddings`, `doc_embeddings`) or the `cosine` scalar. Textual, like the
//! store's `tests/boundaries.rs`: every `omgbase_store::<head>…` path of the
//! five files (comments and strings stripped) is checked against the names
//! the store's `lib.rs` re-exports from `history` and `semantic`; the
//! vector-name check runs over every file of `src/` with comments stripped
//! and strings kept. The surface's own `history.rs` and the catalog are the
//! concrete history tools and the dispatch — they may name the history
//! extension; they are not checked for paths.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn surface_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn store_lib() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates/")
        .join("omgbase-store/src/lib.rs")
}

/// `src` with comments and string/char literals blanked, newlines kept.
fn strip(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let blank = |out: &mut String, s: &str| {
        for c in s.chars() {
            out.push(if c == '\n' { '\n' } else { ' ' });
        }
    };
    while i < b.len() {
        let rest = &src[i..];
        if rest.starts_with("//") {
            let end = rest.find('\n').unwrap_or(rest.len());
            blank(&mut out, &rest[..end]);
            i += end;
        } else if rest.starts_with("/*") {
            let mut depth = 0usize;
            let mut j = 0;
            while j < rest.len() {
                if rest[j..].starts_with("/*") {
                    depth += 1;
                    j += 2;
                } else if rest[j..].starts_with("*/") {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            blank(&mut out, &rest[..j]);
            i += j;
        } else if b[i] == b'r' && (rest.starts_with("r\"") || rest.starts_with("r#")) {
            let hashes = rest[1..].bytes().take_while(|&x| x == b'#').count();
            if rest.as_bytes().get(1 + hashes) == Some(&b'"') {
                let close = format!("\"{}", "#".repeat(hashes));
                let body = 2 + hashes;
                let end = rest[body..]
                    .find(&close)
                    .map_or(rest.len(), |n| body + n + close.len());
                out.push(' ');
                blank(&mut out, &rest[1..end]);
                i += end;
            } else {
                out.push('r');
                i += 1;
            }
        } else if b[i] == b'"' {
            let rb = rest.as_bytes();
            let mut j = 1;
            while j < rb.len() {
                if rb[j] == b'\\' {
                    j += 2;
                } else if rb[j] == b'"' {
                    j += 1;
                    break;
                } else {
                    j += 1;
                }
            }
            let j = j.min(rest.len());
            blank(&mut out, &rest[..j]);
            i += j;
        } else if b[i] == b'\''
            && (rest.as_bytes().get(2) == Some(&b'\'') || rest.as_bytes().get(1) == Some(&b'\\'))
        {
            let end = rest[1..]
                .find('\'')
                .map_or(rest.len(), |n| n + 2)
                .min(rest.len());
            blank(&mut out, &rest[..end]);
            i += end;
        } else {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn head_of(member: &str) -> Option<String> {
    let h: String = member
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '*')
        .collect();
    (!h.is_empty()).then_some(h)
}

/// The heads of a `{ … }` group's members (nested groups give their prefix).
fn group_heads(s: &str) -> Vec<String> {
    let mut heads = Vec::new();
    let mut depth = 0usize;
    let mut member = String::new();
    for c in s.chars() {
        match c {
            '{' => {
                depth += 1;
                if depth > 1 {
                    member.push(c);
                }
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    heads.extend(head_of(&member));
                    break;
                }
                member.push(c);
            }
            ',' if depth == 1 => {
                heads.extend(head_of(&member));
                member.clear();
            }
            _ => member.push(c),
        }
    }
    heads
}

/// Every `(line, head)` after `prefix` (`omgbase_store::`) in stripped source.
fn path_heads(stripped: &str, prefix: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = stripped[from..].find(prefix) {
        let at = from + pos;
        from = at + prefix.len();
        if at > 0 {
            let prev = stripped.as_bytes()[at - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b':' {
                continue;
            }
        }
        let line = stripped[..at].matches('\n').count() + 1;
        let after = stripped[from..].trim_start();
        if after.starts_with('{') {
            out.extend(group_heads(after).into_iter().map(|h| (line, h)));
        } else if let Some(h) = head_of(after) {
            out.push((line, h));
        }
    }
    out
}

/// The store's root `pub use` statements as `(path segments, leaves)`.
fn store_reexports() -> Vec<(Vec<String>, Vec<String>)> {
    let lib = strip(&fs::read_to_string(store_lib()).expect("omgbase-store/src/lib.rs"));
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = lib[from..].find("pub use ") {
        let at = from + pos + "pub use ".len();
        let Some(end) = lib[at..].find(';') else {
            break;
        };
        let stmt = lib[at..at + end].trim();
        from = at + end + 1;
        let stmt = stmt.strip_prefix("self::").unwrap_or(stmt);
        let (prefix, leaves): (&str, Vec<String>) = match stmt.find('{') {
            Some(b) => (
                stmt[..b].trim_end_matches("::").trim(),
                stmt[b..]
                    .trim_start_matches('{')
                    .trim_end_matches('}')
                    .split(',')
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .map(|m| {
                        m.rsplit_once(" as ")
                            .map_or(m, |(_, a)| a.trim())
                            .rsplit("::")
                            .next()
                            .unwrap_or(m)
                            .trim()
                            .to_owned()
                    })
                    .collect(),
            ),
            None => {
                let (path, alias) = match stmt.rsplit_once(" as ") {
                    Some((p, a)) => (p.trim(), Some(a.trim().to_owned())),
                    None => (stmt, None),
                };
                let last = path.rsplit("::").next().unwrap_or_default().to_owned();
                (
                    path[..path.len() - last.len()].trim_end_matches("::"),
                    vec![alias.unwrap_or(last)],
                )
            }
        };
        out.push((
            prefix
                .split("::")
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            leaves,
        ));
    }
    out
}

/// Every `omgbase_store::<name>` that reaches the history or semantic
/// extension: the two module names, the modules the store's root re-exports
/// from them, and the items it re-exports from those modules.
fn extension_heads() -> BTreeSet<String> {
    let kinds = ["history", "semantic"];
    let reexports = store_reexports();
    let mut modules: BTreeSet<String> = kinds.iter().map(|k| (*k).to_owned()).collect();
    for (path, leaves) in &reexports {
        if path.len() == 1 && kinds.contains(&path[0].as_str()) {
            modules.extend(leaves.iter().cloned());
        }
    }
    let mut set = modules.clone();
    for (path, leaves) in &reexports {
        if path.first().is_some_and(|h| modules.contains(h)) {
            set.extend(leaves.iter().cloned());
        }
    }
    set
}

/// The files of the query path (the OQX binding and the runner).
const QUERY_PATH: [&str; 5] = [
    "context.rs",
    "translate.rs",
    "planner.rs",
    "query.rs",
    "select.rs",
];

/// `src` with comments blanked and string literals kept.
fn strip_comments_only(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let b = src.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let rest = &src[i..];
        if in_str {
            if rest.starts_with('\\') && i + 1 < b.len() {
                out.push_str(&rest[..2]);
                i += 2;
                continue;
            }
            if rest.starts_with('"') {
                in_str = false;
            }
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        } else if rest.starts_with("//") {
            let end = rest.find('\n').unwrap_or(rest.len());
            for _ in 0..end {
                out.push(' ');
            }
            i += end;
        } else if rest.starts_with("/*") {
            let end = rest.find("*/").map_or(rest.len(), |n| n + 2);
            for c in rest[..end].chars() {
                out.push(if c == '\n' { '\n' } else { ' ' });
            }
            i += end;
        } else {
            if rest.starts_with('"') {
                in_str = true;
            }
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// `(line, name)` of every whole-word `embeddings` / `doc_embeddings` and
/// every `cosine(` call in `src` (comments stripped, strings kept).
fn vector_mentions(src: &str) -> Vec<(usize, &'static str)> {
    let text = strip_comments_only(src);
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        for name in ["embeddings", "doc_embeddings", "cosine("] {
            let mut from = 0;
            while let Some(pos) = line[from..].find(name) {
                let at = from + pos;
                from = at + name.len();
                let word_before = line[..at].bytes().last().is_some_and(is_ident_byte);
                let word_after = line[at + name.len()..]
                    .bytes()
                    .next()
                    .is_some_and(is_ident_byte);
                if name == "cosine(" {
                    if !word_before {
                        out.push((n + 1, name));
                    }
                } else if !word_before && !word_after {
                    out.push((n + 1, name));
                }
            }
        }
    }
    out
}

#[test]
fn no_sql_of_the_surface_names_a_vector_table_or_the_cosine_scalar() {
    let src = surface_src();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).expect("src/").flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "rs") {
                files.push(p);
            }
        }
    }
    files.sort();
    assert!(files.len() > 10, "the surface's sources were not found");
    let mut lines = Vec::new();
    for f in &files {
        let text = fs::read_to_string(f).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        for (line, name) in vector_mentions(&text) {
            lines.push(format!(
                "{}:{line} {name}",
                f.strip_prefix(&src).unwrap_or(f).to_string_lossy()
            ));
        }
    }
    assert!(
        lines.is_empty(),
        "the surface touches the semantic bundle's data; reach a vector through `Store::semantic()`:\n  {}",
        lines.join("\n  ")
    );
    assert_eq!(
        vector_mentions(
            "let s = \"SELECT vec FROM doc_embeddings\"; // embeddings\ncosine_bytes(a, b)"
        ),
        [(1, "doc_embeddings")]
    );
}

#[test]
fn the_query_binding_reaches_the_extensions_only_through_the_capabilities() {
    let forbidden = extension_heads();
    assert!(
        forbidden.contains("block_vector") && forbidden.contains("TreeResolver"),
        "the store's lib.rs re-exports were not read: {forbidden:?}"
    );
    assert!(
        !forbidden.contains("SemanticProvider") && !forbidden.contains("read"),
        "the capability traits and the core are not extension names"
    );
    let mut lines = Vec::new();
    for file in QUERY_PATH {
        let path = surface_src().join(file);
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        for (line, head) in path_heads(&strip(&text), "omgbase_store::") {
            if forbidden.contains(&head) {
                lines.push(format!("{file}:{line} omgbase_store::{head}"));
            }
        }
    }
    assert!(
        lines.is_empty(),
        "the query binding names history/semantic items of the store (forbidden: {forbidden:?}); \
         reach them through `Store::history()` / `Store::semantic()` and the traits:\n  {}",
        lines.join("\n  ")
    );
}

#[test]
fn the_stripper_and_the_path_scanner_agree_on_a_sample() {
    let s = strip(
        "let v = omgbase_store::read::reconstruct(c); // omgbase_store::tree\nlet h = omgbase_store::tree::from_hex(\"omgbase_store::search\");",
    );
    let heads: Vec<String> = path_heads(&s, "omgbase_store::")
        .into_iter()
        .map(|(_, h)| h)
        .collect();
    assert_eq!(heads, ["read", "tree"]);
    let grouped = strip("use omgbase_store::{Store, is_id_ref, delta::TreeResolver};");
    let heads: Vec<String> = path_heads(&grouped, "omgbase_store::")
        .into_iter()
        .map(|(_, h)| h)
        .collect();
    assert_eq!(heads, ["Store", "is_id_ref", "delta"]);
}
