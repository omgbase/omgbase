//! The dependency-direction check of the modular-core program (Phase 1,
//! `docs/modular-core/README.md` §5 "Dependency-direction check"): the
//! current-state core of this crate (`src/core/**`) names no item of the
//! history or semantic extensions. A textual check over the sources — every
//! `crate::<head>…` path (plain or in a `use crate::{…}` group) after comments
//! and string literals are stripped — against every name `lib.rs` lets a
//! `crate::` path reach the extensions by: the two directory names, the
//! modules re-exported from them and the items re-exported from those. What
//! Phase 3 still has to remove is listed in `boundary-allowlist.txt` next to
//! `Cargo.toml`, one `<core file> <head>` pair per line with the inventory
//! row it cites; an entry that no longer matches fails the test too, so the
//! allowlist can only shrink.
//!
//! Phase 2 adds the data boundary: no SQL under `src/core/` names a vector
//! table (`embeddings`, `doc_embeddings`) or the `cosine` scalar — every
//! vector read or write goes through `SemanticProvider` — checked over the
//! comment-stripped source *with its string literals kept*, since SQL is a
//! string. `core/size.rs` is the one exception: its category map names every
//! table of the database for the byte accountant (it reads `dbstat`, never a
//! row), and its advice takes the bundle's tables from the provider.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Every `.rs` file under `dir`, recursively, sorted.
fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(rust_files(&p));
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// `src` with every comment and string literal blanked (newlines kept, so
/// line numbers survive): `//` to end of line, `/* … */` (nested), `"…"`
/// with escapes, raw strings `r#"…"#`, char literals (a lifetime is left).
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
        let c = b[i];
        let rest = &src[i..];
        if rest.starts_with("//") {
            let end = rest.find('\n').map_or(rest.len(), |n| n);
            blank(&mut out, &rest[..end]);
            i += end;
        } else if rest.starts_with("/*") {
            let mut depth = 0usize;
            let mut j = 0;
            let rb = rest.as_bytes();
            while j < rb.len() {
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
        } else if c == b'r' && (rest.starts_with("r\"") || rest.starts_with("r#")) {
            // A raw string: `r` + n `#` + `"` … `"` + n `#`.
            let hashes = rest[1..].bytes().take_while(|&x| x == b'#').count();
            if rest.as_bytes().get(1 + hashes) == Some(&b'"') {
                let close = format!("\"{}", "#".repeat(hashes));
                let body_start = 2 + hashes;
                let end = rest[body_start..]
                    .find(&close)
                    .map_or(rest.len(), |n| body_start + n + close.len());
                out.push(' ');
                blank(&mut out, &rest[1..end]);
                i += end;
            } else {
                out.push('r');
                i += 1;
            }
        } else if c == b'"' {
            let mut j = 1;
            let rb = rest.as_bytes();
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
            blank(&mut out, &rest[..j.min(rest.len())]);
            i += j.min(rest.len());
        } else if c == b'\''
            && (rest.as_bytes().get(2) == Some(&b'\'') || (rest.as_bytes().get(1) == Some(&b'\\')))
        {
            // A char literal (`'x'`, `'\n'`, `'\u{…}'`); a lifetime has no closing quote.
            let end = rest[1..].find('\'').map_or(rest.len(), |n| n + 2);
            blank(&mut out, &rest[..end.min(rest.len())]);
            i += end.min(rest.len());
        } else {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// The first segments of every member of a `{ … }` use-group starting at
/// `s` (which begins with `{`); nested groups contribute their prefix's head.
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
                    heads.extend(member_head(&member));
                    break;
                }
                member.push(c);
            }
            ',' if depth == 1 => {
                heads.extend(member_head(&member));
                member.clear();
            }
            _ => member.push(c),
        }
    }
    heads
}

fn member_head(member: &str) -> Option<String> {
    let m = member.trim();
    if m.is_empty() {
        return None;
    }
    let head: String = m
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '*')
        .collect();
    (!head.is_empty()).then_some(head)
}

/// Every `(line, head)` of a `crate::<head>` path in stripped source.
fn crate_heads(stripped: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let b = stripped.as_bytes();
    let mut from = 0;
    while let Some(pos) = stripped[from..].find("crate::") {
        let at = from + pos;
        from = at + "crate::".len();
        if at > 0 && is_ident(b[at - 1]) {
            continue; // `my_crate::`
        }
        let line = stripped[..at].matches('\n').count() + 1;
        let after = &stripped[from..];
        let after_trim = after.trim_start();
        if after_trim.starts_with('{') {
            for h in group_heads(after_trim) {
                out.push((line, h));
            }
        } else if let Some(h) = member_head(after_trim) {
            out.push((line, h));
        }
    }
    out
}

struct Violation {
    file: String,
    line: usize,
    head: String,
}

/// Every `crate::<forbidden>` reference in `files` (paths shown relative to
/// `src/`).
fn violations(files: &[PathBuf], forbidden: &BTreeSet<String>) -> Vec<Violation> {
    let src = src_dir();
    let mut out = Vec::new();
    for f in files {
        let text = fs::read_to_string(f).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let rel = f
            .strip_prefix(&src)
            .unwrap_or(f)
            .to_string_lossy()
            .replace('\\', "/");
        for (line, head) in crate_heads(&strip(&text)) {
            if head == "*" || forbidden.contains(&head) {
                out.push(Violation {
                    file: rel.clone(),
                    line,
                    head,
                });
            }
        }
    }
    out
}

/// `boundary-allowlist.txt`: `(file, head)` pairs, comments and blanks skipped.
fn allowlist() -> Vec<(String, String, String)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("boundary-allowlist.txt");
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let mut it = l.splitn(3, char::is_whitespace);
            let file = it.next().unwrap_or_default().to_owned();
            let head = it.next().unwrap_or_default().to_owned();
            let why = it.next().unwrap_or_default().trim().to_owned();
            assert!(
                !why.is_empty(),
                "boundary-allowlist.txt: `{l}` cites no inventory row"
            );
            (file, head, why)
        })
        .collect()
}

/// Every `pub use …;` statement of `lib.rs` (comments stripped) as `(path
/// without a leading `self::`, leaves)`: a plain path has one leaf (its last
/// segment, or the alias after `as`); a `{ … }` group has one leaf per member.
fn root_reexports() -> Vec<(Vec<String>, Vec<String>)> {
    let lib = strip(&fs::read_to_string(src_dir().join("lib.rs")).expect("lib.rs"));
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
        let (prefix, leaves) = match stmt.find('{') {
            Some(b) => {
                let prefix = stmt[..b].trim_end_matches("::").trim();
                let group = &stmt[b..];
                let leaves = group
                    .trim_start_matches('{')
                    .trim_end_matches('}')
                    .split(',')
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .map(|m| {
                        m.rsplit_once(" as ")
                            .map_or(m, |(_, alias)| alias.trim())
                            .rsplit("::")
                            .next()
                            .unwrap_or(m)
                            .trim()
                            .to_owned()
                    })
                    .collect();
                (prefix, leaves)
            }
            None => {
                let (path, alias) = match stmt.rsplit_once(" as ") {
                    Some((p, a)) => (p.trim(), Some(a.trim().to_owned())),
                    None => (stmt, None),
                };
                let mut segs: Vec<&str> = path.split("::").collect();
                let last = segs.pop().unwrap_or_default().to_owned();
                (
                    path[..path.len() - last.len()].trim_end_matches("::"),
                    vec![alias.unwrap_or(last)],
                )
            }
        };
        let path: Vec<String> = prefix
            .split("::")
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        out.push((path, leaves));
    }
    out
}

/// Every name a `crate::<name>` path may begin with that reaches one of
/// `kinds` (`history`, `semantic`): the directory names, the modules
/// `lib.rs` re-exports from them (`pub use self::history::{archive, …}`),
/// and every item `lib.rs` re-exports from such a module (`pub use
/// delta::{TreeResolver, …}`, `pub use history::Recorder`). A name that
/// `lib.rs` re-exports from the core — `read`, `writers`, `RevisionRead` —
/// is the core's whatever else carries the same stem: `crate::<name>`
/// resolves through `lib.rs`, so this is exactly what a core file can reach.
fn forbidden_heads(kinds: &[&str]) -> BTreeSet<String> {
    let reexports = root_reexports();
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

#[test]
fn the_root_reexport_parser_reads_lib_rs() {
    let reexports = root_reexports();
    assert!(
        reexports
            .iter()
            .any(|(p, l)| p == &["history".to_owned()] && l.iter().any(|x| x == "archive")),
        "lib.rs re-exports the history modules: {reexports:?}"
    );
    let core = forbidden_heads(&["history", "semantic"]);
    for core_name in [
        "read",
        "writers",
        "RevisionRead",
        "GcResult",
        "ChangesPage",
        "Store",
    ] {
        assert!(!core.contains(core_name), "{core_name} is the core's");
    }
    for name in [
        "history",
        "semantic",
        "archive",
        "delta",
        "tree",
        "search",
        "retention",
        "gc",
        "edit_script",
        "TreeResolver",
        "Recorder",
        "Provider",
        "block_vector",
        "NewRevision",
        "ARCHIVED_COMMITS_SQL",
    ] {
        assert!(core.contains(name), "{name} reaches an extension");
    }
}

#[test]
fn the_core_names_no_history_or_semantic_item() {
    let src = src_dir();
    let core = rust_files(&src.join("core"));
    assert!(
        !core.is_empty(),
        "src/core/ is empty — the current-state core must live there"
    );
    let forbidden = forbidden_heads(&["history", "semantic"]);
    for name in ["history", "semantic"] {
        assert!(
            src.join(name).is_dir(),
            "src/{name}/ is missing — the {name} extension must live there"
        );
    }
    let found = violations(&core, &forbidden);
    let allow = allowlist();
    let mut unexpected: Vec<String> = Vec::new();
    let mut used: BTreeSet<(String, String)> = BTreeSet::new();
    for v in &found {
        match allow.iter().find(|(f, h, _)| *f == v.file && *h == v.head) {
            Some((f, h, _)) => {
                used.insert((f.clone(), h.clone()));
            }
            None => unexpected.push(format!("{}:{} crate::{}", v.file, v.line, v.head)),
        }
    }
    let stale: Vec<String> = allow
        .iter()
        .filter(|(f, h, _)| !used.contains(&(f.clone(), h.clone())))
        .map(|(f, h, _)| format!("{f} {h}"))
        .collect();
    assert!(
        unexpected.is_empty(),
        "src/core names history/semantic items (forbidden heads: {forbidden:?}); route them through \
         `core::capabilities` or list them in boundary-allowlist.txt with their inventory row:\n  {}",
        unexpected.join("\n  ")
    );
    assert!(
        stale.is_empty(),
        "boundary-allowlist.txt entries no core file matches any more — delete them:\n  {}",
        stale.join("\n  ")
    );
}

/// `src` with comments blanked but string literals kept (the SQL check).
fn strip_comments_only(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let b = src.as_bytes();
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

/// The vector tables and the scalar only the semantic bundle may name.
const VECTOR_NAMES: [&str; 3] = ["embeddings", "doc_embeddings", "cosine("];

/// Every `(line, name)` of a vector-table or `cosine(` mention in `src`
/// (comments stripped, strings kept); `embeddings` is matched as a whole word
/// so `doc_embeddings` counts once.
fn vector_mentions(src: &str) -> Vec<(usize, &'static str)> {
    let text = strip_comments_only(src);
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        for name in VECTOR_NAMES {
            let mut from = 0;
            while let Some(pos) = line[from..].find(name) {
                let at = from + pos;
                from = at + name.len();
                let before = line[..at].bytes().last();
                let after = line[at + name.len()..].bytes().next();
                let word_before = before.is_some_and(is_ident);
                let word_after = after.is_some_and(is_ident);
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
fn no_sql_of_the_core_names_a_vector_table_or_the_cosine_scalar() {
    let src = src_dir();
    let mut lines = Vec::new();
    for f in rust_files(&src.join("core")) {
        let rel = f
            .strip_prefix(&src)
            .unwrap_or(&f)
            .to_string_lossy()
            .replace('\\', "/");
        if rel == "core/size.rs" {
            continue; // the byte accountant's category map (module doc above)
        }
        let text = fs::read_to_string(&f).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        for (line, name) in vector_mentions(&text) {
            lines.push(format!("{rel}:{line} {name}"));
        }
    }
    assert!(
        lines.is_empty(),
        "src/core touches the semantic bundle's data; route it through `SemanticProvider`:\n  {}",
        lines.join("\n  ")
    );
    // The check bites: the bundle's own files do name them.
    let provider = fs::read_to_string(src.join("semantic/provider.rs")).expect("provider.rs");
    assert!(
        !vector_mentions(&provider).is_empty(),
        "the semantic provider names its tables"
    );
    let sample = vector_mentions(
        "// embeddings in a comment\nlet q = \"SELECT vec FROM embeddings WHERE 1\"; /* doc_embeddings */\ncosine_bytes(a, b); conn.create_scalar_function(\"cosine\", 2, f); \"SELECT cosine(a, b)\"",
    );
    assert_eq!(sample, [(2, "embeddings"), (3, "cosine(")]);
}

#[test]
fn the_semantic_extension_names_no_history_item() {
    // The semantic layer reads the current head only (`docs/modular-core/README.md`
    // §1): it may name the core, never the recorder.
    let src = src_dir();
    let semantic = rust_files(&src.join("semantic"));
    let forbidden = forbidden_heads(&["history"]);
    let found = violations(&semantic, &forbidden);
    let lines: Vec<String> = found
        .iter()
        .map(|v| format!("{}:{} crate::{}", v.file, v.line, v.head))
        .collect();
    assert!(
        lines.is_empty(),
        "src/semantic names history items:\n  {}",
        lines.join("\n  ")
    );
}

#[test]
fn the_stripper_keeps_code_and_drops_comments_and_strings() {
    let s = strip(
        "use crate::a::B; // crate::c\n/* crate::d */ let x = \"crate::e\"; let y = r#\"crate::f\"#; let z = '\"'; let l: &'a str = crate::g::h();\n",
    );
    let heads: Vec<String> = crate_heads(&s).into_iter().map(|(_, h)| h).collect();
    assert_eq!(heads, ["a", "g"]);
    let grouped = strip("use crate::{Store, properties, delta::{TreeResolver, Form}, tree};");
    let heads: Vec<String> = crate_heads(&grouped).into_iter().map(|(_, h)| h).collect();
    assert_eq!(heads, ["Store", "properties", "delta", "tree"]);
    let lines: Vec<usize> = crate_heads(&strip("\n\nuse crate::x;\nfn f() { crate::y::z() }"))
        .into_iter()
        .map(|(l, _)| l)
        .collect();
    assert_eq!(lines, [3, 4]);
}
