//! Shared by the integration tests: the §1 invariants every runner checks on
//! every tree (`spec/format/README.md` §1, §5).

#![allow(dead_code)]

use omgbase_format::{Block, BlockTree, full_coverage, normalize_visible_text, render};

/// Check invariants 1–7 of §1 (plus the §1/§2 shape rules that follow from
/// them: nested trivia is empty, `text` is the normalization of `raw`),
/// returning the first violation as a message.
pub fn check_invariants(tree: &BlockTree) -> Result<(), String> {
    let source = tree.source.as_str();

    // 1. Round trip.
    if render(tree) != source {
        return Err("render(parse(source)) != source".to_owned());
    }
    // 2. Full coverage.
    if !full_coverage(tree) {
        return Err("top-level blocks and trivia do not tile the source".to_owned());
    }
    if tree.children.is_empty() && tree.leading_trivia != source {
        return Err("a source with no blocks must be all leading_trivia".to_owned());
    }
    // 6. BOM.
    if source.starts_with('\u{FEFF}') && !tree.leading_trivia.starts_with('\u{FEFF}') {
        return Err("source begins with a BOM but leading_trivia does not".to_owned());
    }

    fn walk(source: &str, parent: Option<&Block>, block: &Block, path: &str) -> Result<(), String> {
        let at = |msg: &str| format!("{path} ({}): {msg}", block.kind);
        // 5. Offsets are bytes into the source, on char boundaries.
        let Some(slice) = source.get(block.span.start..block.span.end) else {
            return Err(at(&format!(
                "span [{}, {}) is not a valid byte range of the source",
                block.span.start, block.span.end
            )));
        };
        if slice != block.raw {
            return Err(at("raw is not the source bytes at span"));
        }
        // 4. No trailing line ending.
        if block.raw.ends_with(['\n', '\r']) {
            return Err(at("raw ends in a line ending"));
        }
        if let Some(parent) = parent {
            // 3. Nesting.
            if !parent.span.contains(&block.span) {
                return Err(at("nested span lies outside its parent's span"));
            }
            if !parent.raw.contains(block.raw.as_str()) {
                return Err(at("nested raw is not a substring of the parent's raw"));
            }
            if !block.trivia.is_empty() {
                return Err(at("nested block carries trivia"));
            }
        }
        if block.text != normalize_visible_text(&block.raw, block.kind) {
            return Err(at("text is not the §4.1 normalization of raw"));
        }
        let mut prev_end = block.span.start;
        for (i, child) in block.children.iter().enumerate() {
            if child.span.start < prev_end {
                return Err(at(&format!("child {i} overlaps or precedes its sibling")));
            }
            prev_end = child.span.end;
            walk(source, Some(block), child, &format!("{path}/{i}"))?;
        }
        Ok(())
    }

    for (i, block) in tree.children.iter().enumerate() {
        walk(source, None, block, &format!("blocks/{i}"))?;
    }
    Ok(())
}
