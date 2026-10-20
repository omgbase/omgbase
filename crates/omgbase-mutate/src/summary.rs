//! `preview.summary` (`spec/mutate/README.md` §11.9, mutate 3.3): the plan
//! as a worked example of itself — one line **in words** per resolved
//! effect, in order, outside the digest, byte-identical across engines. The
//! Receipt repeats the lines as its `summary`; the CLI prints them under the
//! commit confirmation.
//!
//! The wording table lives here and nowhere else (the reference's
//! `effects.ts` summary section). The store supplies what the words need
//! through [`SummaryLookup`], read **after** the effect is lowered, the live
//! row first and the planner's tree second — so a live block reads as it was
//! before the plan, a `$new.k` block as its `create` parsed it, and a block
//! the lookup cannot place degrades to `block <id>`; nothing fails.
//!
//! A document is named by its rooted path, a heading by its text in quotes
//! (`heading "Risks"`, `section "Risks"`), any other block by its type and id
//! (`paragraph b_12`, `task b_9`); every count carries its noun, pluralized
//! by an `s`.

use omgbase_format::markdown::parse;
use omgbase_format::text::normalize_visible_text;
use omgbase_format::{BlockKind, BlockTree, parse_path};
use serde_json::Value;

use crate::effects::{Effect, Target, canonical_json};
use crate::ops::At;

/// What the summary words need from the planner's state (module docs).
pub trait SummaryLookup {
    /// A block's `(type, visible text)`: the live row when it has one, else
    /// the planner's tree (a `$new.k`).
    fn block_descriptor(&self, id: &str) -> Option<(String, String)>;
    /// The document (id) holding a block, if known.
    fn block_doc(&self, id: &str) -> Option<String>;
    /// The storage-form path of a document by id (a `$new.n` the plan
    /// creates included), if known.
    fn doc_path(&self, doc_id: &str) -> Option<String>;
    /// The document (id) a node is anchored in.
    fn node_doc(&self, node_id: &str) -> Option<String>;
    /// The ids an `insert` effect's op reported (every block, descendants
    /// included); `None` counts the markdown's top-level blocks.
    fn inserted(&self) -> Option<usize>;
    /// `(links, documents)` a document move rewrote (`retarget_inbound`
    /// over at least one inbound link); `None` when nothing was rewritten.
    fn move_retarget(&self, doc_id: &str) -> Option<(usize, usize)>;
    /// `(hits, documents)` a `retarget` effect rewrites.
    fn retarget_hits(&self) -> Option<(usize, usize)>;
}

/// A lookup that knows nothing: every subject degrades to its id.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoLookup;

impl SummaryLookup for NoLookup {
    fn block_descriptor(&self, _: &str) -> Option<(String, String)> {
        None
    }
    fn block_doc(&self, _: &str) -> Option<String> {
        None
    }
    fn doc_path(&self, _: &str) -> Option<String> {
        None
    }
    fn node_doc(&self, _: &str) -> Option<String> {
        None
    }
    fn inserted(&self) -> Option<usize> {
        None
    }
    fn move_retarget(&self, _: &str) -> Option<(usize, usize)> {
        None
    }
    fn retarget_hits(&self) -> Option<(usize, usize)> {
        None
    }
}

/// The top-level blocks of a markdown (an `insert`'s when the op's result is
/// not at hand).
#[must_use]
pub fn block_count(markdown: &str) -> usize {
    top_level_count(&parse(markdown))
}

/// The top-level blocks of a `create`'s whole file, parsed under the format
/// its `path` selects (a `.yaml`/`.json` file is its own block tree).
#[must_use]
pub fn block_count_at(path: &str, source: &str) -> usize {
    top_level_count(&parse_path(path, source))
}

fn top_level_count(tree: &BlockTree) -> usize {
    tree.children
        .iter()
        .filter(|b| b.kind != BlockKind::Frontmatter)
        .count()
}

/// A block's visible text from its raw bytes and kind name (the live row's
/// `text`), for a block the planner parsed.
#[must_use]
pub fn visible_text_of(raw: &str, kind: &str) -> String {
    let k = kind.parse::<BlockKind>().unwrap_or(BlockKind::Paragraph);
    normalize_visible_text(raw, k, 0)
}

/// `1 block` / `2 blocks` (an `s` on every noun of the table).
#[must_use]
pub fn plural(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

/// The reference form of a storage path: `/`-rooted.
fn rooted(path: &str) -> String {
    format!("/{}", path.trim_start_matches('/'))
}

/// The rooted path of a document the plan addresses (its id when unknown).
fn doc_path_of(lookup: &dyn SummaryLookup, doc_id: &str) -> String {
    rooted(&lookup.doc_path(doc_id).unwrap_or_else(|| doc_id.to_owned()))
}

/// The document a placement target lives in.
fn target_doc(lookup: &dyn SummaryLookup, t: &Target) -> String {
    match t {
        Target::Document { id, path } => id.clone().or_else(|| path.clone()).unwrap_or_default(),
        Target::Block { id } | Target::Section { heading_id: id } => {
            lookup.block_doc(id).unwrap_or_else(|| id.clone())
        }
        Target::Node { id } => lookup.node_doc(id).unwrap_or_else(|| id.clone()),
    }
}

/// A block's name: `heading "Text"` for a heading, else `<type> <id>`, else
/// `block <id>`.
fn block_name(lookup: &dyn SummaryLookup, id: &str) -> String {
    match lookup.block_descriptor(id) {
        None => format!("block {id}"),
        Some((kind, text)) if kind == "heading" => {
            format!("heading {}", canonical_json(&Value::String(text)))
        }
        Some((kind, _)) => format!("{kind} {id}"),
    }
}

/// A section by its heading's text: `section "Risks"` (the id when unknown).
fn section_name(lookup: &dyn SummaryLookup, heading_id: &str) -> String {
    let text = lookup
        .block_descriptor(heading_id)
        .map_or_else(|| heading_id.to_owned(), |(_, text)| text);
    format!("section {}", canonical_json(&Value::String(text)))
}

/// The placement half of an `insert` / `move blocks` line: `<verb> the
/// end|start of <container> [in <path>]` — the container a document (its
/// path; no `in`), a section, a block (its name) — or `before|after <block>
/// in <path>`. `verb` is `at` for an insert, `to` for a move.
fn place_words(lookup: &dyn SummaryLookup, into: &Target, at: &At, verb: &str) -> String {
    let path = doc_path_of(lookup, &target_doc(lookup, into));
    match at {
        At::Before(anchor) => format!("before {} in {path}", block_name(lookup, anchor)),
        At::After(anchor) => format!("after {} in {path}", block_name(lookup, anchor)),
        At::Start | At::End => {
            let edge = format!(
                "{verb} the {}",
                if matches!(at, At::Start) {
                    "start"
                } else {
                    "end"
                }
            );
            match into {
                Target::Document { .. } => format!("{edge} of {path}"),
                Target::Section { heading_id } => {
                    format!("{edge} of {} in {path}", section_name(lookup, heading_id))
                }
                Target::Block { id } => format!("{edge} of {} in {path}", block_name(lookup, id)),
                Target::Node { id } => format!("{edge} of node {id} in {path}"),
            }
        }
    }
}

/// `from <path>`: the first block's document (the kernel refuses a
/// multi-document remove, so one document names them all).
fn from_docs(lookup: &dyn SummaryLookup, ids: &[String]) -> String {
    let first = ids.first().cloned().unwrap_or_default();
    let d = lookup.block_doc(&first).unwrap_or(first);
    doc_path_of(lookup, &d)
}

/// The summary line of one resolved effect (the wording table).
#[must_use]
pub fn summarize_effect(e: &Effect, lookup: &dyn SummaryLookup) -> String {
    match e {
        Effect::Create { path, markdown, .. } => format!(
            "create {} ({})",
            rooted(path),
            plural(block_count_at(path, markdown), "block")
        ),
        Effect::Insert {
            into, at, markdown, ..
        } => format!(
            "insert {} {}",
            plural(
                lookup.inserted().unwrap_or_else(|| block_count(markdown)),
                "block"
            ),
            place_words(lookup, into, at, "at")
        ),
        Effect::Set {
            target,
            field,
            value,
            ..
        } => match target {
            Target::Document { .. } if field == "content" => {
                format!(
                    "set content of {}",
                    doc_path_of(lookup, &target_doc(lookup, target))
                )
            }
            Target::Document { .. } => format!(
                "set {field} = {} in {}",
                canonical_json(value),
                doc_path_of(lookup, &target_doc(lookup, target))
            ),
            Target::Block { id } if field == "_attrs.checked" => format!(
                "{} {} in {}",
                if value.as_bool() == Some(true) {
                    "check"
                } else {
                    "uncheck"
                },
                block_name(lookup, id),
                doc_path_of(lookup, &target_doc(lookup, target))
            ),
            Target::Block { id } => format!(
                "set {field} of {} in {}",
                block_name(lookup, id),
                doc_path_of(lookup, &target_doc(lookup, target))
            ),
            Target::Node { id } => format!(
                "set {field} = {} on node {id} in {}",
                canonical_json(value),
                doc_path_of(lookup, &target_doc(lookup, target))
            ),
            Target::Section { heading_id } => {
                format!("set {field} of {}", section_name(lookup, heading_id))
            }
        },
        Effect::Unset { target, field, .. } => format!(
            "unset {field} in {}",
            doc_path_of(lookup, &target_doc(lookup, target))
        ),
        Effect::MoveDocument { target, to, .. } => {
            let from = match target {
                Target::Document {
                    path: Some(path), ..
                } => rooted(path),
                other => doc_path_of(lookup, &target_doc(lookup, other)),
            };
            let links = target
                .id()
                .and_then(|id| lookup.move_retarget(id))
                .map(|(links, docs)| {
                    format!(
                        " (retarget {} in {})",
                        plural(links, "link"),
                        plural(docs, "document")
                    )
                })
                .unwrap_or_default();
            format!("move {from} → {}{links}", rooted(to))
        }
        Effect::MoveBlocks {
            targets, into, at, ..
        } => format!(
            "move {} {}",
            what(lookup, targets),
            place_words(lookup, into, at, "to")
        ),
        Effect::RemoveDocument { target } => format!(
            "remove {}",
            match target {
                Target::Document {
                    path: Some(path), ..
                } => rooted(path),
                other => doc_path_of(lookup, &target_doc(lookup, other)),
            }
        ),
        Effect::RemoveBlocks { targets, .. } => format!(
            "remove {} from {}",
            what(lookup, targets),
            from_docs(lookup, targets)
        ),
        Effect::Split { target, at, .. } => format!(
            "split {} at offset{} {} in {}",
            block_name(lookup, target),
            if at.len() == 1 { "" } else { "s" },
            at.iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", "),
            doc_path_of(
                lookup,
                &lookup.block_doc(target).unwrap_or_else(|| target.clone())
            )
        ),
        Effect::Merge { targets, .. } => {
            let first = targets.first().map(String::as_str).unwrap_or_default();
            format!(
                "merge {} into {} in {}",
                plural(targets.len(), "block"),
                block_name(lookup, first),
                doc_path_of(
                    lookup,
                    &lookup.block_doc(first).unwrap_or_else(|| first.to_owned())
                )
            )
        }
        Effect::Retarget { repairs, .. } => {
            let (hits, docs) = lookup.retarget_hits().unwrap_or((0, 0));
            let pair = match repairs.as_slice() {
                [one] => format!("{} → {}", one.from, one.to),
                many => format!("over {}", plural(many.len(), "pair")),
            };
            format!(
                "retarget {} {pair} in {}",
                plural(hits, "link"),
                plural(docs, "document")
            )
        }
    }
}

/// One block by its name, several by their count.
fn what(lookup: &dyn SummaryLookup, ids: &[String]) -> String {
    match ids {
        [one] => block_name(lookup, one),
        many => plural(many.len(), "block"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    /// A lookup over a fixed table: `b_h` the heading "Setup", `b_p` a
    /// paragraph and `b_t` a task in `a.md` (`d_0`); `b_l` a list in `b.md`
    /// (`d_1`); `n_1` a node in `a.md`.
    struct Table {
        blocks: HashMap<&'static str, (&'static str, &'static str, &'static str)>,
        inserted: Option<usize>,
        retarget: Option<(usize, usize)>,
        moved: Option<(usize, usize)>,
    }

    fn table() -> Table {
        Table {
            blocks: HashMap::from([
                ("b_h", ("heading", "Setup", "d_0")),
                ("b_p", ("paragraph", "Alpha.", "d_0")),
                ("b_t", ("task", "do it", "d_0")),
                ("b_l", ("list", "- a", "d_1")),
            ]),
            inserted: Some(2),
            retarget: Some((3, 2)),
            moved: Some((2, 1)),
        }
    }

    impl SummaryLookup for Table {
        fn block_descriptor(&self, id: &str) -> Option<(String, String)> {
            self.blocks
                .get(id)
                .map(|(k, t, _)| ((*k).to_owned(), (*t).to_owned()))
        }
        fn block_doc(&self, id: &str) -> Option<String> {
            self.blocks.get(id).map(|(_, _, d)| (*d).to_owned())
        }
        fn doc_path(&self, doc_id: &str) -> Option<String> {
            match doc_id {
                "d_0" => Some("a.md".to_owned()),
                "d_1" => Some("b.md".to_owned()),
                "$new.0" => Some("c.md".to_owned()),
                _ => None,
            }
        }
        fn node_doc(&self, node_id: &str) -> Option<String> {
            (node_id == "n_1").then(|| "d_0".to_owned())
        }
        fn inserted(&self) -> Option<usize> {
            self.inserted
        }
        fn move_retarget(&self, _: &str) -> Option<(usize, usize)> {
            self.moved
        }
        fn retarget_hits(&self) -> Option<(usize, usize)> {
            self.retarget
        }
    }

    fn doc() -> Target {
        Target::Document {
            id: Some("d_0".into()),
            path: Some("a.md".into()),
        }
    }

    fn line(e: &Effect) -> String {
        summarize_effect(e, &table())
    }

    fn insert(into: Target, at: At) -> Effect {
        Effect::Insert {
            into,
            at,
            markdown: "One.\n\nTwo.".into(),
            expect: None,
        }
    }

    #[test]
    fn counts_and_plurals() {
        assert_eq!(block_count("One."), 1);
        assert_eq!(block_count("One.\n\nTwo.\n\n- a\n- b\n"), 3);
        assert_eq!(block_count(""), 0);
        assert_eq!(block_count("---\nk: v\n---\n\nBody.\n"), 1);
        assert_eq!(plural(1, "block"), "1 block");
        assert_eq!(plural(0, "link"), "0 links");
        assert_eq!(plural(2, "document"), "2 documents");
        assert_eq!(visible_text_of("## Setup ##", "heading"), "Setup");
        assert_eq!(visible_text_of("- [ ] do it", "task"), "do it");
    }

    #[test]
    fn insert_places_by_section_text_block_name_or_anchor() {
        let sec = Target::Section {
            heading_id: "b_h".into(),
        };
        assert_eq!(
            line(&insert(sec.clone(), At::End)),
            "insert 2 blocks at the end of section \"Setup\" in /a.md"
        );
        assert_eq!(
            line(&insert(sec.clone(), At::Start)),
            "insert 2 blocks at the start of section \"Setup\" in /a.md"
        );
        assert_eq!(
            line(&insert(sec, At::After("b_p".into()))),
            "insert 2 blocks after paragraph b_p in /a.md"
        );
        assert_eq!(
            line(&insert(
                Target::Block { id: "b_l".into() },
                At::Before("b_x".into())
            )),
            "insert 2 blocks before block b_x in /b.md"
        );
        assert_eq!(
            line(&insert(Target::Block { id: "b_l".into() }, At::End)),
            "insert 2 blocks at the end of list b_l in /b.md"
        );
        assert_eq!(
            line(&insert(doc(), At::End)),
            "insert 2 blocks at the end of /a.md"
        );
        // A created document by its symbol; an unknown heading by its id.
        assert_eq!(
            line(&insert(
                Target::Document {
                    id: Some("$new.0".into()),
                    path: Some("c.md".into())
                },
                At::End
            )),
            "insert 2 blocks at the end of /c.md"
        );
        assert_eq!(
            line(&insert(
                Target::Section {
                    heading_id: "$new.1".into()
                },
                At::End
            )),
            "insert 2 blocks at the end of section \"$new.1\" in /$new.1"
        );
        // Without the op's result the markdown's top-level blocks are counted.
        let mut t = table();
        t.inserted = None;
        assert_eq!(
            summarize_effect(&insert(doc(), At::End), &t),
            "insert 2 blocks at the end of /a.md"
        );
        assert_eq!(
            summarize_effect(
                &Effect::Insert {
                    into: doc(),
                    at: At::End,
                    markdown: "- a\n- b".into(),
                    expect: None,
                },
                &t
            ),
            "insert 1 block at the end of /a.md"
        );
    }

    #[test]
    fn set_and_unset_spell_the_field_and_the_canonical_value() {
        let set = |target: Target, field: &str, value: Value| Effect::Set {
            target,
            field: field.into(),
            value,
            expect: None,
        };
        assert_eq!(
            line(&set(doc(), "_frontmatter.status", json!("done"))),
            "set _frontmatter.status = \"done\" in /a.md"
        );
        assert_eq!(
            line(&set(
                doc(),
                "_frontmatter.tags",
                json!({ "b": 1, "a": ["x"] })
            )),
            "set _frontmatter.tags = {\"a\":[\"x\"],\"b\":1} in /a.md"
        );
        assert_eq!(
            line(&Effect::Unset {
                target: doc(),
                field: "_frontmatter.status".into(),
                expect: None,
            }),
            "unset _frontmatter.status in /a.md"
        );
        assert_eq!(
            line(&set(doc(), "content", json!("# A\n"))),
            "set content of /a.md"
        );
        assert_eq!(
            line(&set(
                Target::Block { id: "b_p".into() },
                "markdown",
                json!("New.")
            )),
            "set markdown of paragraph b_p in /a.md"
        );
        assert_eq!(
            line(&set(
                Target::Block { id: "b_h".into() },
                "markdown",
                json!("# N")
            )),
            "set markdown of heading \"Setup\" in /a.md"
        );
        assert_eq!(
            line(&set(
                Target::Block { id: "b_t".into() },
                "_attrs.checked",
                json!(true)
            )),
            "check task b_t in /a.md"
        );
        assert_eq!(
            line(&set(
                Target::Block { id: "b_t".into() },
                "_attrs.checked",
                json!(false)
            )),
            "uncheck task b_t in /a.md"
        );
        assert_eq!(
            line(&set(
                Target::Node { id: "n_1".into() },
                "due",
                json!("2026-10-13")
            )),
            "set due = \"2026-10-13\" on node n_1 in /a.md"
        );
    }

    #[test]
    fn documents_are_created_moved_and_removed_by_rooted_path() {
        assert_eq!(
            line(&Effect::Create {
                path: "c.md".into(),
                markdown: "# C\n\nBody.".into(),
                frontmatter: None,
            }),
            "create /c.md (2 blocks)"
        );
        assert_eq!(
            line(&Effect::MoveDocument {
                target: doc(),
                to: "z.md".into(),
                retarget_inbound: true,
            }),
            "move /a.md → /z.md (retarget 2 links in 1 document)"
        );
        let mut t = table();
        t.moved = None;
        assert_eq!(
            summarize_effect(
                &Effect::MoveDocument {
                    target: doc(),
                    to: "z.md".into(),
                    retarget_inbound: false,
                },
                &t
            ),
            "move /a.md → /z.md"
        );
        assert_eq!(
            line(&Effect::RemoveDocument { target: doc() }),
            "remove /a.md"
        );
    }

    #[test]
    fn blocks_are_moved_removed_split_and_merged_by_name() {
        let mv = |targets: &[&str], into: Target, at: At| Effect::MoveBlocks {
            targets: targets.iter().map(|s| (*s).to_owned()).collect(),
            into,
            at,
            expect: None,
        };
        assert_eq!(
            line(&mv(&["b_p"], doc(), At::After("b_h".into()))),
            "move paragraph b_p after heading \"Setup\" in /a.md"
        );
        assert_eq!(
            line(&mv(
                &["b_p", "b_t"],
                Target::Section {
                    heading_id: "b_h".into()
                },
                At::End
            )),
            "move 2 blocks to the end of section \"Setup\" in /a.md"
        );
        assert_eq!(
            line(&mv(&["b_p"], Target::Block { id: "b_l".into() }, At::Start)),
            "move paragraph b_p to the start of list b_l in /b.md"
        );
        assert_eq!(
            line(&mv(&["b_p"], doc(), At::End)),
            "move paragraph b_p to the end of /a.md"
        );
        let rm = |targets: &[&str]| Effect::RemoveBlocks {
            targets: targets.iter().map(|s| (*s).to_owned()).collect(),
            expect: None,
        };
        assert_eq!(line(&rm(&["b_p"])), "remove paragraph b_p from /a.md");
        assert_eq!(line(&rm(&["b_p", "b_t"])), "remove 2 blocks from /a.md");
        assert_eq!(line(&rm(&["b_p", "b_l"])), "remove 2 blocks from /a.md");
        assert_eq!(line(&rm(&["b_zz"])), "remove block b_zz from /b_zz");
        assert_eq!(
            line(&Effect::Split {
                target: "b_p".into(),
                at: vec![4],
                expect: None,
            }),
            "split paragraph b_p at offset 4 in /a.md"
        );
        assert_eq!(
            line(&Effect::Split {
                target: "b_p".into(),
                at: vec![4, 9],
                expect: None,
            }),
            "split paragraph b_p at offsets 4, 9 in /a.md"
        );
        assert_eq!(
            line(&Effect::Merge {
                targets: vec!["b_p".into(), "b_t".into(), "b_x".into()],
                separator: Some(" ".into()),
                expect: None,
            }),
            "merge 3 blocks into paragraph b_p in /a.md"
        );
    }

    #[test]
    fn retarget_counts_its_hits_pairs_and_documents() {
        let repair = |from: &str, to: &str| crate::effects::Repair {
            from: from.into(),
            to: to.into(),
        };
        let one = Effect::Retarget {
            repairs: vec![repair("old.md", "new.md")],
            path_glob: None,
        };
        assert_eq!(
            line(&one),
            "retarget 3 links old.md → new.md in 2 documents"
        );
        let mut t = table();
        t.retarget = Some((1, 1));
        assert_eq!(
            summarize_effect(&one, &t),
            "retarget 1 link old.md → new.md in 1 document"
        );
        assert_eq!(
            summarize_effect(&one, &NoLookup),
            "retarget 0 links old.md → new.md in 0 documents"
        );
        let two = Effect::Retarget {
            repairs: vec![repair("a", "b"), repair("c", "d")],
            path_glob: None,
        };
        assert_eq!(line(&two), "retarget 3 links over 2 pairs in 2 documents");
    }
}
