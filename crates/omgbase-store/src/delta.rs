//! Delta tree nodes (`spec/store/README.md` §4.1 "Delta nodes", §4.4
//! "Checkpoints", §6, 16.0). Port of the reference's `core/store/delta.ts`.
//!
//! A sibling list — the body root, a container's children — and a revision's
//! frontmatter may be stored as a DELTA against the same list (the same
//! frontmatter) of the document's PREVIOUS revision (`revisions.seq − 1` of
//! the same `doc_id`; the base is implicit, no base hash is stored):
//!
//! ```text
//! tree_nodes.entries   full:   [ [block_id, raw_hash_hex, child, type, attrs, trivia], … ]   (15.x, unchanged)
//!                      delta:  {"d":[ op, … ]}
//! blobs.bytes (frontmatter)   full:   the frontmatter block's raw, `---…`              (15.x, unchanged)
//!                             delta:  {"f":[ op, … ]}
//! ```
//!
//! told apart by the FIRST BYTE (`[` / `-` full, `{` delta). An op is one of
//! `["=",n]` (keep the next n items of the base), `["+",x]` (insert x),
//! `["-"]` (drop the next base item), `["~",x]` (replace the next base item
//! with x); x is a six-element entry (body) or a line with its ending
//! (frontmatter), spliced verbatim. The ops consume exactly the base and are
//! Myers' shortest edit script ([`crate::edit_script`]) grouped. A node is a
//! delta only when the delta is strictly smaller than the full form, the
//! revision is not a CHECKPOINT (`(seq − 1) % 16 == 0`, the first revision, a
//! revision whose previous one is archived or missing), and a base exists at
//! the same position. A delta node is content-addressed like any node and
//! MEANINGFUL ONLY in the context of the revision that names it, so a revision
//! reuses a node of its predecessor only when that node is SELF-CONTAINED (a
//! `[`-form node whose every child list is) — else it writes the identity
//! delta `{"d":[["=",n]]}`.
//!
//! The GC mark (§7) is EXPLICIT: a node marks the objects its own text names
//! (every entry of a `[`-node, the `+`/`~` entries of a `{`-node); what a
//! delta keeps "as the base" is marked by the base revision, which the
//! base-liveness rule keeps live (the squash re-checkpoints a kept dependent,
//! [`crate::archive`]).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use omgbase_format::hash::{hex, sha256};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::edit_script::{EditOp, myers_script};
use crate::error::{Error, Result};
use crate::tree::{TreeEntry, from_hex, serialize_tree_entry};

/// The checkpoint cadence (§4.4 rule 1): revision `seq` is a checkpoint when
/// `(seq − 1) % CHECKPOINT_EVERY == 0` (1, 17, 33, …). Not a setting.
pub const CHECKPOINT_EVERY: i64 = 16;

/// §4.4 rule 1 alone — the writer adds "no base" and "base archived"
/// ([`crate::writers::is_checkpoint_revision`]).
#[must_use]
pub fn is_checkpoint_seq(seq: i64) -> bool {
    (seq - 1) % CHECKPOINT_EVERY == 0
}

/// One op over the base's positions; the payload is the item's TEXT (an
/// entry's canonical JSON, or a frontmatter line with its ending).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeltaOp {
    /// `["=",n]`: keep the next `n` ≥ 1 items of the base.
    Keep(usize),
    /// `["+",x]`: insert `x`.
    Insert(String),
    /// `["-"]`: drop the next item of the base.
    Drop,
    /// `["~",x]`: replace the next item of the base with `x`.
    Replace(String),
}

/// A parsed `tree_nodes.entries` text.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    /// The `[`-form: the entries themselves.
    Full(Vec<TreeEntry>),
    /// The `{"d":…}` form: ops over the same list of the previous revision.
    Delta(Vec<DeltaOp>),
}

/// A parsed frontmatter blob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrontmatterBlob {
    /// The raw (`---…`).
    Raw(String),
    /// The `{"f":…}` form: ops over the lines of the previous revision's raw.
    Delta(Vec<DeltaOp>),
}

/// Which form a stored node had.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    Full,
    Delta,
}

// ---- encodings ----------------------------------------------------------------------

/// An entry's canonical text — exactly the six-element array as §4.1
/// serializes it (the item a body delta is over).
#[must_use]
pub fn entry_text(e: &TreeEntry) -> String {
    serialize_tree_entry(e)
}

/// The full-form text of a sibling list from its entry texts.
#[must_use]
pub fn full_node_text(texts: &[String]) -> String {
    format!("[{}]", texts.join(","))
}

/// The delta text of `next` against `base` (both as the payload texts of
/// their items): Myers' shortest edit script over the texts, grouped — a run
/// of keeps is `["=",n]`; inside a run of edits the k-th deletion and the k-th
/// insertion pair into `["~",x]`, the surplus deletions are `["-"]` and the
/// surplus insertions `["+",x]`. `key` is `d` for a body node, `f` for a
/// frontmatter; `payload` renders an item's text into the op (verbatim for an
/// entry, JSON-quoted for a line).
pub fn encode_delta(
    base: &[String],
    next: &[String],
    key: char,
    payload: impl Fn(&str) -> String,
) -> String {
    let a: Vec<&str> = base.iter().map(String::as_str).collect();
    let b: Vec<&str> = next.iter().map(String::as_str).collect();
    let script = myers_script(&a, &b);
    let mut ops: Vec<String> = Vec::new();
    let mut i = 0;
    while i < script.len() {
        if matches!(script[i], EditOp::Keep(_)) {
            let mut n = 0;
            while i < script.len() && matches!(script[i], EditOp::Keep(_)) {
                n += 1;
                i += 1;
            }
            ops.push(format!("[\"=\",{n}]"));
            continue;
        }
        let mut deletes = 0usize;
        let mut inserts: Vec<&str> = Vec::new();
        while i < script.len() && !matches!(script[i], EditOp::Keep(_)) {
            match script[i] {
                EditOp::Delete(_) => deletes += 1,
                EditOp::Insert(l) => inserts.push(l),
                EditOp::Keep(_) => unreachable!(),
            }
            i += 1;
        }
        let paired = deletes.min(inserts.len());
        for ins in &inserts[..paired] {
            ops.push(format!("[\"~\",{}]", payload(ins)));
        }
        for _ in paired..deletes {
            ops.push("[\"-\"]".to_owned());
        }
        for ins in &inserts[paired..] {
            ops.push(format!("[\"+\",{}]", payload(ins)));
        }
    }
    format!("{{\"{key}\":[{}]}}", ops.join(","))
}

/// The delta of a body sibling list: entry texts spliced verbatim.
#[must_use]
pub fn encode_body_delta(base_texts: &[String], next_texts: &[String]) -> String {
    encode_delta(base_texts, next_texts, 'd', str::to_owned)
}

/// Lines of a text, each with its own line ending (`\n`, or `\r\n` — the
/// `\r` stays with its line); the last has none. `""` → `[""]`.
#[must_use]
pub fn split_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            out.push(text[start..=i].to_owned());
            start = i + 1;
        }
    }
    out.push(text[start..].to_owned());
    out
}

/// JSON-quote a string as `JSON.stringify` does (serde_json agrees on every
/// escape a UTF-8 text can need).
fn json_quote(s: &str) -> String {
    Value::String(s.to_owned()).to_string()
}

/// The delta of a frontmatter raw against the previous revision's raw:
/// lines, JSON-quoted (§4.1 "frontmatter delta").
#[must_use]
pub fn encode_frontmatter_delta(base_raw: &str, next_raw: &str) -> String {
    encode_delta(
        &split_lines(base_raw),
        &split_lines(next_raw),
        'f',
        json_quote,
    )
}

// ---- parsing ---------------------------------------------------------------------------

/// Parse one §4.1 entry from its JSON value; `None` when malformed.
#[must_use]
pub fn parse_entry(v: &Value) -> Option<TreeEntry> {
    let arr = v.as_array().filter(|a| a.len() == 6)?;
    let string = |i: usize| arr[i].as_str().map(str::to_owned);
    let optional = |i: usize| match &arr[i] {
        Value::Null => Some(None),
        Value::String(s) => Some(Some(s.clone())),
        _ => None,
    };
    if !arr[4].is_object() {
        return None;
    }
    Some(TreeEntry {
        block_id: string(0)?,
        raw_hash_hex: string(1)?,
        child_tree_hash_hex: optional(2)?,
        kind: string(3)?,
        attrs: arr[4].clone(),
        trivia_hash_hex: optional(5)?,
    })
}

fn parse_ops(v: &Value, payload: impl Fn(&Value) -> Option<String>) -> Option<Vec<DeltaOp>> {
    let items = v.as_array()?;
    let mut ops = Vec::with_capacity(items.len());
    for raw in items {
        let arr = raw.as_array()?;
        let tag = arr.first()?.as_str()?;
        match tag {
            "=" => {
                if arr.len() != 2 {
                    return None;
                }
                let n = arr[1].as_u64()?;
                if n == 0 || arr[1].is_f64() {
                    return None;
                }
                ops.push(DeltaOp::Keep(usize::try_from(n).ok()?));
            }
            "-" => {
                if arr.len() != 1 {
                    return None;
                }
                ops.push(DeltaOp::Drop);
            }
            "+" | "~" => {
                if arr.len() != 2 {
                    return None;
                }
                let x = payload(&arr[1])?;
                ops.push(if tag == "+" {
                    DeltaOp::Insert(x)
                } else {
                    DeltaOp::Replace(x)
                });
            }
            _ => return None,
        }
    }
    Some(ops)
}

/// Parse a `tree_nodes.entries` text: `[`-form entries or `{"d":…}` ops;
/// `None` when neither.
#[must_use]
pub fn parse_node_text(text: &str) -> Option<Node> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    match parsed {
        Value::Array(items) => {
            let mut entries = Vec::with_capacity(items.len());
            for e in &items {
                entries.push(parse_entry(e)?);
            }
            Some(Node::Full(entries))
        }
        Value::Object(map) => {
            if map.len() != 1 {
                return None;
            }
            let d = map.get("d")?;
            let ops = parse_ops(d, |x| parse_entry(x).map(|e| entry_text(&e)))?;
            Some(Node::Delta(ops))
        }
        _ => None,
    }
}

/// Parse a frontmatter blob's bytes: the raw (`-`-form) or `{"f":…}` ops;
/// `None` when a `{` text is not a valid delta.
#[must_use]
pub fn parse_frontmatter_blob(text: &str) -> Option<FrontmatterBlob> {
    if !text.starts_with('{') {
        return Some(FrontmatterBlob::Raw(text.to_owned()));
    }
    let parsed: Value = serde_json::from_str(text).ok()?;
    let map = parsed.as_object()?;
    if map.len() != 1 {
        return None;
    }
    let f = map.get("f")?;
    let ops = parse_ops(f, |x| x.as_str().map(str::to_owned))?;
    Some(FrontmatterBlob::Delta(ops))
}

/// Apply ops to a base (item texts); [`Error::Delta`] unless the ops consume
/// exactly the base.
pub fn apply_ops(ops: &[DeltaOp], base: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    for op in ops {
        match op {
            DeltaOp::Keep(n) => {
                if i + n > base.len() {
                    return Err(Error::Delta(format!(
                        "delta keeps {n} entries at position {i} of a base with {}",
                        base.len()
                    )));
                }
                out.extend(base[i..i + n].iter().cloned());
                i += n;
            }
            DeltaOp::Drop => {
                if i >= base.len() {
                    return Err(Error::Delta(format!(
                        "delta drops an entry past the end of a base with {}",
                        base.len()
                    )));
                }
                i += 1;
            }
            DeltaOp::Replace(x) => {
                if i >= base.len() {
                    return Err(Error::Delta(format!(
                        "delta replaces an entry past the end of a base with {}",
                        base.len()
                    )));
                }
                i += 1;
                out.push(x.clone());
            }
            DeltaOp::Insert(x) => out.push(x.clone()),
        }
    }
    if i != base.len() {
        return Err(Error::Delta(format!(
            "delta consumed {i} of {} base entries",
            base.len()
        )));
    }
    Ok(out)
}

/// The objects a node's text names on its own: every entry of a `[`-node,
/// the `+`/`~` entries of a `{`-node (§7, the explicit mark).
#[must_use]
pub fn explicit_entries(node: &Node) -> Vec<TreeEntry> {
    match node {
        Node::Full(entries) => entries.clone(),
        Node::Delta(ops) => ops
            .iter()
            .filter_map(|op| match op {
                DeltaOp::Insert(x) | DeltaOp::Replace(x) => serde_json::from_str::<Value>(x)
                    .ok()
                    .and_then(|v| parse_entry(&v)),
                _ => None,
            })
            .collect(),
    }
}

/// The blob hashes (raw + trivia) a list of entries names — the raws a
/// reconstruct reads, the mark's leaves.
pub fn entry_blobs(entries: &[TreeEntry], into: &mut HashSet<String>) {
    for e in entries {
        into.insert(e.raw_hash_hex.clone());
        if let Some(t) = &e.trivia_hash_hex {
            into.insert(t.clone());
        }
    }
}

// ---- resolution --------------------------------------------------------------------------

/// A sibling list resolved in its revision's context.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedList {
    /// The node row's hash (hex) as the revision references it — a `[` or `{` node.
    pub hash: String,
    pub form: Form,
    pub entries: Vec<TreeEntry>,
    /// `entries` as canonical texts (what a delta is encoded against).
    pub texts: Vec<String>,
    /// A `[`-form node whose every child list is self-contained:
    /// context-free, reusable by the next revision.
    pub self_contained: bool,
}

/// A revision's whole tree resolved: the root list and every container's
/// children by the container's block id.
#[derive(Clone, Debug)]
pub struct ResolvedTree {
    pub root: Rc<ResolvedList>,
    pub by_block: HashMap<String, Rc<ResolvedList>>,
}

struct RevRow {
    root_tree: Option<Vec<u8>>,
    frontmatter_blob: Option<Vec<u8>>,
    archive: Option<String>,
}

/// Resolves nodes in revision context, memoized per instance. `prefix` is
/// `""` for the store or `"<alias>."` for an archive segment — a segment
/// holds checkpoint forms only (§7.1), so a `{`-node there is an error rather
/// than a walk-back.
pub struct TreeResolver<'c> {
    conn: &'c Connection,
    prefix: String,
    lists: HashMap<String, Rc<ResolvedList>>,
    trees: HashMap<String, Rc<ResolvedTree>>,
    frontmatters: HashMap<String, String>,
}

impl<'c> TreeResolver<'c> {
    /// A resolver over the store's own tables.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self::with_prefix(conn, "")
    }

    /// A resolver over `<prefix>tree_nodes` / `<prefix>blobs` / `<prefix>revisions`.
    #[must_use]
    pub fn with_prefix(conn: &'c Connection, prefix: &str) -> Self {
        Self {
            conn,
            prefix: prefix.to_owned(),
            lists: HashMap::new(),
            trees: HashMap::new(),
            frontmatters: HashMap::new(),
        }
    }

    fn revision(&self, doc_id: &str, seq: i64) -> Result<Option<RevRow>> {
        let archive_col = if self.prefix.is_empty() {
            "archive"
        } else {
            "NULL AS archive"
        };
        Ok(self
            .conn
            .prepare_cached(&format!(
                "SELECT root_tree, frontmatter_blob, {archive_col} FROM {}revisions WHERE doc_id = ?1 AND seq = ?2",
                self.prefix
            ))?
            .query_row(params![doc_id, seq], |r| {
                Ok(RevRow {
                    root_tree: r.get(0)?,
                    frontmatter_blob: r.get(1)?,
                    archive: r.get(2)?,
                })
            })
            .optional()?)
    }

    /// The base revision of a delta at `seq`: `seq − 1`, which must exist and
    /// be live (§4.4, §8 I10).
    fn base(&self, doc_id: &str, seq: i64, what: &str) -> Result<RevRow> {
        if !self.prefix.is_empty() {
            return Err(Error::Delta(format!(
                "{what} of {doc_id} at seq {seq} is a delta inside an archive segment"
            )));
        }
        let Some(prev) = self.revision(doc_id, seq - 1)? else {
            return Err(Error::Delta(format!(
                "{what} of {doc_id} at seq {seq} is a delta but the document has no revision {}",
                seq - 1
            )));
        };
        if prev.archive.is_some() {
            return Err(Error::Delta(format!(
                "{what} of {doc_id} at seq {seq} is a delta whose base revision {} is archived",
                seq - 1
            )));
        }
        Ok(prev)
    }

    fn node_text(&self, hash_hex: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .prepare_cached(&format!(
                "SELECT entries FROM {}tree_nodes WHERE hash = ?1",
                self.prefix
            ))?
            .query_row(params![from_hex(hash_hex)?], |r| r.get(0))
            .optional()?)
    }

    /// The sibling list stored under `hash_hex`, in the context of `(doc_id,
    /// seq)`, at the position `block_id` (`None` = the root). A `[`-node
    /// resolves to its entries; a `{`-node to its ops applied to the same
    /// position of `seq − 1`.
    pub fn list(
        &mut self,
        doc_id: &str,
        seq: i64,
        hash_hex: &str,
        block_id: Option<&str>,
    ) -> Result<Rc<ResolvedList>> {
        let key = format!("{doc_id} {seq} {} {hash_hex}", block_id.unwrap_or(""));
        if let Some(memo) = self.lists.get(&key) {
            return Ok(Rc::clone(memo));
        }
        let Some(text) = self.node_text(hash_hex)? else {
            return Err(Error::Delta(format!(
                "tree node {hash_hex} named by {doc_id} at seq {seq} is missing"
            )));
        };
        let Some(node) = parse_node_text(&text) else {
            return Err(Error::Delta(format!(
                "tree node {hash_hex} does not parse as a full or delta node"
            )));
        };
        let (form, entries, texts) = match node {
            Node::Full(entries) => {
                let texts = entries.iter().map(entry_text).collect();
                (Form::Full, entries, texts)
            }
            Node::Delta(ops) => {
                let prev = self.base(doc_id, seq, &format!("node {hash_hex}"))?;
                let Some(prev_root) = prev.root_tree else {
                    return Err(Error::Delta(format!(
                        "base revision {} of {doc_id} has no root tree",
                        seq - 1
                    )));
                };
                let prev_root_hex = hex(&prev_root);
                let base_list = match block_id {
                    None => Some(self.list(doc_id, seq - 1, &prev_root_hex, None)?),
                    Some(b) => self.child_list(doc_id, seq - 1, &prev_root_hex, b)?,
                };
                let Some(base_list) = base_list else {
                    return Err(Error::Delta(format!(
                        "node {hash_hex} of {doc_id} at seq {seq} is a delta for block {} which has no children at seq {}",
                        block_id.unwrap_or("<root>"),
                        seq - 1
                    )));
                };
                let texts = apply_ops(&ops, &base_list.texts)?;
                let mut entries = Vec::with_capacity(texts.len());
                for t in &texts {
                    let e = serde_json::from_str::<Value>(t)
                        .ok()
                        .and_then(|v| parse_entry(&v))
                        .ok_or_else(|| {
                            Error::Delta(format!(
                                "delta node {hash_hex} resolved to a malformed entry"
                            ))
                        })?;
                    entries.push(e);
                }
                (Form::Delta, entries, texts)
            }
        };
        // Self-containment needs the children: a delta is never
        // self-contained; a full node is when every child list is.
        let mut self_contained = form == Form::Full;
        if self_contained {
            for e in &entries {
                if let Some(child) = &e.child_tree_hash_hex {
                    if !self
                        .list(doc_id, seq, child, Some(&e.block_id))?
                        .self_contained
                    {
                        self_contained = false;
                        break;
                    }
                }
            }
        }
        let out = Rc::new(ResolvedList {
            hash: hash_hex.to_owned(),
            form,
            entries,
            texts,
            self_contained,
        });
        self.lists.insert(key, Rc::clone(&out));
        Ok(out)
    }

    /// The children list of `block_id` anywhere in the tree rooted at
    /// `root_hex` (context `(doc_id, seq)`), or `None` when the block has no
    /// children there.
    pub fn child_list(
        &mut self,
        doc_id: &str,
        seq: i64,
        root_hex: &str,
        block_id: &str,
    ) -> Result<Option<Rc<ResolvedList>>> {
        Ok(self
            .tree(doc_id, seq, root_hex)?
            .by_block
            .get(block_id)
            .cloned())
    }

    /// The whole tree of a revision, every list resolved in its context.
    pub fn tree(&mut self, doc_id: &str, seq: i64, root_hex: &str) -> Result<Rc<ResolvedTree>> {
        let key = format!("{doc_id} {seq} {root_hex}");
        if let Some(memo) = self.trees.get(&key) {
            return Ok(Rc::clone(memo));
        }
        let root = self.list(doc_id, seq, root_hex, None)?;
        let mut by_block = HashMap::new();
        let mut stack: Vec<Rc<ResolvedList>> = vec![Rc::clone(&root)];
        while let Some(list) = stack.pop() {
            for e in &list.entries {
                let Some(child_hex) = &e.child_tree_hash_hex else {
                    continue;
                };
                let child = self.list(doc_id, seq, child_hex, Some(&e.block_id))?;
                by_block.insert(e.block_id.clone(), Rc::clone(&child));
                stack.push(child);
            }
        }
        let out = Rc::new(ResolvedTree { root, by_block });
        self.trees.insert(key, Rc::clone(&out));
        Ok(out)
    }

    /// A revision's frontmatter raw from its `frontmatter_blob` (a `-`-form
    /// blob, or a `{"f":…}` delta over `seq − 1`'s).
    pub fn frontmatter(&mut self, doc_id: &str, seq: i64, blob_hex: &str) -> Result<String> {
        let key = format!("{doc_id} {seq} {blob_hex}");
        if let Some(memo) = self.frontmatters.get(&key) {
            return Ok(memo.clone());
        }
        let bytes: Option<Vec<u8>> = self
            .conn
            .prepare_cached(&format!(
                "SELECT bytes FROM {}blobs WHERE hash = ?1",
                self.prefix
            ))?
            .query_row(params![from_hex(blob_hex)?], |r| r.get(0))
            .optional()?;
        let Some(bytes) = bytes else {
            return Err(Error::Delta(format!(
                "frontmatter blob {blob_hex} named by {doc_id} at seq {seq} is missing"
            )));
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let Some(parsed) = parse_frontmatter_blob(&text) else {
            return Err(Error::Delta(format!(
                "frontmatter blob {blob_hex} does not parse as a raw or a delta"
            )));
        };
        let raw = match parsed {
            FrontmatterBlob::Raw(raw) => raw,
            FrontmatterBlob::Delta(ops) => {
                let prev = self.base(doc_id, seq, &format!("frontmatter {blob_hex}"))?;
                let Some(prev_fm) = prev.frontmatter_blob else {
                    return Err(Error::Delta(format!(
                        "frontmatter {blob_hex} of {doc_id} at seq {seq} is a delta but revision {} has no frontmatter",
                        seq - 1
                    )));
                };
                let base_raw = self.frontmatter(doc_id, seq - 1, &hex(&prev_fm))?;
                apply_ops(&ops, &split_lines(&base_raw))?.concat()
            }
        };
        self.frontmatters.insert(key, raw.clone());
        Ok(raw)
    }

    /// The checkpoint (self-contained) form of a resolved tree: every list as
    /// a `[`-node whose child hashes are the full children's — what an archive
    /// segment holds (§7.1) and what the squash re-checkpoints a kept revision
    /// to. Returns the root's full hash and every full node by hash.
    pub fn checkpoint_form(tree: &ResolvedTree) -> Result<(String, BTreeMap<String, String>)> {
        fn full(
            list: &ResolvedList,
            tree: &ResolvedTree,
            nodes: &mut BTreeMap<String, String>,
        ) -> Result<String> {
            let mut texts = Vec::with_capacity(list.entries.len());
            for e in &list.entries {
                if e.child_tree_hash_hex.is_none() {
                    texts.push(entry_text(e));
                    continue;
                }
                let Some(child) = tree.by_block.get(&e.block_id) else {
                    return Err(Error::Delta(format!(
                        "block {} names a child tree but the resolved tree has none",
                        e.block_id
                    )));
                };
                let child_hex = full(child, tree, nodes)?;
                let mut e2 = e.clone();
                e2.child_tree_hash_hex = Some(child_hex);
                texts.push(entry_text(&e2));
            }
            let text = full_node_text(&texts);
            let hex_hash = hex(&sha256(text.as_bytes()));
            nodes.insert(hex_hash.clone(), text);
            Ok(hex_hash)
        }
        let mut nodes = BTreeMap::new();
        let root_hex = full(&tree.root, tree, &mut nodes)?;
        Ok((root_hex, nodes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, raw: &str, child: Option<&str>) -> TreeEntry {
        TreeEntry {
            block_id: id.to_owned(),
            raw_hash_hex: raw.to_owned(),
            child_tree_hash_hex: child.map(str::to_owned),
            kind: "paragraph".to_owned(),
            attrs: json!({}),
            trivia_hash_hex: None,
        }
    }

    #[test]
    fn body_delta_groups_the_script() {
        let base: Vec<String> = ["a", "b", "c", "d"]
            .iter()
            .map(|s| entry_text(&entry(s, "00", None)))
            .collect();
        // Replace c, drop d, append e.
        let next: Vec<String> = ["a", "b", "C", "e"]
            .iter()
            .map(|s| entry_text(&entry(s, "00", None)))
            .collect();
        let delta = encode_body_delta(&base, &next);
        assert!(
            delta.starts_with("{\"d\":[[\"=\",2],[\"~\",[\"C\""),
            "{delta}"
        );
        let node = parse_node_text(&delta).unwrap();
        let Node::Delta(ops) = &node else { panic!() };
        assert_eq!(apply_ops(ops, &base).unwrap(), next);
        // The identity delta and its byte cost (~17 B).
        assert_eq!(encode_body_delta(&base, &base), "{\"d\":[[\"=\",4]]}");
        assert_eq!(explicit_entries(&node).len(), 2);
    }

    #[test]
    fn frontmatter_delta_is_over_lines_with_endings() {
        let base = "---\na: 1\nb: 2\n---";
        let next = "---\na: 1\nb: 3\n---";
        let d = encode_frontmatter_delta(base, next);
        assert_eq!(d, "{\"f\":[[\"=\",2],[\"~\",\"b: 3\\n\"],[\"=\",1]]}");
        let Some(FrontmatterBlob::Delta(ops)) = parse_frontmatter_blob(&d) else {
            panic!()
        };
        assert_eq!(apply_ops(&ops, &split_lines(base)).unwrap().concat(), next);
        assert_eq!(split_lines(""), vec![""]);
        assert_eq!(split_lines("a\r\nb\n"), vec!["a\r\n", "b\n", ""]);
        assert!(matches!(
            parse_frontmatter_blob("---\n---"),
            Some(FrontmatterBlob::Raw(_))
        ));
        assert!(parse_frontmatter_blob("{\"x\":[]}").is_none());
    }

    #[test]
    fn ops_must_consume_the_base() {
        let base = vec!["x".to_owned()];
        assert!(apply_ops(&[DeltaOp::Keep(2)], &base).is_err());
        assert!(apply_ops(&[], &base).is_err());
        assert!(apply_ops(&[DeltaOp::Drop, DeltaOp::Drop], &base).is_err());
        assert_eq!(
            apply_ops(&[DeltaOp::Replace("y".to_owned())], &base).unwrap(),
            vec!["y"]
        );
        assert!(parse_node_text("{\"d\":[[\"=\",0]]}").is_none());
        assert!(parse_node_text("{\"d\":[[\"?\"]]}").is_none());
        assert!(parse_node_text("{\"d\":[],\"e\":[]}").is_none());
        assert!(matches!(parse_node_text("[]"), Some(Node::Full(e)) if e.is_empty()));
    }

    #[test]
    fn cadence() {
        assert!(is_checkpoint_seq(1));
        assert!(!is_checkpoint_seq(2));
        assert!(!is_checkpoint_seq(16));
        assert!(is_checkpoint_seq(17));
        assert!(is_checkpoint_seq(33));
    }
}
