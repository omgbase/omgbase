//! Every file of the reference's round-trip corpus
//! (`packages/core/corpus/roundtrip/**/*.md`, the same files the fixtures are
//! generated from) must round-trip byte for byte and hold the §1 invariants.
//! Skips with a note when the corpus is not present (a published crate).

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use omgbase_format::parse_markdown;

const CORPUS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/core/corpus/roundtrip"
);
/// A wrong path must not pass by finding some other, smaller directory.
const MIN_FILES: usize = 30;

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        fs::read_dir(dir).unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("readable directory entry").path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

#[test]
fn corpus_round_trips_and_holds_the_invariants() {
    let dir = Path::new(CORPUS_DIR);
    if !dir.is_dir() {
        eprintln!(
            "roundtrip: corpus not present at {CORPUS_DIR} (built outside the omgbase monorepo); skipping"
        );
        return;
    }
    let mut files = Vec::new();
    collect(dir, &mut files);
    files.sort();
    assert!(
        files.len() >= MIN_FILES,
        "found only {} corpus files under {CORPUS_DIR}; wrong path?",
        files.len()
    );

    let mut failures = Vec::new();
    for path in &files {
        let source = fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let tree = parse_markdown(&source);
        if let Err(reason) = common::check_invariants(&tree) {
            failures.push(format!(
                "{}: {reason}",
                path.strip_prefix(dir).unwrap_or(path).display()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} corpus files fail:\n{}",
        failures.len(),
        files.len(),
        failures.join("\n")
    );
    eprintln!("roundtrip: {} corpus files round-trip", files.len());
}
