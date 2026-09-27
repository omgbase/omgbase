//! The six operations (`spec/mutate/README.md` §1.1, §1.2, §2) over a
//! [`MutDoc`], plus the cross-document move (§2.3). Every op mutates the
//! tree in place; an error leaves the tree partially mutated, which is fine
//! because a changeset aborts as a whole on the first error (§4 step 3).

use std::collections::{BTreeMap, HashSet};

use omgbase_format::json::attrs_to_json;
use omgbase_format::{Block, BlockKind, parse_markdown};
use omgbase_reconcile::Minter;
use serde_json::{Map, Value, json};

use crate::error::{ErrorCode, MutationError, Result};
use crate::tree::{BlockPath, MutBlock, MutDoc, parent_children_hash, raw_hash_hex};

/// §1.1 `To.parent`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parent {
    /// The document's top level (`{ doc: true }`).
    Doc,
    /// A block's children.
    Block(String),
    /// The top level, within a heading's section (`{ heading, scope: "section" }`).
    Section { heading: String },
}

/// §1.1 `To.at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum At {
    Start,
    End,
    Before(String),
    After(String),
}

impl At {
    /// The anchor id of a `before`/`after`.
    #[must_use]
    pub fn anchor(&self) -> Option<&str> {
        match self {
            At::Before(id) | At::After(id) => Some(id),
            At::Start | At::End => None,
        }
    }
}

/// §1.1 placement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct To {
    pub parent: Parent,
    pub at: At,
}

/// §1.2 expectations.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Expect {
    pub content_hash: Option<String>,
    pub parent_children_hash: Option<String>,
}

impl Expect {
    /// `{ content_hash }`.
    #[must_use]
    pub fn content(hash: impl Into<String>) -> Self {
        Self {
            content_hash: Some(hash.into()),
            parent_children_hash: None,
        }
    }

    /// `{ parent_children_hash }` — the §1.2 order CAS alone (what an
    /// `insert`/`move` sends for its destination parent).
    #[must_use]
    pub fn order(hash: impl Into<String>) -> Self {
        Self {
            content_hash: None,
            parent_children_hash: Some(hash.into()),
        }
    }
}

/// What an op returns (§2): the ids, plus `removed` (remove) or
/// `merged_into` (merge).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpResult {
    pub ids: Vec<String>,
    pub removed: Option<Vec<String>>,
    pub merged_into: Option<Vec<String>>,
}

impl OpResult {
    #[must_use]
    pub fn ids(ids: Vec<String>) -> Self {
        Self {
            ids,
            removed: None,
            merged_into: None,
        }
    }

    /// `{ ids, removed?, merged_into? }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ids".to_owned(), json!(self.ids));
        if let Some(r) = &self.removed {
            m.insert("removed".to_owned(), json!(r));
        }
        if let Some(r) = &self.merged_into {
            m.insert("merged_into".to_owned(), json!(r));
        }
        Value::Object(m)
    }
}

/// The format's inter-block separator (`"\n\n"` for Markdown).
#[must_use]
pub fn default_trivia(format: &str) -> &'static str {
    match format {
        "json" => ",\n",
        "yaml" => "\n",
        _ => "\n\n",
    }
}

/// Whether trailing trivia holds a real block boundary: a blank line for
/// Markdown, anything non-empty otherwise.
#[must_use]
pub fn separates_blocks(trivia: &str, format: &str) -> bool {
    if format == "markdown" {
        trivia.contains("\n\n")
    } else {
        !trivia.is_empty()
    }
}

fn to_mut(b: &Block, trivia_default: &str, minter: &mut dyn Minter) -> MutBlock {
    let id = minter.mint();
    let attrs = match attrs_to_json(&b.attrs) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    MutBlock {
        id,
        kind: b.kind.as_str().to_owned(),
        raw: b.raw.clone(),
        trivia: if b.trivia.is_empty() {
            trivia_default.to_owned()
        } else {
            b.trivia.clone()
        },
        attrs,
        children: b
            .children
            .iter()
            .map(|c| to_mut(c, trivia_default, minter))
            .collect(),
        dirty: false,
    }
}

/// §2: parse op-supplied content (a trailing `\n` ensured) into clean
/// blocks with freshly minted ids, pre-order at parse time; a `frontmatter`
/// block is dropped (§10 mint order).
pub fn parse_content(content: &str, format: &str, minter: &mut dyn Minter) -> Vec<MutBlock> {
    let normalized = if content.ends_with('\n') {
        content.to_owned()
    } else {
        format!("{content}\n")
    };
    let tree = parse_markdown(&normalized);
    let trivia = default_trivia(format);
    tree.children
        .iter()
        .filter(|b| b.kind != BlockKind::Frontmatter)
        .map(|b| to_mut(b, trivia, minter))
        .collect()
}

fn err(code: ErrorCode, msg: impl Into<String>) -> MutationError {
    MutationError::new(code, msg)
}

fn err_data(code: ErrorCode, msg: impl Into<String>, data: Value) -> MutationError {
    MutationError::with_data(code, msg, data)
}

/// A resolved placement: the parent path and the insertion index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub parent: BlockPath,
    pub index: usize,
}

fn resolve_index(siblings: &[MutBlock], at: &At) -> Result<usize> {
    match at {
        At::Start => Ok(0),
        At::End => Ok(siblings.len()),
        At::Before(id) => siblings
            .iter()
            .position(|b| b.id == *id)
            .ok_or_else(|| err(ErrorCode::TargetMissing, format!("anchor {id} not found"))),
        At::After(id) => siblings
            .iter()
            .position(|b| b.id == *id)
            .map(|i| i + 1)
            .ok_or_else(|| err(ErrorCode::TargetMissing, format!("anchor {id} not found"))),
    }
}

fn level_of(b: &MutBlock) -> i64 {
    match b.attrs.get("level") {
        None | Some(Value::Null) => 1,
        Some(v) => js_number(v),
    }
}

/// JavaScript `Number(v)` for the attr values a level can hold.
fn js_number(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
        Value::Bool(b) => i64::from(*b),
        Value::String(s) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// §1.1: a section runs from its heading to before the next top-level
/// heading of level ≤ its own.
fn resolve_section(doc: &MutDoc, heading: &str, at: &At) -> Result<Target> {
    let tops = &doc.children;
    let h_idx = tops.iter().position(|b| b.id == heading).ok_or_else(|| {
        err(
            ErrorCode::TargetMissing,
            format!("heading {heading} not found"),
        )
    })?;
    let level = level_of(&tops[h_idx]);
    let mut end = tops.len();
    for (i, b) in tops.iter().enumerate().skip(h_idx + 1) {
        if b.kind == "heading" && level_of(b) <= level {
            end = i;
            break;
        }
    }
    let index = match at {
        At::End => end,
        At::Start => h_idx + 1,
        anchor => resolve_index(tops, anchor)?,
    };
    Ok(Target {
        parent: Vec::new(),
        index,
    })
}

/// §1.1 (1.2): whether `block` can own children placed by `insert`/`move` —
/// a kind whose children the parser produces. Markdown asks the format
/// layer's kind table (`list`, `list_item`, `task`, `blockquote`, `table`);
/// any other format has no kind table, so a block with children is a
/// container and a childless one is a leaf.
fn is_container(format: &str, block: &MutBlock) -> bool {
    if format == "markdown" {
        block
            .kind
            .parse::<BlockKind>()
            .is_ok_and(|k| k.is_container())
    } else {
        !block.children.is_empty()
    }
}

/// §1.1 (1.2): `to.parent` naming a leaf is `type_mismatch` — before 1.2 the
/// blocks landed in the leaf's empty `children`, the dirty leaf re-rendered
/// from them and its own text was lost (§10).
fn require_container(doc: &MutDoc, path: &[usize], op_index: usize) -> Result<()> {
    let block = doc.block(path);
    if is_container(&doc.format, block) {
        return Ok(());
    }
    let (id, kind) = (&block.id, &block.kind);
    Err(err_data(
        ErrorCode::TypeMismatch,
        format!(
            "{id} is a {kind}, not a container; place relative to it with at.before/at.after or append to its section"
        ),
        json!({ "op_index": op_index, "block": id, "type": kind }),
    ))
}

/// §1.1: resolve a placement to a sibling list and an index. A `parent` id
/// must name a container (1.2); `op_index` rides on that error.
pub fn resolve_target(doc: &MutDoc, to: &To, op_index: usize) -> Result<Target> {
    match &to.parent {
        Parent::Doc => Ok(Target {
            parent: Vec::new(),
            index: resolve_index(&doc.children, &to.at)?,
        }),
        Parent::Section { heading } => resolve_section(doc, heading, &to.at),
        Parent::Block(id) => {
            let path = doc
                .locate(id)
                .ok_or_else(|| err(ErrorCode::ParentMissing, format!("parent {id} not found")))?;
            require_container(doc, &path, op_index)?;
            let index = resolve_index(&doc.block(&path).children, &to.at)?;
            Ok(Target {
                parent: path,
                index,
            })
        }
    }
}

/// §1.2 `check_content_hash`: a missing or mismatched `content_hash` raises
/// `stale_expectation` carrying the current hash and bytes.
pub fn check_content_hash(
    block: &MutBlock,
    expect: Option<&Expect>,
    op_index: usize,
) -> Result<()> {
    let Some(expected) = expect
        .and_then(|e| e.content_hash.as_deref())
        .filter(|h| !h.is_empty())
    else {
        return Err(err_data(
            ErrorCode::StaleExpectation,
            "expect.content_hash required",
            json!({
                "op_index": op_index,
                "block": block.id,
                "current": { "content_hash": raw_hash_hex(&block.raw), "markdown": block.raw },
                "retriable": true,
            }),
        ));
    };
    let current = raw_hash_hex(&block.raw);
    if current != expected {
        return Err(err_data(
            ErrorCode::StaleExpectation,
            "content hash mismatch",
            json!({
                "op_index": op_index,
                "block": block.id,
                "expected_content_hash": expected,
                "current": { "content_hash": current, "markdown": block.raw },
                "retriable": true,
            }),
        ));
    }
    Ok(())
}

/// §1.2: `parent_children_hash` of the block's children (the top level for
/// `None`) must equal `expected`.
pub fn check_parent_children_hash(
    doc: &MutDoc,
    parent_id: Option<&str>,
    expected: &str,
    op_index: usize,
) -> Result<()> {
    let list = match parent_id.and_then(|id| doc.locate(id)) {
        Some(path) => &doc.block(&path).children,
        None => &doc.children,
    };
    check_children_hash(list, Some(&Expect::order(expected)), op_index)
}

/// §1.2 as the ops call it: when `expect` carries a `parent_children_hash`,
/// the LIVE ids of `list` (the sibling list the op resolved — the block's
/// current parent for update/split/remove/merge, the destination parent for
/// insert/move) must hash to it. Runs after the content CAS and before the
/// tree is touched, so a stale order never lands.
fn check_children_hash(list: &[MutBlock], expect: Option<&Expect>, op_index: usize) -> Result<()> {
    let Some(expected) = expect.and_then(|e| e.parent_children_hash.as_deref()) else {
        return Ok(());
    };
    let current = parent_children_hash(list);
    if current != expected {
        return Err(err_data(
            ErrorCode::StaleExpectation,
            "parent_children_hash mismatch",
            json!({
                "op_index": op_index,
                "current": { "parent_children_hash": current },
                "retriable": true,
            }),
        ));
    }
    Ok(())
}

/// §2.2: override the minted ids of a re-parsed subtree by positional key
/// (`"/0"`, `"/1/2"`, relative to the block's children).
fn assign_child_ids(
    children: &mut [MutBlock],
    child_ids: &BTreeMap<String, String>,
    parent_key: &str,
) {
    for (i, c) in children.iter_mut().enumerate() {
        let key = format!("{parent_key}/{i}");
        if let Some(id) = child_ids.get(&key).filter(|id| !id.is_empty()) {
            c.id = id.clone();
        }
        if !c.children.is_empty() {
            assign_child_ids(&mut c.children, child_ids, &key);
        }
    }
}

/// §2.1: a bare block becomes a `list_item` with raw `"- " + raw` (fresh id,
/// dirty).
fn wrap_as_item(b: &MutBlock, minter: &mut dyn Minter) -> MutBlock {
    MutBlock {
        id: minter.mint(),
        kind: "list_item".to_owned(),
        raw: format!("- {}", b.raw),
        trivia: String::new(),
        attrs: Map::new(),
        children: Vec::new(),
        dirty: true,
    }
}

// ---- the six ops --------------------------------------------------------------------

/// §2.1 `insert`.
pub fn op_insert(
    doc: &mut MutDoc,
    to: &To,
    markdown: &str,
    op_index: usize,
    expect: Option<&Expect>,
    minter: &mut dyn Minter,
) -> Result<OpResult> {
    let Target { parent, index } = resolve_target(doc, to, op_index)?;
    // §1.2: the destination parent's order CAS — `parent` IS the resolved
    // sibling list (a section scope or a `{ doc: true }` anchor name the top level).
    check_children_hash(doc.siblings(&parent), expect, op_index)?;
    let mut blocks = parse_content(markdown, &doc.format, minter);
    let owner_is_list = doc.owner_of(&parent).is_some_and(|o| o.kind == "list");
    if owner_is_list && doc.format == "markdown" {
        let mut items = Vec::new();
        for b in blocks {
            if b.kind == "list" {
                items.extend(b.children);
            } else {
                items.push(wrap_as_item(&b, minter));
            }
        }
        let ids: Vec<String> = items.iter().map(|b| b.id.clone()).collect();
        let siblings = doc.siblings_mut(&parent);
        let tail = siblings.split_off(index);
        siblings.extend(items);
        siblings.extend(tail);
        doc.block_mut(&parent).dirty = true;
        return Ok(OpResult::ids(ids));
    }
    let format = doc.format.clone();
    if parent.is_empty() {
        let sep = default_trivia(&format);
        if index > 0 {
            let prev = &mut doc.children[index - 1];
            if !separates_blocks(&prev.trivia, &format) {
                prev.trivia = sep.to_owned();
            }
        }
        if !blocks.is_empty() && index < doc.children.len() {
            let last = blocks.last_mut().expect("non-empty");
            if !separates_blocks(&last.trivia, &format) {
                last.trivia = sep.to_owned();
            }
        }
    }
    let ids: Vec<String> = blocks.iter().map(|b| b.id.clone()).collect();
    let siblings = doc.siblings_mut(&parent);
    let tail = siblings.split_off(index);
    siblings.extend(blocks);
    siblings.extend(tail);
    if !parent.is_empty() {
        doc.mark_container_dirty(&parent);
    }
    Ok(OpResult::ids(ids))
}

/// The inputs of §2.2 `update` besides the block.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpdateArgs {
    pub markdown: Option<String>,
    pub attrs: Option<Map<String, Value>>,
    pub expect: Option<Expect>,
    pub trivia: Option<String>,
    pub child_ids: Option<BTreeMap<String, String>>,
}

/// §2.2 `update`.
pub fn op_update(
    doc: &mut MutDoc,
    block_id: &str,
    op_index: usize,
    args: &UpdateArgs,
    minter: &mut dyn Minter,
) -> Result<OpResult> {
    let path = doc.locate(block_id).ok_or_else(|| {
        err_data(
            ErrorCode::BlockMissing,
            format!("block {block_id} not found"),
            json!({ "op_index": op_index, "block": block_id }),
        )
    })?;
    let (index, parent) = path.split_last().expect("located path is non-empty");
    let (index, parent) = (*index, parent.to_vec());
    if args.markdown.is_some()
        || args
            .expect
            .as_ref()
            .is_some_and(|e| e.content_hash.is_some())
    {
        check_content_hash(doc.block(&path), args.expect.as_ref(), op_index)?;
    }
    // §1.2: the block's CURRENT parent, after the content CAS.
    check_children_hash(doc.siblings(&parent), args.expect.as_ref(), op_index)?;
    let format = doc.format.clone();
    let mut extra: Vec<MutBlock> = Vec::new();
    if let Some(markdown) = &args.markdown {
        let is_item = doc.block(&path).kind == "list_item";
        if format == "markdown" && is_item {
            let mut parsed = parse_content(markdown, &format, minter);
            if parsed.len() != 1 {
                return Err(err_data(
                    ErrorCode::TypeMismatch,
                    "list-item update content must be ONE list (`- a\\n- b`: first item replaces, the rest follow as siblings) or ONE bare block",
                    json!({
                        "op_index": op_index,
                        "block": block_id,
                        "hint": "to put mixed content under an item, update the item then blocks_insert the rest with `to` = the item",
                    }),
                ));
            }
            let only = parsed.remove(0);
            let block = doc.block_mut(&path);
            if only.kind == "list" {
                if only.children.is_empty() {
                    return Err(err_data(
                        ErrorCode::TypeMismatch,
                        "list-item update must yield at least one item",
                        json!({ "op_index": op_index, "block": block_id }),
                    ));
                }
                let mut items = only.children.into_iter();
                let first = items.next().expect("non-empty");
                block.raw = first.raw;
                block.children = first.children;
                extra.extend(items);
            } else {
                block.raw = format!("- {}", only.raw);
                block.children = Vec::new();
            }
            block.dirty = true;
            doc.mark_container_dirty(&parent);
        } else if format == "markdown" {
            let mut parsed = parse_content(markdown, &format, minter);
            if parsed.is_empty() {
                return Err(err_data(
                    ErrorCode::TypeMismatch,
                    "update content must contain at least one block",
                    json!({ "op_index": op_index, "block": block_id }),
                ));
            }
            if parsed.len() > 1 && args.child_ids.is_some() {
                return Err(err_data(
                    ErrorCode::TypeMismatch,
                    "update with childIds must be a single block",
                    json!({ "op_index": op_index, "block": block_id }),
                ));
            }
            let nb = parsed.remove(0);
            extra.extend(parsed);
            let block = doc.block_mut(&path);
            block.raw = nb.raw;
            block.kind = nb.kind;
            block.attrs = nb.attrs;
            block.children = nb.children;
            if let Some(child_ids) = &args.child_ids {
                if !block.children.is_empty() {
                    assign_child_ids(&mut block.children, child_ids, "");
                }
            }
            block.mark_subtree_clean();
            doc.mark_container_dirty(&parent);
        } else {
            let block = doc.block_mut(&path);
            block.raw = markdown.clone();
            block.children = Vec::new();
            block.dirty = true;
        }
    }
    if let Some(attrs) = &args.attrs {
        let block = doc.block_mut(&path);
        for (k, v) in attrs {
            block.attrs.insert(k.clone(), v.clone());
        }
        if let Some(checked) = attrs.get("checked") {
            if block.kind == "task" || block.kind == "list_item" {
                let replacement = if truthy(checked) { "[x]" } else { "[ ]" };
                if let Some(pos) = find_checkbox(&block.raw) {
                    block.raw.replace_range(pos..pos + 3, replacement);
                }
                block.kind = "task".to_owned();
                block.dirty = true;
            }
        }
    }
    if let Some(trivia) = &args.trivia {
        doc.block_mut(&path).trivia = trivia.clone();
    }
    let mut ids = vec![block_id.to_owned()];
    if !extra.is_empty() {
        let tail = doc.block(&path).trivia.clone();
        if parent.is_empty() {
            let sep = default_trivia(&format);
            let block = doc.block_mut(&path);
            if !separates_blocks(&block.trivia, &format) {
                block.trivia = sep.to_owned();
            }
            let n = extra.len();
            for b in &mut extra[..n - 1] {
                if !separates_blocks(&b.trivia, &format) {
                    b.trivia = sep.to_owned();
                }
            }
        }
        extra.last_mut().expect("non-empty").trivia = tail;
        ids.extend(extra.iter().map(|b| b.id.clone()));
        let siblings = doc.siblings_mut(&parent);
        let rest = siblings.split_off(index + 1);
        siblings.extend(extra);
        siblings.extend(rest);
        doc.mark_container_dirty(&parent);
    }
    Ok(OpResult::ids(ids))
}

/// The first `[ ]`/`[x]`/`[X]` in `raw` (byte offset).
fn find_checkbox(raw: &str) -> Option<usize> {
    let bytes = raw.as_bytes();
    (0..bytes.len().saturating_sub(2)).find(|&i| {
        bytes[i] == b'[' && matches!(bytes[i + 1], b' ' | b'x' | b'X') && bytes[i + 2] == b']'
    })
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// §2.3: every non-last top-level block whose trivia does not separate gets
/// the separator.
fn heal_top_level_seams(doc: &mut MutDoc) {
    let format = doc.format.clone();
    let sep = default_trivia(&format);
    let n = doc.children.len();
    for b in doc.children.iter_mut().take(n.saturating_sub(1)) {
        if !separates_blocks(&b.trivia, &format) {
            b.trivia = sep.to_owned();
        }
    }
}

/// Locate every id (`block_missing` with `{ op_index, block }`) and require
/// one sibling list; returns the parent path and each block's index in
/// argument order.
fn locate_run(
    doc: &MutDoc,
    block_ids: &[String],
    op_index: usize,
) -> Result<(BlockPath, Vec<usize>)> {
    let mut parent: Option<BlockPath> = None;
    let mut indices = Vec::with_capacity(block_ids.len());
    let mut same_parent = true;
    for id in block_ids {
        let path = doc.locate(id).ok_or_else(|| {
            err_data(
                ErrorCode::BlockMissing,
                format!("block {id} not found"),
                json!({ "op_index": op_index, "block": id }),
            )
        })?;
        let (index, p) = path.split_last().expect("non-empty");
        match &parent {
            None => parent = Some(p.to_vec()),
            Some(first) if first.as_slice() != p => same_parent = false,
            Some(_) => {}
        }
        indices.push(*index);
    }
    let parent = parent.unwrap_or_default();
    if !same_parent {
        // Signalled by an impossible index list: callers check contiguity.
        return Ok((parent, Vec::new()));
    }
    Ok((parent, indices))
}

/// §2.3 `move` within one document.
pub fn op_move(
    doc: &mut MutDoc,
    block_ids: &[String],
    to: &To,
    op_index: usize,
    expect: Option<&Expect>,
) -> Result<OpResult> {
    if block_ids.is_empty() {
        return Err(err(ErrorCode::NotContiguous, "move requires ≥1 block"));
    }
    let (parent, indices) = locate_run(doc, block_ids, op_index)?;
    let mut sorted = indices.clone();
    sorted.sort_unstable();
    let contiguous = !indices.is_empty() && sorted.windows(2).all(|w| w[1] == w[0] + 1);
    if !contiguous {
        return Err(err_data(
            ErrorCode::NotContiguous,
            "move blocks must be a contiguous sibling run",
            json!({ "op_index": op_index }),
        ));
    }
    // cycle_move: the target parent must not be inside the moved subtrees.
    if let Parent::Block(target) = &to.parent {
        let siblings = doc.siblings(&parent);
        let moved: HashSet<String> = indices
            .iter()
            .flat_map(|&i| siblings[i].subtree_ids())
            .collect();
        if moved.contains(target) {
            return Err(err_data(
                ErrorCode::CycleMove,
                "target is inside the moved subtree",
                json!({ "op_index": op_index }),
            ));
        }
    }
    // The destination resolves on the pre-removal tree first so a leaf parent
    // (§1.1 `type_mismatch`) or a missing one fails before the op mutates
    // anything; the index is re-resolved after the removal below.
    let Target { parent: dst, .. } = resolve_target(doc, to, op_index)?;
    // §1.2: the DESTINATION parent's order CAS, checked once for the whole
    // run. When source and destination are one list this is the "same
    // siblings reordered under me" guard: the hash covers the moved blocks too.
    check_children_hash(doc.siblings(&dst), expect, op_index)?;
    // Extract in argument order.
    let mut moving = Vec::with_capacity(block_ids.len());
    {
        let siblings = doc.siblings_mut(&parent);
        for id in block_ids {
            if let Some(i) = siblings.iter().position(|b| &b.id == id) {
                moving.push(siblings.remove(i));
            }
        }
    }
    // The source owner's path is unaffected by removals inside its list; mark
    // it before the destination splice can shift top-level indices.
    doc.mark_container_dirty(&parent);
    let Target { parent: dst, index } = resolve_target(doc, to, op_index)?;
    {
        let siblings = doc.siblings_mut(&dst);
        let tail = siblings.split_off(index);
        siblings.extend(moving);
        siblings.extend(tail);
    }
    doc.mark_container_dirty(&dst);
    if parent.is_empty() || dst.is_empty() {
        heal_top_level_seams(doc);
    }
    Ok(OpResult::ids(block_ids.to_vec()))
}

/// Whether any owner up the chain from the sibling list at `parent` is in `set`.
fn has_ancestor_in(doc: &MutDoc, parent: &[usize], set: &HashSet<&str>) -> bool {
    (1..=parent.len()).any(|n| set.contains(doc.block(&parent[..n]).id.as_str()))
}

/// After removing from the list at `parent`: an emptied owner is removed from
/// its own parent (recursively), otherwise the owner is marked dirty.
fn prune_or_dirty(doc: &mut MutDoc, parent: &[usize]) {
    if parent.is_empty() {
        return;
    }
    if doc.block(parent).children.is_empty() {
        let (index, grand) = parent.split_last().expect("non-empty");
        doc.siblings_mut(grand).remove(*index);
        prune_or_dirty(doc, grand);
    } else {
        doc.block_mut(parent).dirty = true;
    }
}

/// §2.4 `remove`.
pub fn op_remove(
    doc: &mut MutDoc,
    block_ids: &[String],
    op_index: usize,
    expect_per: Option<&BTreeMap<String, Expect>>,
) -> Result<OpResult> {
    let set: HashSet<&str> = block_ids.iter().map(String::as_str).collect();
    let mut tops: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for id in block_ids {
        if !seen.insert(id) {
            continue;
        }
        let path = doc.locate(id).ok_or_else(|| {
            err_data(
                ErrorCode::BlockMissing,
                format!("block {id} not found in this document"),
                json!({
                    "op_index": op_index,
                    "block": id,
                    "hint": "the id is not a live block of the targeted document — it may have been removed by an earlier op in this changeset (removing a block removes its whole subtree), or never existed",
                }),
            )
        })?;
        let (_, parent) = path.split_last().expect("non-empty");
        if let Some(e) = expect_per.and_then(|m| m.get(id)) {
            check_content_hash(doc.block(&path), Some(e), op_index)?;
            // §1.2: its current parent, while the block is still in place.
            check_children_hash(doc.siblings(parent), Some(e), op_index)?;
        }
        if !has_ancestor_in(doc, parent, &set) {
            tops.push(id);
        }
    }
    let mut removed = Vec::new();
    for id in tops {
        let path = doc.locate(id).expect("validated in pass 1");
        let (index, parent) = path.split_last().expect("non-empty");
        let block = doc.siblings_mut(parent).remove(*index);
        removed.extend(block.subtree_ids());
        prune_or_dirty(doc, parent);
    }
    Ok(OpResult {
        ids: block_ids.to_vec(),
        removed: Some(removed),
        merged_into: None,
    })
}

/// A byte offset rounded down to a char boundary and clamped to the length.
fn char_boundary(s: &str, at: usize) -> usize {
    let mut i = at.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// §2.5 `split`.
pub fn op_split(
    doc: &mut MutDoc,
    block_id: &str,
    at: &[usize],
    op_index: usize,
    expect: Option<&Expect>,
    minter: &mut dyn Minter,
) -> Result<OpResult> {
    let path = doc.locate(block_id).ok_or_else(|| {
        err_data(
            ErrorCode::BlockMissing,
            format!("block {block_id} not found"),
            json!({ "op_index": op_index, "block": block_id }),
        )
    })?;
    check_content_hash(doc.block(&path), expect, op_index)?;
    // §1.2: its current parent, after the content CAS.
    let (_, split_parent) = path.split_last().expect("non-empty");
    check_children_hash(doc.siblings(split_parent), expect, op_index)?;
    let raw = doc.block(&path).raw.clone();
    let mut cuts: Vec<usize> = vec![0];
    cuts.extend(at.iter().map(|&a| char_boundary(&raw, a)));
    cuts.push(raw.len());
    cuts.sort_unstable();
    let pieces: Vec<&str> = cuts
        .windows(2)
        .map(|w| &raw[w[0]..w[1]])
        .filter(|p| !p.trim().is_empty())
        .collect();
    if pieces.len() < 2 {
        return Err(err(
            ErrorCode::TypeMismatch,
            "split must yield ≥2 non-empty fragments",
        ));
    }
    let (kind, attrs) = {
        let block = doc.block_mut(&path);
        block.raw = pieces[0].to_owned();
        block.dirty = true;
        (block.kind.clone(), block.attrs.clone())
    };
    let mut new_blocks: Vec<MutBlock> = pieces[1..]
        .iter()
        .map(|p| MutBlock {
            id: minter.mint(),
            kind: kind.clone(),
            raw: (*p).to_owned(),
            trivia: "\n\n".to_owned(),
            attrs: attrs.clone(),
            children: Vec::new(),
            dirty: true,
        })
        .collect();
    let mut ids = vec![block_id.to_owned()];
    ids.extend(new_blocks.iter().map(|b| b.id.clone()));
    let (index, parent) = path.split_last().expect("non-empty");
    // Seams exactly as update's extra siblings: the block's trailing trivia
    // moves to the last piece; at the top level every earlier piece separates.
    let format = doc.format.clone();
    let tail_trivia = doc.block(&path).trivia.clone();
    if parent.is_empty() {
        let sep = default_trivia(&format);
        let block = doc.block_mut(&path);
        if !separates_blocks(&block.trivia, &format) {
            block.trivia = sep.to_owned();
        }
        let n = new_blocks.len();
        for b in &mut new_blocks[..n - 1] {
            if !separates_blocks(&b.trivia, &format) {
                b.trivia = sep.to_owned();
            }
        }
    }
    new_blocks.last_mut().expect("non-empty").trivia = tail_trivia;
    let siblings = doc.siblings_mut(parent);
    let rest = siblings.split_off(index + 1);
    siblings.extend(new_blocks);
    siblings.extend(rest);
    doc.mark_container_dirty(parent);
    Ok(OpResult::ids(ids))
}

/// §2.6 `merge`.
pub fn op_merge(
    doc: &mut MutDoc,
    block_ids: &[String],
    op_index: usize,
    separator: Option<&str>,
    expect_per: Option<&BTreeMap<String, Expect>>,
) -> Result<OpResult> {
    if block_ids.len() < 2 {
        return Err(err(ErrorCode::NotContiguous, "merge requires ≥2 blocks"));
    }
    let separator = separator.unwrap_or(" ");
    let mut paths = Vec::with_capacity(block_ids.len());
    for id in block_ids {
        let path = doc.locate(id).ok_or_else(|| {
            err_data(
                ErrorCode::BlockMissing,
                format!("block {id} not found"),
                json!({ "op_index": op_index, "block": id }),
            )
        })?;
        paths.push(path);
    }
    let (first_index, parent) = paths[0].split_last().expect("non-empty");
    let parent = parent.to_vec();
    let kind = doc.block(&paths[0]).kind.clone();
    let mut indices = vec![*first_index];
    for (i, path) in paths.iter().enumerate() {
        let (index, p) = path.split_last().expect("non-empty");
        if p != parent.as_slice() {
            return Err(err_data(
                ErrorCode::NotContiguous,
                "merge blocks must share a parent",
                json!({ "op_index": op_index }),
            ));
        }
        if doc.block(path).kind != kind {
            return Err(err_data(
                ErrorCode::TypeMismatch,
                "merge blocks must share a type",
                json!({ "op_index": op_index }),
            ));
        }
        if let Some(e) = expect_per.and_then(|m| m.get(&block_ids[i])) {
            check_content_hash(doc.block(path), Some(e), op_index)?;
            // §1.2: its current parent (the shared sibling list).
            check_children_hash(doc.siblings(p), Some(e), op_index)?;
        }
        if i > 0 {
            indices.push(*index);
        }
    }
    indices.sort_unstable();
    if indices.windows(2).any(|w| w[1] != w[0] + 1) {
        return Err(err_data(
            ErrorCode::NotContiguous,
            "merge blocks must be contiguous",
            json!({ "op_index": op_index }),
        ));
    }
    let siblings = doc.siblings_mut(&parent);
    let raws: Vec<String> = indices.iter().map(|&i| siblings[i].raw.clone()).collect();
    let first = indices[0];
    siblings[first].raw = raws.join(separator);
    siblings[first].dirty = true;
    let merged_into: Vec<String> = indices[1..]
        .iter()
        .map(|&i| siblings[i].id.clone())
        .collect();
    for &i in indices[1..].iter().rev() {
        siblings.remove(i);
    }
    Ok(OpResult {
        ids: vec![siblings[first].id.clone()],
        removed: None,
        merged_into: Some(merged_into),
    })
}

// ---- cross-document move (§2.3) ------------------------------------------------------

fn resolve_dst_target(dst: &MutDoc, to: &To, op_index: usize) -> Result<Target> {
    match &to.parent {
        Parent::Doc | Parent::Section { .. } => Ok(Target {
            parent: Vec::new(),
            index: resolve_index(&dst.children, &to.at)?,
        }),
        Parent::Block(id) => {
            let path = dst.locate(id).ok_or_else(|| {
                err(
                    ErrorCode::ParentMissing,
                    format!("parent {id} not found in dest"),
                )
            })?;
            require_container(dst, &path, op_index)?;
            let index = resolve_index(&dst.block(&path).children, &to.at)?;
            Ok(Target {
                parent: path,
                index,
            })
        }
    }
}

/// §2.3 cross-document: extract the blocks from `src`, insert them at the
/// destination's resolved target in `dst`; both owners marked dirty, both
/// documents' top-level seams healed.
pub fn cross_doc_move(
    src: &mut MutDoc,
    dst: &mut MutDoc,
    block_ids: &[String],
    to: &To,
    op_index: usize,
    expect: Option<&Expect>,
) -> Result<OpResult> {
    for id in block_ids {
        if !src.contains(id) {
            return Err(err_data(
                ErrorCode::BlockMissing,
                format!("block {id} not found in source doc"),
                json!({ "op_index": op_index }),
            ));
        }
    }
    // The destination resolves before either tree moves (a leaf parent is
    // §1.1 `type_mismatch`), then §1.2: its order CAS.
    let Target { parent, .. } = resolve_dst_target(dst, to, op_index)?;
    check_children_hash(dst.siblings(&parent), expect, op_index)?;
    let mut moving = Vec::with_capacity(block_ids.len());
    for id in block_ids {
        if let Some(path) = src.locate(id) {
            let (index, parent) = path.split_last().expect("non-empty");
            moving.push(src.siblings_mut(parent).remove(*index));
            src.mark_container_dirty(parent);
        }
    }
    let Target { parent, index } = resolve_dst_target(dst, to, op_index)?;
    {
        let siblings = dst.siblings_mut(&parent);
        let tail = siblings.split_off(index);
        siblings.extend(moving);
        siblings.extend(tail);
    }
    dst.mark_container_dirty(&parent);
    // Both documents' top-level seams heal: a block that was last in its
    // source carries a lone "\n", and the source's new last block may now be
    // followed by nothing.
    heal_top_level_seams(src);
    heal_top_level_seams(dst);
    Ok(OpResult::ids(block_ids.to_vec()))
}

/// The six ops as methods (two-phase borrows let a caller compute ids from
/// the document inside the argument list).
impl MutDoc {
    /// [`op_insert`] without the §1.2 order CAS (`op_index` 0).
    pub fn insert(&mut self, to: &To, markdown: &str, minter: &mut dyn Minter) -> Result<OpResult> {
        op_insert(self, to, markdown, 0, None, minter)
    }

    /// [`op_update`].
    pub fn update(
        &mut self,
        block_id: &str,
        op_index: usize,
        args: &UpdateArgs,
        minter: &mut dyn Minter,
    ) -> Result<OpResult> {
        op_update(self, block_id, op_index, args, minter)
    }

    /// [`op_move`] without the §1.2 order CAS.
    pub fn move_blocks(
        &mut self,
        block_ids: &[String],
        to: &To,
        op_index: usize,
    ) -> Result<OpResult> {
        op_move(self, block_ids, to, op_index, None)
    }

    /// [`op_remove`].
    pub fn remove(
        &mut self,
        block_ids: &[String],
        op_index: usize,
        expect_per: Option<&BTreeMap<String, Expect>>,
    ) -> Result<OpResult> {
        op_remove(self, block_ids, op_index, expect_per)
    }

    /// [`op_split`].
    pub fn split(
        &mut self,
        block_id: &str,
        at: &[usize],
        op_index: usize,
        expect: Option<&Expect>,
        minter: &mut dyn Minter,
    ) -> Result<OpResult> {
        op_split(self, block_id, at, op_index, expect, minter)
    }

    /// [`op_merge`].
    pub fn merge(
        &mut self,
        block_ids: &[String],
        op_index: usize,
        separator: Option<&str>,
        expect_per: Option<&BTreeMap<String, Expect>>,
    ) -> Result<OpResult> {
        op_merge(self, block_ids, op_index, separator, expect_per)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::render;
    use omgbase_reconcile::SequentialMinter;

    /// A document from Markdown, ids `b_0…` in pre-order (mirrors the
    /// reference's test helper).
    fn doc(markdown: &str) -> (MutDoc, SequentialMinter) {
        let mut m = SequentialMinter::new("b");
        let tree = parse_markdown(markdown);
        let children = tree
            .children
            .iter()
            .filter(|b| b.kind != BlockKind::Frontmatter)
            .map(|b| {
                let mut mb = to_mut(b, "", &mut m);
                fn keep_trivia(b: &mut MutBlock, src: &Block) {
                    b.trivia = src.trivia.clone();
                    for (c, s) in b.children.iter_mut().zip(&src.children) {
                        keep_trivia(c, s);
                    }
                }
                keep_trivia(&mut mb, b);
                mb
            })
            .collect();
        let mut d = MutDoc::new("d_1", "a.md", children);
        d.leading_trivia = tree.leading_trivia;
        (d, m)
    }

    fn id_at(d: &MutDoc, i: usize) -> String {
        d.children[i].id.clone()
    }

    fn hash_at(d: &MutDoc, i: usize) -> Expect {
        Expect::content(raw_hash_hex(&d.children[i].raw))
    }

    fn top(at: At) -> To {
        To {
            parent: Parent::Doc,
            at,
        }
    }

    #[test]
    fn insert_adds_blocks_and_returns_minted_ids() {
        let (mut d, mut m) = doc("# Title\n\nTail.\n");
        let r = d
            .insert(&top(At::After(id_at(&d, 0))), "Inserted paragraph.", &mut m)
            .unwrap();
        assert_eq!(r.ids, ["b_2"]);
        assert_eq!(d.children[1].id, "b_2");
        assert_eq!(render(&d), "# Title\n\nInserted paragraph.\n\nTail.\n");
    }

    #[test]
    fn insert_heals_seams_at_the_top_level() {
        let (mut d, mut m) = doc("# H\n\nbody");
        d.insert(&top(At::After(id_at(&d, 1))), "new para", &mut m)
            .unwrap();
        assert_eq!(render(&d), "# H\n\nbody\n\nnew para\n");
        let (mut d, mut m) = doc("# H\n\nfirst\n\nsecond\n");
        d.insert(
            &top(At::After(id_at(&d, 1))),
            "## Mid\n\nmid body\n",
            &mut m,
        )
        .unwrap();
        assert_eq!(render(&d), "# H\n\nfirst\n\n## Mid\n\nmid body\n\nsecond\n");
        // An empty parse inserts nothing.
        let (mut d, mut m) = doc("a\n");
        let r = d.insert(&top(At::End), "", &mut m).unwrap();
        assert!(r.ids.is_empty());
        // The seam before the (empty) run is still healed, as the reference does.
        assert_eq!(render(&d), "a\n\n");
    }

    #[test]
    fn insert_into_a_list_unwraps_items_and_wraps_bare_blocks() {
        let (mut d, mut m) = doc("# T\n\n- one\n- two\n");
        let list = id_at(&d, 1);
        let two = d.children[1].children[1].id.clone();
        let r = d
            .insert(
                &To {
                    parent: Parent::Block(list.clone()),
                    at: At::After(two),
                },
                "- three",
                &mut m,
            )
            .unwrap();
        // The list wrapper minted b_4 (unused); its item is b_5 (§10).
        assert_eq!(r.ids, ["b_5"]);
        assert_eq!(render(&d), "# T\n\n- one\n- two\n- three\n");
        let r = d
            .insert(
                &To {
                    parent: Parent::Block(list),
                    at: At::Start,
                },
                "zero",
                &mut m,
            )
            .unwrap();
        assert_eq!(r.ids, ["b_7"], "paragraph b_6, wrapper item b_7");
        assert_eq!(render(&d), "# T\n\n- zero\n- one\n- two\n- three\n");
    }

    #[test]
    fn insert_errors() {
        let (mut d, mut m) = doc("a\n");
        let e = d
            .insert(
                &To {
                    parent: Parent::Block("nope".into()),
                    at: At::End,
                },
                "x",
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::ParentMissing);
        let e = d
            .insert(&top(At::Before("nope".into())), "x", &mut m)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TargetMissing);
        let e = d
            .insert(
                &To {
                    parent: Parent::Section {
                        heading: "nope".into(),
                    },
                    at: At::End,
                },
                "x",
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TargetMissing);
    }

    #[test]
    fn section_placement() {
        let (mut d, mut m) = doc("# A\n\na1\n\n## B\n\nb1\n\n# C\n\nc1\n");
        let a = id_at(&d, 0);
        d.insert(
            &To {
                parent: Parent::Section { heading: a.clone() },
                at: At::End,
            },
            "a-end",
            &mut m,
        )
        .unwrap();
        assert_eq!(
            render(&d),
            "# A\n\na1\n\n## B\n\nb1\n\na-end\n\n# C\n\nc1\n"
        );
        d.insert(
            &To {
                parent: Parent::Section { heading: a },
                at: At::Start,
            },
            "a-start",
            &mut m,
        )
        .unwrap();
        assert!(render(&d).starts_with("# A\n\na-start\n\na1\n"));
    }

    #[test]
    fn update_requires_cas_and_replaces_in_place() {
        let (mut d, mut m) = doc("# Title\n\nOld body.\n");
        let b = id_at(&d, 1);
        let e = d
            .update(
                &b,
                0,
                &UpdateArgs {
                    markdown: Some("New body.".into()),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleExpectation);
        assert_eq!(e.data["retriable"], json!(true));
        assert_eq!(e.data["current"]["markdown"], json!("Old body."));
        d.update(
            &b,
            0,
            &UpdateArgs {
                markdown: Some("New body.".into()),
                expect: Some(hash_at(&d, 1)),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        assert_eq!(d.children[1].raw, "New body.");
        assert_eq!(d.children[1].id, b);
        assert_eq!(render(&d), "# Title\n\nNew body.\n");
    }

    #[test]
    fn update_rejects_a_stale_hash_with_current_truth() {
        let (mut d, mut m) = doc("para one\n");
        let e = d
            .update(
                &id_at(&d, 0),
                3,
                &UpdateArgs {
                    markdown: Some("x".into()),
                    expect: Some(Expect::content("deadbeef")),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleExpectation);
        assert_eq!(e.data["op_index"], json!(3));
        assert_eq!(e.data["expected_content_hash"], json!("deadbeef"));
        assert_eq!(e.data["current"]["markdown"], json!("para one"));
        let e = d
            .update("b_9", 1, &UpdateArgs::default(), &mut m)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::BlockMissing);
        assert_eq!(e.data["block"], json!("b_9"));
    }

    #[test]
    fn update_with_multi_block_content_adds_siblings() {
        let (mut d, mut m) = doc("# Title\n\nOld body.\n\nTail.\n");
        let b = id_at(&d, 1);
        let tail = id_at(&d, 2);
        let r = d
            .update(
                &b,
                0,
                &UpdateArgs {
                    markdown: Some("New body.\n\n- one\n- two\n\n## Sub".into()),
                    expect: Some(hash_at(&d, 1)),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap();
        assert_eq!(r.ids.len(), 3);
        assert_eq!(r.ids[0], b);
        let ids: Vec<&str> = d.children.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["b_0", "b_1", "b_4", "b_7", "b_2"]);
        assert_eq!(ids[4], tail);
        let kinds: Vec<&str> = d.children.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(
            kinds,
            ["heading", "paragraph", "list", "heading", "paragraph"]
        );
        assert_eq!(
            render(&d),
            "# Title\n\nNew body.\n\n- one\n- two\n\n## Sub\n\nTail.\n"
        );
    }

    #[test]
    fn update_of_a_list_item() {
        let (mut d, mut m) = doc("- a\n- c\n");
        let a = d.children[0].children[0].id.clone();
        let c = d.children[0].children[1].id.clone();
        let r = d
            .update(
                &a,
                0,
                &UpdateArgs {
                    markdown: Some("- a1\n- b".into()),
                    expect: Some(Expect::content(raw_hash_hex("- a"))),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap();
        assert_eq!(r.ids.len(), 2);
        assert_eq!(r.ids[0], a);
        let ids: Vec<&str> = d.children[0]
            .children
            .iter()
            .map(|b| b.id.as_str())
            .collect();
        assert_eq!(ids, [a.as_str(), r.ids[1].as_str(), c.as_str()]);
        assert_eq!(render(&d), "- a1\n- b\n- c\n");
        // A bare block keeps the item a bullet.
        let r = d
            .update(
                &c,
                1,
                &UpdateArgs {
                    markdown: Some("c edited".into()),
                    expect: Some(Expect::content(raw_hash_hex("- c"))),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap();
        assert_eq!(r.ids, std::slice::from_ref(&c));
        assert_eq!(render(&d), "- a1\n- b\n- c edited\n");
        // Two blocks are a type_mismatch for an item.
        let e = d
            .update(
                &c,
                2,
                &UpdateArgs {
                    markdown: Some("x\n\ny".into()),
                    expect: Some(Expect::content(raw_hash_hex("- c edited"))),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
        assert_eq!(e.data["op_index"], json!(2));
    }

    #[test]
    fn update_attrs_checked_retypes_to_task() {
        let (mut d, mut m) = doc("- [ ] do the thing\n- plain\n");
        let item = d.children[0].children[0].id.clone();
        let mut attrs = Map::new();
        attrs.insert("checked".into(), json!(true));
        d.update(
            &item,
            0,
            &UpdateArgs {
                attrs: Some(attrs.clone()),
                expect: Some(Expect::content(raw_hash_hex("- [ ] do the thing"))),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        assert_eq!(render(&d), "- [x] do the thing\n- plain\n");
        let plain = d.children[0].children[1].id.clone();
        d.update(
            &plain,
            1,
            &UpdateArgs {
                attrs: Some(attrs),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        assert_eq!(d.children[0].children[1].kind, "task");
        assert_eq!(d.children[0].children[1].attrs["checked"], json!(true));
        assert_eq!(render(&d), "- [x] do the thing\n- plain\n");
    }

    #[test]
    fn update_trivia_and_child_ids() {
        let (mut d, mut m) = doc("# T\n\n- one\n- two\n");
        let list = id_at(&d, 1);
        let one = d.children[1].children[0].id.clone();
        let mut child_ids = BTreeMap::new();
        child_ids.insert("/0".to_owned(), one.clone());
        d.update(
            &list,
            0,
            &UpdateArgs {
                markdown: Some("- one\n- two changed".into()),
                expect: Some(hash_at(&d, 1)),
                child_ids: Some(child_ids),
                trivia: Some("\n\n\n".into()),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        assert_eq!(d.children[1].children[0].id, one);
        assert_ne!(d.children[1].children[1].id, "b_3");
        assert_eq!(render(&d), "# T\n\n- one\n- two changed\n\n\n");
        let e = d
            .update(
                &list,
                1,
                &UpdateArgs {
                    markdown: Some("a\n\nb".into()),
                    expect: Some(Expect::content(raw_hash_hex("- one\n- two changed"))),
                    child_ids: Some(BTreeMap::new()),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
        let e = d
            .update(
                &list,
                1,
                &UpdateArgs {
                    markdown: Some("".into()),
                    expect: Some(Expect::content(raw_hash_hex("- one\n- two changed"))),
                    ..Default::default()
                },
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
    }

    #[test]
    fn nested_updates_rebuild_blockquote_and_table() {
        let (mut d, mut m) =
            doc("> first para\n>\n> second para\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n");
        let inner = d.children[0].children[1].clone();
        d.update(
            &inner.id,
            0,
            &UpdateArgs {
                markdown: Some("second para edited".into()),
                expect: Some(Expect::content(raw_hash_hex(&inner.raw))),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        let row = d.children[1].children[2].clone();
        d.update(
            &row.id,
            1,
            &UpdateArgs {
                markdown: Some("| 3 | 40 |".into()),
                expect: Some(Expect::content(raw_hash_hex(&row.raw))),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        assert_eq!(
            render(&d),
            "> first para\n>\n> second para edited\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 40 |\n"
        );
    }

    #[test]
    fn whole_blockquote_and_table_updates_render_verbatim() {
        let (mut d, mut m) = doc("# H\n\n> old quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        d.update(
            &id_at(&d, 1),
            0,
            &UpdateArgs {
                markdown: Some("> new quote\n> more".into()),
                expect: Some(hash_at(&d, 1)),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        d.update(
            &id_at(&d, 2),
            1,
            &UpdateArgs {
                markdown: Some("| c | d |\n|---|---|\n| 3 | 4 |".into()),
                expect: Some(hash_at(&d, 2)),
                ..Default::default()
            },
            &mut m,
        )
        .unwrap();
        assert_eq!(
            render(&d),
            "# H\n\n> new quote\n> more\n\n| c | d |\n|---|---|\n| 3 | 4 |\n"
        );
    }

    #[test]
    fn move_relocates_a_run_and_heals_seams() {
        let (mut d, _) = doc("# A\n\nfirst\n\nsecond\n\n## B\n");
        let first = id_at(&d, 1);
        d.move_blocks(std::slice::from_ref(&first), &top(At::End), 0)
            .unwrap();
        assert_eq!(d.children.last().unwrap().id, first);
        // Every non-last seam is healed; the moved block keeps its own trivia.
        assert_eq!(render(&d), "# A\n\nsecond\n\n## B\n\nfirst\n\n");
        let (mut d, _) = doc("a\n\nb\n\nc\n");
        let e = d
            .move_blocks(&[id_at(&d, 0), id_at(&d, 2)], &top(At::Start), 0)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::NotContiguous);
        let e = d.move_blocks(&[], &top(At::Start), 0).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotContiguous);
        let e = d
            .move_blocks(&["zz".into()], &top(At::Start), 4)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::BlockMissing);
        assert_eq!(e.data["op_index"], json!(4));
    }

    #[test]
    fn move_rejects_a_cycle() {
        let (mut d, _) = doc("- parent\n  - child\n");
        let list = id_at(&d, 0);
        let item = d.children[0].children[0].id.clone();
        let e = d
            .move_blocks(
                &[list],
                &To {
                    parent: Parent::Block(item),
                    at: At::End,
                },
                0,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::CycleMove);
    }

    #[test]
    fn insert_into_a_leaf_is_type_mismatch() {
        // §1.1 (1.2): before, the block landed in the heading's empty
        // children and the heading's own text was lost on re-render.
        let (mut d, mut m) = doc("## Risks\n\nBody.\n");
        let heading = id_at(&d, 0);
        let e = d
            .insert(
                &To {
                    parent: Parent::Block(heading.clone()),
                    at: At::End,
                },
                "Under risks.",
                &mut m,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
        assert_eq!(
            e.message,
            format!(
                "{heading} is a heading, not a container; place relative to it with at.before/at.after or append to its section"
            )
        );
        assert_eq!(
            Value::Object(e.data),
            json!({ "op_index": 0, "block": heading, "type": "heading" })
        );
        assert_eq!(render(&d), "## Risks\n\nBody.\n");
        // A container parent still takes the insert.
        let (mut d, mut m) = doc("> quoted\n");
        let quote = id_at(&d, 0);
        d.insert(
            &To {
                parent: Parent::Block(quote),
                at: At::End,
            },
            "more",
            &mut m,
        )
        .unwrap();
        assert_eq!(d.children[0].children.len(), 2);
    }

    #[test]
    fn move_into_a_leaf_is_type_mismatch_before_the_tree_moves() {
        let (mut d, _) = doc("Para.\n\n- item\n");
        let para = id_at(&d, 0);
        let item = d.children[1].children[0].id.clone();
        let e = d
            .move_blocks(
                &[item],
                &To {
                    parent: Parent::Block(para.clone()),
                    at: At::Start,
                },
                3,
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
        assert_eq!(
            Value::Object(e.data),
            json!({ "op_index": 3, "block": para, "type": "paragraph" })
        );
        // Nothing was extracted: the source list still has its item.
        assert_eq!(render(&d), "Para.\n\n- item\n");
    }

    #[test]
    fn cross_doc_move_into_a_leaf_is_type_mismatch() {
        let (mut src, _) = doc("- item\n");
        let (mut dst, _) = doc("# Title\n\n- other\n");
        let item = src.children[0].children[0].id.clone();
        let title = id_at(&dst, 0);
        let e = cross_doc_move(
            &mut src,
            &mut dst,
            std::slice::from_ref(&item),
            &To {
                parent: Parent::Block(title.clone()),
                at: At::End,
            },
            1,
            None,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
        assert_eq!(
            Value::Object(e.data),
            json!({ "op_index": 1, "block": title, "type": "heading" })
        );
        assert_eq!(render(&src), "- item\n");
        assert_eq!(render(&dst), "# Title\n\n- other\n");
        // The list in `dst` is a container: the same move lands.
        let list = id_at(&dst, 1);
        cross_doc_move(
            &mut src,
            &mut dst,
            &[item],
            &To {
                parent: Parent::Block(list),
                at: At::End,
            },
            1,
            None,
        )
        .unwrap();
        assert_eq!(render(&dst), "# Title\n\n- other\n- item\n");
    }

    #[test]
    fn container_kinds_by_format() {
        // Markdown: the format layer's kind table decides, children or not.
        let (d, _) = doc(
            "# H\n\npara\n\n- [ ] task\n\n> quote\n\n| a |\n| - |\n| 1 |\n\n```\ncode\n```\n\n---\n\n<div></div>\n",
        );
        let verdicts: Vec<(&str, bool)> = d
            .children
            .iter()
            .map(|b| (b.kind.as_str(), is_container("markdown", b)))
            .collect();
        assert_eq!(
            verdicts,
            [
                ("heading", false),
                ("paragraph", false),
                ("list", true),
                ("blockquote", true),
                ("table", true),
                ("code_fence", false),
                ("thematic_break", false),
                ("html_block", false),
            ]
        );
        let list = &d.children[2];
        assert!(is_container("markdown", &list.children[0])); // task
        assert!(!is_container("markdown", &d.children[4].children[0])); // table_row
        let empty_quote = MutBlock::new("b_q", "blockquote", ">", "\n\n");
        assert!(is_container("markdown", &empty_quote));
        // Other formats have no kind table: a block with children is a
        // container, a childless one is a leaf — whatever its kind says.
        let leaf = MutBlock::new("b_1", "opaque", "k: v", "\n");
        assert!(!is_container("yaml", &leaf));
        let mut node = MutBlock::new("b_2", "opaque", "k:", "\n");
        node.children
            .push(MutBlock::new("b_3", "opaque", "  a: 1", "\n"));
        assert!(is_container("yaml", &node));
        assert!(is_container("json", &node));
        assert!(!is_container("markdown", &node));
    }

    #[test]
    fn move_within_a_list_renumbers() {
        let (mut d, _) = doc("# T\n\n1. alpha\n2. bravo\n3. gamma\n");
        let list = id_at(&d, 1);
        let alpha = d.children[1].children[0].id.clone();
        let gamma = d.children[1].children[2].id.clone();
        d.move_blocks(
            &[gamma],
            &To {
                parent: Parent::Block(list),
                at: At::Before(alpha),
            },
            0,
        )
        .unwrap();
        assert_eq!(render(&d), "# T\n\n1. gamma\n2. alpha\n3. bravo\n");
    }

    #[test]
    fn remove_collapses_to_tops_and_prunes_empty_containers() {
        let (mut d, _) = doc("# A\n\ndoomed\n\ntail\n");
        let r = d.remove(&[id_at(&d, 1)], 0, None).unwrap();
        assert_eq!(r.removed, Some(vec!["b_1".to_owned()]));
        assert_eq!(render(&d), "# A\n\ntail\n");
        let (mut d, _) = doc("# T\n\n- only\n");
        let only = d.children[1].children[0].id.clone();
        let r = d.remove(&[only.clone(), only.clone()], 0, None).unwrap();
        assert_eq!(r.ids.len(), 2);
        assert_eq!(render(&d), "# T\n\n");
        let (mut d, _) = doc("- a\n  - b\n");
        let list = id_at(&d, 0);
        let item = d.children[0].children[0].id.clone();
        let r = d.remove(&[item, list.clone()], 0, None).unwrap();
        assert!(r.removed.unwrap().len() >= 4);
        assert!(d.children.is_empty());
        let (mut d, _) = doc("# T\n\n- one\n- two\n- three\n");
        let two = d.children[1].children[1].id.clone();
        d.remove(&[two], 0, None).unwrap();
        assert_eq!(render(&d), "# T\n\n- one\n- three\n");
        let e = d.remove(&["zz".into()], 2, None).unwrap_err();
        assert_eq!(e.code, ErrorCode::BlockMissing);
        assert_eq!(e.data["op_index"], json!(2));
        let mut per = BTreeMap::new();
        per.insert(id_at(&d, 0), Expect::content("bad"));
        let e = d.remove(&[id_at(&d, 0)], 3, Some(&per)).unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleExpectation);
    }

    #[test]
    fn split_cuts_at_byte_offsets() {
        let (mut d, mut m) = doc("first sentence. second sentence.\n");
        let b = id_at(&d, 0);
        let cut = d.children[0].raw.find("second").unwrap();
        let r = d
            .split(&b, &[cut], 0, Some(&hash_at(&d, 0)), &mut m)
            .unwrap();
        assert_eq!(r.ids, [b.clone(), "b_1".to_owned()]);
        assert_eq!(d.children[0].raw, "first sentence. ");
        assert_eq!(d.children[1].raw, "second sentence.");
        assert_eq!(d.children[1].trivia, "\n");
        // The block's trailing trivia moves to the last piece; the seam separates.
        assert_eq!(render(&d), "first sentence. \n\nsecond sentence.\n");
        let (mut d, mut m) = doc("héllo wörld — café tail\n");
        d.split(&id_at(&d, 0), &[24], 0, Some(&hash_at(&d, 0)), &mut m)
            .unwrap();
        assert_eq!(d.children[0].raw, "héllo wörld — café ");
        assert_eq!(d.children[1].raw, "tail");
        let (mut d, mut m) = doc("aé b\n");
        d.split(&id_at(&d, 0), &[2], 0, Some(&hash_at(&d, 0)), &mut m)
            .unwrap();
        let raws: Vec<&str> = d.children.iter().map(|b| b.raw.as_str()).collect();
        assert_eq!(raws, ["a", "é b"]);
        let e = d
            .split("b_0", &[0, 99], 1, Some(&hash_at(&d, 0)), &mut m)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
        let e = d.split("b_0", &[1], 1, None, &mut m).unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleExpectation);
        let e = d.split("zz", &[1], 1, None, &mut m).unwrap_err();
        assert_eq!(e.code, ErrorCode::BlockMissing);
    }

    #[test]
    fn merge_joins_contiguous_same_type_siblings() {
        let (mut d, _) = doc("alpha\n\nbeta\n");
        let first = id_at(&d, 0);
        let r = d
            .merge(&[id_at(&d, 0), id_at(&d, 1)], 0, None, None)
            .unwrap();
        assert_eq!(r.ids, [first]);
        assert_eq!(r.merged_into, Some(vec!["b_1".to_owned()]));
        assert_eq!(d.children.len(), 1);
        assert_eq!(d.children[0].raw, "alpha beta");
        let (mut d, _) = doc("# h\n\np\n\nq\n");
        let e = d
            .merge(&[id_at(&d, 0), id_at(&d, 1)], 0, None, None)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::TypeMismatch);
        let e = d.merge(&[id_at(&d, 1)], 0, None, None).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotContiguous);
        let (mut d, _) = doc("a\n\nb\n\nc\n");
        let e = d
            .merge(&[id_at(&d, 0), id_at(&d, 2)], 0, None, None)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::NotContiguous);
        let r = d
            .merge(&[id_at(&d, 2), id_at(&d, 1)], 0, Some("\n"), None)
            .unwrap();
        assert_eq!(r.ids, ["b_1"]);
        assert_eq!(d.children[1].raw, "b\nc");
    }

    #[test]
    fn cross_doc_move_extracts_and_inserts() {
        let (mut a, _) = doc("# A\n\nmoving\n");
        let (mut b, _) = doc("# B\n");
        let moving = id_at(&a, 1);
        let r = cross_doc_move(
            &mut a,
            &mut b,
            std::slice::from_ref(&moving),
            &top(At::End),
            0,
            None,
        )
        .unwrap();
        assert_eq!(r.ids, std::slice::from_ref(&moving));
        assert_eq!(render(&a), "# A\n\n");
        // Both documents' top-level seams heal (§2.3).
        assert_eq!(render(&b), "# B\n\nmoving\n");
        let e = cross_doc_move(&mut a, &mut b, &[moving], &top(At::End), 1, None).unwrap_err();
        assert_eq!(e.code, ErrorCode::BlockMissing);
    }

    #[test]
    fn parent_children_hash_check() {
        let (d, _) = doc("a\n\nb\n");
        let ok = parent_children_hash(&d.children);
        check_parent_children_hash(&d, None, &ok, 0).unwrap();
        let e = check_parent_children_hash(&d, None, "nope", 0).unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleExpectation);
        assert_eq!(e.data["current"]["parent_children_hash"], json!(ok));
    }

    /// §1.2 wiring: insert/move check the destination parent, the others the
    /// block's current parent; content CAS first; a stale order never lands.
    #[test]
    fn parent_children_hash_guards_every_op() {
        let (mut d, mut m) = doc("# T\n\na\n\n> q1\n>\n> q2\n");
        let top_hash = parent_children_hash(&d.children);
        let quote_hash = parent_children_hash(&d.children[2].children);
        let a = id_at(&d, 1);
        let quote = id_at(&d, 2);
        let stale = Expect::order("stale");
        // insert: destination parent = the blockquote, not the top level.
        let into_quote = To {
            parent: Parent::Block(quote.clone()),
            at: At::End,
        };
        let e = op_insert(
            &mut d,
            &into_quote,
            "x",
            3,
            Some(&Expect::order(&top_hash)),
            &mut m,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleExpectation);
        assert_eq!(e.data["op_index"], json!(3));
        assert_eq!(e.data["current"]["parent_children_hash"], json!(quote_hash));
        assert_eq!(e.data.get("block"), None);
        assert_eq!(d.children[2].children.len(), 2, "nothing inserted");
        // move: destination checked on the pre-removal tree, once for the run.
        let e = op_move(
            &mut d,
            std::slice::from_ref(&a),
            &into_quote,
            0,
            Some(&stale),
        )
        .unwrap_err();
        assert_eq!(e.data["current"]["parent_children_hash"], json!(quote_hash));
        assert_eq!(d.children.len(), 3, "nothing moved");
        op_move(
            &mut d,
            std::slice::from_ref(&a),
            &into_quote,
            0,
            Some(&Expect::order(&quote_hash)),
        )
        .unwrap();
        assert_eq!(d.children[1].children.len(), 3);
        // update/split/remove/merge: the block's CURRENT parent (now the quote),
        // and the content CAS comes first.
        let mut args = UpdateArgs {
            expect: Some(Expect {
                content_hash: Some("bad".into()),
                parent_children_hash: Some("stale".into()),
            }),
            ..UpdateArgs::default()
        };
        let e = op_update(&mut d, &a, 0, &args, &mut m).unwrap_err();
        assert_eq!(e.data["block"], json!(a), "content CAS reported first");
        args.expect = Some(Expect {
            content_hash: Some(raw_hash_hex("a")),
            parent_children_hash: Some(top_hash.clone()),
        });
        let e = op_update(&mut d, &a, 0, &args, &mut m).unwrap_err();
        let live = parent_children_hash(&d.children[1].children);
        assert_eq!(e.data["current"]["parent_children_hash"], json!(live));
        let ok = Expect {
            content_hash: Some(raw_hash_hex("a")),
            parent_children_hash: Some(live.clone()),
        };
        let e = op_split(&mut d, &a, &[1], 0, Some(&stale_with(&ok)), &mut m).unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleExpectation);
        let mut per = BTreeMap::new();
        per.insert(a.clone(), stale_with(&ok));
        let e = op_remove(&mut d, std::slice::from_ref(&a), 0, Some(&per)).unwrap_err();
        assert_eq!(e.data["current"]["parent_children_hash"], json!(live));
        let q2 = d.children[1].children[1].id.clone();
        let mut per = BTreeMap::new();
        per.insert(
            q2.clone(),
            Expect {
                content_hash: Some(raw_hash_hex("q2")),
                parent_children_hash: Some("stale".into()),
            },
        );
        let e = op_merge(&mut d, &[q2, a.clone()], 0, None, Some(&per)).unwrap_err();
        assert_eq!(e.data["current"]["parent_children_hash"], json!(live));
        // A matching order CAS passes.
        per.clear();
        per.insert(a.clone(), ok);
        op_remove(&mut d, &[a], 0, Some(&per)).unwrap();
        assert_eq!(d.children[1].children.len(), 2);
    }

    fn stale_with(ok: &Expect) -> Expect {
        Expect {
            content_hash: ok.content_hash.clone(),
            parent_children_hash: Some("stale".into()),
        }
    }
}
