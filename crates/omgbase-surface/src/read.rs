//! Reads (`spec/surface/README.md` §2): ref resolution, whole-document reads,
//! block hydration at a resolution, the outline wire format, and the two
//! path-ordered list surfaces. Port of `packages/core/src/core/read/*`.
//! Result keys follow the reference's spelling (`docId`, `renderedHashMatch`,
//! …) — the fixtures are generated from it.

use std::collections::{BTreeMap, HashMap};

use omgbase_format::hash::hex;
use omgbase_store::{Store, is_id_ref};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::context::glob_to_like;
use crate::cursor::{decode_cursor, encode_cursor};
use crate::error::Result;

/// Max refs honored per `docs_read_many` / `nodes_get_many` call.
pub const MANY_CAP: usize = 100;
/// `docs_list` / `docs_tree` default page size.
pub const LIST_DEFAULT_LIMIT: usize = 200;

/// `ceil(JSON length / 4)`: the token estimate every budget uses.
#[must_use]
pub fn token_cost(v: &Json) -> usize {
    v.to_string().chars().count().div_ceil(4)
}

// ---- documents --------------------------------------------------------------------------

/// A live document's identity (`findDoc`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocInfo {
    pub doc_id: String,
    pub repo_id: String,
    pub path: String,
    pub format: String,
    pub current_rev: Option<String>,
}

fn doc_row(conn: &Connection, sql: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Option<DocInfo>> {
    Ok(conn
        .query_row(sql, p, |r| {
            Ok(DocInfo {
                doc_id: r.get(0)?,
                repo_id: r.get(1)?,
                path: r.get(2)?,
                format: r
                    .get::<_, Option<String>>(3)?
                    .unwrap_or_else(|| "markdown".to_owned()),
                current_rev: r.get(4)?,
            })
        })
        .optional()?)
}

/// A live doc by id.
pub fn find_doc_by_id(conn: &Connection, doc_id: &str) -> Result<Option<DocInfo>> {
    doc_row(
        conn,
        "SELECT doc_id, repo_id, path, format, current_rev FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
        &[&doc_id],
    )
}

/// A live doc by repo + path.
pub fn find_doc_by_path(conn: &Connection, repo_id: &str, path: &str) -> Result<Option<DocInfo>> {
    doc_row(
        conn,
        "SELECT doc_id, repo_id, path, format, current_rev FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_commit IS NULL",
        &[&repo_id, &path],
    )
}

/// The id-or-path dispatch every doc-ref surface routes through: a `d_` id
/// is looked up by id only (never falling through to a path).
pub fn find_doc_by_ref(conn: &Connection, repo_id: &str, r: &str) -> Result<Option<DocInfo>> {
    if is_id_ref(r, "d") {
        return find_doc_by_id(conn, r);
    }
    find_doc_by_path(conn, repo_id, r)
}

/// The prefix of an id-shaped ref (`^[a-z]+_[alphabet]{1,7}$`, so the
/// fixture minter's `b_0` counts, as the reference's `isValidId` after
/// `spec/mutate`).
fn id_prefix(r: &str) -> Option<&str> {
    let (p, _) = r.split_once('_')?;
    is_id_ref(r, p).then_some(p)
}

/// `resolve_ref`'s answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolvedRef {
    Block { doc_id: String, block_id: String },
    Document { doc_id: String },
}

impl ResolvedRef {
    #[must_use]
    pub fn doc_id(&self) -> &str {
        match self {
            ResolvedRef::Block { doc_id, .. } | ResolvedRef::Document { doc_id } => doc_id,
        }
    }
}

fn is_node_id(s: &str) -> bool {
    s.len() == 14
        && s.starts_with("n_")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// §2 `resolve_ref`: an `n_` node id → its live block, else its doc; a `b_`
/// id → its live block; a `d_` id → the live doc; anything else → the live
/// doc at that path; `None` when nothing matches.
pub fn resolve_ref(conn: &Connection, repo_id: &str, r: &str) -> Result<Option<ResolvedRef>> {
    if is_node_id(r) {
        let node: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT doc_id, block_id FROM nodes WHERE node_id = ?1",
                params![r],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((doc_id, block_id)) = node else {
            return Ok(None);
        };
        if let Some(b) = block_id {
            let live: bool = conn
                .prepare_cached(
                    "SELECT 1 FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                )?
                .exists(params![b])?;
            if live {
                return Ok(Some(ResolvedRef::Block {
                    doc_id,
                    block_id: b,
                }));
            }
        }
        return Ok(Some(ResolvedRef::Document { doc_id }));
    }
    match id_prefix(r) {
        Some("b") => {
            let doc: Option<String> = conn
                .query_row(
                    "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                    params![r],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(doc.map(|doc_id| ResolvedRef::Block {
                doc_id,
                block_id: r.to_owned(),
            }))
        }
        Some("d") => {
            Ok(find_doc_by_id(conn, r)?.map(|i| ResolvedRef::Document { doc_id: i.doc_id }))
        }
        _ => {
            Ok(find_doc_by_path(conn, repo_id, r)?
                .map(|i| ResolvedRef::Document { doc_id: i.doc_id }))
        }
    }
}

// ---- block forest -------------------------------------------------------------------------

/// A live block with its children (the containment forest).
#[derive(Clone, Debug, PartialEq)]
pub struct BlockNode {
    pub block_id: String,
    pub doc_id: String,
    pub parent_block: Option<String>,
    pub ordinal: i64,
    pub depth: i64,
    pub kind: String,
    pub attrs: Json,
    pub text: String,
    pub raw_hash_hex: String,
    pub children: Vec<BlockNode>,
}

/// A document's live blocks as an ordered forest (`ORDER BY parent_block,
/// order_key`; a row whose parent is not live is a root).
pub fn load_doc_blocks(conn: &Connection, doc_id: &str) -> Result<Vec<BlockNode>> {
    struct Row {
        block_id: String,
        parent_block: Option<String>,
        ordinal: i64,
        depth: i64,
        kind: String,
        attrs: String,
        text: String,
        raw_hash: Vec<u8>,
    }
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare_cached(
            "SELECT block_id, parent_block, ordinal, depth, type, attrs, text, raw_hash
             FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL
             ORDER BY parent_block, order_key",
        )?;
        let it = stmt.query_map(params![doc_id], |r| {
            Ok(Row {
                block_id: r.get(0)?,
                parent_block: r.get(1)?,
                ordinal: r.get(2)?,
                depth: r.get(3)?,
                kind: r.get(4)?,
                attrs: r.get(5)?,
                text: r.get(6)?,
                raw_hash: r.get(7)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let ids: Vec<String> = rows.iter().map(|r| r.block_id.clone()).collect();
    let index: HashMap<&str, usize> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let mut nodes: Vec<Option<BlockNode>> = rows
        .iter()
        .map(|r| {
            Some(BlockNode {
                block_id: r.block_id.clone(),
                doc_id: doc_id.to_owned(),
                parent_block: r.parent_block.clone(),
                ordinal: r.ordinal,
                depth: r.depth,
                kind: r.kind.clone(),
                attrs: serde_json::from_str(&r.attrs).unwrap_or(Json::Object(Map::new())),
                text: r.text.clone(),
                raw_hash_hex: hex(&r.raw_hash),
                children: Vec::new(),
            })
        })
        .collect();
    // Children in row order under their parent; roots in row order.
    let mut children_of: Vec<Vec<usize>> = vec![Vec::new(); rows.len()];
    let mut roots: Vec<usize> = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        match r.parent_block.as_deref().and_then(|p| index.get(p)) {
            Some(&p) => children_of[p].push(i),
            None => roots.push(i),
        }
    }
    fn build(i: usize, nodes: &mut [Option<BlockNode>], children_of: &[Vec<usize>]) -> BlockNode {
        let kids: Vec<BlockNode> = children_of[i]
            .iter()
            .map(|&c| build(c, nodes, children_of))
            .collect();
        let mut n = nodes[i].take().expect("each node is built once");
        n.children = kids;
        n
    }
    Ok(roots
        .into_iter()
        .map(|i| build(i, &mut nodes, &children_of))
        .collect())
}

fn find_block<'n>(roots: &'n [BlockNode], block_id: &str) -> Option<&'n BlockNode> {
    for n in roots {
        if n.block_id == block_id {
            return Some(n);
        }
        if let Some(f) = find_block(&n.children, block_id) {
            return Some(f);
        }
    }
    None
}

/// A block's raw bytes by hex hash (`""` when unknown).
pub fn block_raw(conn: &Connection, raw_hash_hex: &str) -> Result<String> {
    let bytes: Vec<u8> = (0..raw_hash_hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(&raw_hash_hex[2 * i..2 * i + 2], 16).ok())
        .collect();
    Ok(omgbase_store::read::blob_text(conn, &bytes)?)
}

// ---- docs_read ---------------------------------------------------------------------------

/// §2 `docs_read`: `{ path, docId, rev, properties, content }` (+ `ids`,
/// `hashes`, `parents` with ids); `None` for a missing doc.
pub fn docs_read(store: &Store, doc_id: &str, include_ids: bool) -> Result<Option<Json>> {
    let conn = store.conn();
    let Some(info) = find_doc_by_id(conn, doc_id)? else {
        return Ok(None);
    };
    let Some(content) = store.reconstruct(doc_id)? else {
        return Ok(None);
    };
    let mut m = Map::new();
    m.insert("path".to_owned(), json!(info.path));
    m.insert("docId".to_owned(), json!(info.doc_id));
    m.insert("rev".to_owned(), json!(info.current_rev));
    m.insert("properties".to_owned(), store.properties_grouped(doc_id)?);
    m.insert("content".to_owned(), json!(content));
    if include_ids {
        let mut ids = Vec::new();
        let mut hashes = Map::new();
        let mut parents = Map::new();
        fn collect(
            nodes: &[BlockNode],
            ids: &mut Vec<Json>,
            hashes: &mut Map<String, Json>,
            parents: &mut Map<String, Json>,
        ) {
            for n in nodes {
                ids.push(json!(n.block_id));
                hashes.insert(n.block_id.clone(), json!(n.raw_hash_hex));
                parents.insert(n.block_id.clone(), json!(n.parent_block));
                collect(&n.children, ids, hashes, parents);
            }
        }
        collect(
            &load_doc_blocks(conn, doc_id)?,
            &mut ids,
            &mut hashes,
            &mut parents,
        );
        m.insert("ids".to_owned(), Json::Array(ids));
        m.insert("hashes".to_owned(), Json::Object(hashes));
        m.insert("parents".to_owned(), Json::Object(parents));
    }
    Ok(Some(Json::Object(m)))
}

/// §2 `docs_read_many`: `{ items, errors, truncated }`.
pub fn docs_read_many(
    store: &Store,
    repo_id: &str,
    refs: &[String],
    include_ids: bool,
    budget_tokens: Option<usize>,
) -> Result<Json> {
    let capped = &refs[..refs.len().min(MANY_CAP)];
    let mut truncated = refs.len() > MANY_CAP;
    let mut items = Vec::new();
    let mut errors = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    let mut tokens = 0usize;
    for r in capped {
        if seen.contains(&r.as_str()) {
            continue;
        }
        seen.push(r);
        let info = find_doc_by_ref(store.conn(), repo_id, r)?;
        let read = match info {
            Some(i) => docs_read(store, &i.doc_id, include_ids)?,
            None => None,
        };
        let Some(read) = read else {
            errors.push(json!({ "ref": r, "error": "doc_not_found" }));
            continue;
        };
        let cost = token_cost(&read);
        if let Some(b) = budget_tokens {
            if tokens + cost > b {
                truncated = true;
                break;
            }
        }
        tokens += cost;
        items.push(read);
    }
    Ok(json!({ "items": items, "errors": errors, "truncated": truncated }))
}

/// §2 `docs_read_at`: `spec/store` §6.2 plus the current properties.
pub fn docs_read_at(store: &Store, doc_id: &str, rev: &str) -> Result<Option<Json>> {
    let Some(r) = store.read_at_revision(doc_id, rev)? else {
        return Ok(None);
    };
    Ok(Some(json!({
        "path": r.path,
        "docId": doc_id,
        "rev": rev,
        "content": r.content,
        "renderedHashMatch": r.rendered_hash_match,
        "properties": store.properties_grouped(doc_id)?,
        "propertiesAreCurrent": true,
    })))
}

// ---- nodes_get ----------------------------------------------------------------------------

/// The resolution ladder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    Skeleton,
    Outline,
    Text,
    Raw,
    Full,
}

impl Resolution {
    /// The wire spelling; `None` for an unknown word.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "skeleton" => Resolution::Skeleton,
            "outline" => Resolution::Outline,
            "text" => Resolution::Text,
            "raw" => Resolution::Raw,
            "full" => Resolution::Full,
            _ => return None,
        })
    }
}

/// The first `n` whitespace-separated words, `…` when cut.
#[must_use]
pub fn first_words(text: &str, n: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= n {
        words.join(" ")
    } else {
        format!("{}…", words[..n].join(" "))
    }
}

fn project(
    conn: &Connection,
    node: &BlockNode,
    resolution: Resolution,
    include_children: bool,
) -> Result<Json> {
    let mut m = Map::new();
    m.insert("id".to_owned(), json!(node.block_id));
    m.insert("type".to_owned(), json!(node.kind));
    match resolution {
        Resolution::Skeleton => {
            let label = if node.kind == "heading" {
                node.text.clone()
            } else {
                node.kind.clone()
            };
            m.insert("label".to_owned(), json!(label));
        }
        Resolution::Outline => {
            m.insert("label".to_owned(), json!(first_words(&node.text, 10)));
        }
        Resolution::Text => {
            m.insert("text".to_owned(), json!(node.text));
        }
        Resolution::Raw => {
            m.insert(
                "raw".to_owned(),
                json!(block_raw(conn, &node.raw_hash_hex)?),
            );
            m.insert("content_hash".to_owned(), json!(node.raw_hash_hex));
        }
        Resolution::Full => {
            m.insert(
                "raw".to_owned(),
                json!(block_raw(conn, &node.raw_hash_hex)?),
            );
            m.insert("content_hash".to_owned(), json!(node.raw_hash_hex));
            m.insert("text".to_owned(), json!(node.text));
            m.insert("attrs".to_owned(), node.attrs.clone());
            m.insert(
                "placement".to_owned(),
                json!({ "parent": node.parent_block, "ordinal": node.ordinal, "depth": node.depth }),
            );
        }
    }
    if include_children && !node.children.is_empty() {
        let kids: Result<Vec<Json>> = node
            .children
            .iter()
            .map(|c| project(conn, c, resolution, true))
            .collect();
        m.insert("children".to_owned(), Json::Array(kids?));
    }
    Ok(Json::Object(m))
}

/// §2 `nodes_get`: one block subtree at a resolution; `None` when the block
/// is not live in `doc_id`.
pub fn nodes_get(
    store: &Store,
    doc_id: &str,
    block_id: &str,
    resolution: Resolution,
) -> Result<Option<Json>> {
    let roots = load_doc_blocks(store.conn(), doc_id)?;
    match find_block(&roots, block_id) {
        Some(n) => Ok(Some(project(store.conn(), n, resolution, true)?)),
        None => Ok(None),
    }
}

/// §2 `nodes_get_many`: `{ nodes, truncated, unresolved }`.
pub fn nodes_get_many(
    store: &Store,
    doc_id: Option<&str>,
    block_ids: &[String],
    resolution: Resolution,
    budget_tokens: Option<usize>,
) -> Result<Json> {
    let conn = store.conn();
    let capped = &block_ids[..block_ids.len().min(MANY_CAP)];
    let mut owner: HashMap<String, String> = HashMap::new();
    if !capped.is_empty() {
        let placeholders: Vec<String> = (1..=capped.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT block_id, doc_id FROM blocks WHERE deleted_commit IS NULL AND block_id IN ({})",
            placeholders.join(",")
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(capped.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (b, d) = row?;
            if doc_id.is_none_or(|want| want == d) {
                owner.insert(b, d);
            }
        }
    }
    let mut forests: BTreeMap<String, Vec<BlockNode>> = BTreeMap::new();
    for d in owner.values() {
        if !forests.contains_key(d) {
            forests.insert(d.clone(), load_doc_blocks(conn, d)?);
        }
    }
    let mut nodes = Vec::new();
    let mut unresolved = Vec::new();
    let mut tokens = 0usize;
    let mut truncated = block_ids.len() > MANY_CAP;
    for id in capped {
        let node = owner
            .get(id)
            .and_then(|d| forests.get(d))
            .and_then(|f| find_block(f, id));
        let Some(node) = node else {
            unresolved.push(json!(id));
            continue;
        };
        let projected = project(conn, node, resolution, false)?;
        let cost = token_cost(&projected);
        if let Some(b) = budget_tokens {
            if tokens + cost > b {
                truncated = true;
                break;
            }
        }
        tokens += cost;
        nodes.push(projected);
    }
    Ok(json!({ "nodes": nodes, "truncated": truncated, "unresolved": unresolved }))
}

// ---- docs_outline -----------------------------------------------------------------------

fn type_label(node: &BlockNode) -> String {
    match node.kind.as_str() {
        "heading" => format!(
            "h{}",
            node.attrs
                .get("level")
                .map(|l| match l {
                    Json::String(s) => s.clone(),
                    Json::Null => String::new(),
                    other => other.to_string(),
                })
                .unwrap_or_default()
        ),
        "paragraph" => "p".to_owned(),
        "list" => "ul".to_owned(),
        "list_item" | "task" => "li".to_owned(),
        "blockquote" => "bq".to_owned(),
        "code_fence" => "code".to_owned(),
        "table" => "tbl".to_owned(),
        "table_row" => "tr".to_owned(),
        "thematic_break" => "hr".to_owned(),
        "html_block" => "html".to_owned(),
        "opaque" => "raw".to_owned(),
        other => other.to_owned(),
    }
}

fn label_for(node: &BlockNode) -> String {
    match node.kind.as_str() {
        "list" | "blockquote" | "table" => String::new(),
        "task" => {
            let checked = node.attrs.get("checked").is_some_and(|c| {
                !matches!(c, Json::Null | Json::Bool(false)) && c != &json!(0) && c != &json!("")
            });
            let glyph = if checked { "☑" } else { "☐" };
            format!("{glyph} {}", first_words(&node.text, 10))
        }
        _ => first_words(&node.text, 10),
    }
}

/// §2 `docs_outline`: `{ text, truncated }`.
pub fn docs_outline(
    store: &Store,
    doc_id: &str,
    skeleton: bool,
    depth: Option<i64>,
    budget_tokens: Option<usize>,
) -> Result<Json> {
    let roots = load_doc_blocks(store.conn(), doc_id)?;
    struct Walk {
        skeleton: bool,
        max_depth: Option<i64>,
        budget: Option<usize>,
        lines: Vec<String>,
        tokens: usize,
        truncated: bool,
    }
    impl Walk {
        fn walk(&mut self, nodes: &[BlockNode], indent: i64) {
            for node in nodes {
                if self.truncated {
                    return;
                }
                if self.max_depth.is_some_and(|d| indent > d) {
                    continue;
                }
                let pad = "  ".repeat(usize::try_from(indent).unwrap_or(0));
                let section_mark = if node.kind == "heading" { "  §" } else { "" };
                let label = if self.skeleton {
                    String::new()
                } else {
                    label_for(node)
                };
                let line = format!(
                    "{pad}{} {:<4} {label}{section_mark}",
                    node.block_id,
                    type_label(node)
                );
                let line = line.trim_end().to_owned();
                let line_tokens = line.chars().count().div_ceil(4);
                if self.budget.is_some_and(|b| self.tokens + line_tokens > b) {
                    self.truncated = true;
                    return;
                }
                self.tokens += line_tokens;
                self.lines.push(line);
                if !node.children.is_empty() {
                    self.walk(&node.children, indent + 1);
                }
            }
        }
    }
    let mut w = Walk {
        skeleton,
        max_depth: depth,
        budget: budget_tokens,
        lines: Vec::new(),
        tokens: 0,
        truncated: false,
    };
    w.walk(&roots, 0);
    let (lines, truncated) = (w.lines, w.truncated);
    Ok(json!({ "text": lines.join("\n"), "truncated": truncated }))
}

// ---- docs_list / docs_tree --------------------------------------------------------------

/// One row of `docs_list`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocListRow {
    pub path: String,
    pub blocks: i64,
    pub ts: Option<String>,
}

impl DocListRow {
    fn to_json(&self) -> Json {
        json!({ "path": self.path, "blocks": self.blocks, "ts": self.ts })
    }
}

/// Live docs (path, live block count, last-commit ts) matching `like`, by
/// path, optionally after `after`, capped at `limit`.
fn live_doc_rows(
    conn: &Connection,
    repo_id: &str,
    like: &str,
    after: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<DocListRow>> {
    let mut sql = String::from(
        "SELECT d.path,
                (SELECT count(*) FROM blocks b WHERE b.doc_id = d.doc_id AND b.deleted_commit IS NULL),
                (SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = d.current_rev)
         FROM docs d
         WHERE d.repo_id = ?1 AND d.deleted_commit IS NULL AND d.path LIKE ?2 ESCAPE '\\'",
    );
    let mut p: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(repo_id.to_owned()),
        rusqlite::types::Value::Text(like.to_owned()),
    ];
    if let Some(a) = after {
        sql.push_str(" AND d.path > ?3");
        p.push(rusqlite::types::Value::Text(a.to_owned()));
    }
    sql.push_str(" ORDER BY d.path");
    if let Some(l) = limit {
        sql.push_str(&format!(" LIMIT ?{}", p.len() + 1));
        p.push(rusqlite::types::Value::Integer(
            i64::try_from(l).unwrap_or(i64::MAX),
        ));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(p.iter()), |r| {
        Ok(DocListRow {
            path: r.get(0)?,
            blocks: r.get(1)?,
            ts: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Page an already path-ordered row set under a limit + token budget (at
/// least one row), issuing a `[path]` cursor when it stops early.
fn page_path_ordered(
    rows: Vec<(String, Json)>,
    limit: usize,
    budget_tokens: Option<usize>,
    more_beyond: bool,
) -> (Vec<Json>, bool, Option<String>) {
    let mut items: Vec<Json> = Vec::new();
    let mut last_path: Option<String> = None;
    let mut tokens = 0usize;
    let mut truncated = more_beyond;
    for (path, row) in rows {
        if items.len() >= limit {
            truncated = true;
            break;
        }
        let cost = token_cost(&row);
        if !items.is_empty() && budget_tokens.is_some_and(|b| tokens + cost > b) {
            truncated = true;
            break;
        }
        tokens += cost;
        items.push(row);
        last_path = Some(path);
    }
    let cursor = match (&truncated, last_path) {
        (true, Some(p)) => Some(encode_cursor(&[&p])),
        _ => None,
    };
    (items, truncated, cursor)
}

/// §2 `docs_list`: `{ items, truncated, cursor }`.
pub fn docs_list(
    store: &Store,
    repo_id: &str,
    path_glob: Option<&str>,
    limit: Option<i64>,
    cursor: Option<&str>,
    budget_tokens: Option<usize>,
) -> Result<Json> {
    let like = path_glob.map_or_else(|| "%".to_owned(), |g| glob_to_like(g, true));
    let limit = usize::try_from(limit.unwrap_or(LIST_DEFAULT_LIMIT as i64).max(1)).unwrap_or(1);
    let after = match cursor.filter(|c| !c.is_empty()) {
        Some(c) => Some(decode_cursor(c, "docs_list/docs_tree", 1)?.remove(0)),
        None => None,
    };
    let mut rows = live_doc_rows(
        store.conn(),
        repo_id,
        &like,
        after.as_deref(),
        Some(limit + 1),
    )?;
    let more_beyond = rows.len() > limit;
    rows.truncate(limit);
    let (items, truncated, cursor) = page_path_ordered(
        rows.into_iter()
            .map(|r| (r.path.clone(), r.to_json()))
            .collect(),
        limit,
        budget_tokens,
        more_beyond,
    );
    Ok(json!({ "items": items, "truncated": truncated, "cursor": cursor }))
}

/// Normalize a tree prefix: no leading `/`, and either empty or ending in `/`.
#[must_use]
pub fn normalize_tree_prefix(path: Option<&str>) -> String {
    let trimmed = path
        .unwrap_or("")
        .trim_start_matches('/')
        .trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}/")
    }
}

/// §2 `docs_tree`: `{ prefix, depth, total, entries, truncated, cursor }`.
pub fn docs_tree(
    store: &Store,
    repo_id: &str,
    path: Option<&str>,
    depth: Option<i64>,
    limit: Option<i64>,
    cursor: Option<&str>,
    budget_tokens: Option<usize>,
) -> Result<Json> {
    let prefix = normalize_tree_prefix(path);
    let depth = usize::try_from(depth.unwrap_or(1).max(1)).unwrap_or(1);
    let limit = usize::try_from(limit.unwrap_or(LIST_DEFAULT_LIMIT as i64).max(1)).unwrap_or(1);
    let like = if prefix.is_empty() {
        "%".to_owned()
    } else {
        format!("{}%", glob_to_like(&prefix, true))
    };
    let rows = live_doc_rows(store.conn(), repo_id, &like, None, None)?;

    struct Entry {
        path: String,
        dir: bool,
        docs: i64,
        blocks: i64,
        ts: Option<String>,
    }
    let mut by_path: Vec<Entry> = Vec::new();
    let (mut total_docs, mut total_blocks) = (0i64, 0i64);
    for row in &rows {
        total_docs += 1;
        total_blocks += row.blocks;
        let rel = &row.path[prefix.len().min(row.path.len())..];
        let segs: Vec<&str> = rel.split('/').collect();
        if segs.len() <= depth {
            by_path.push(Entry {
                path: row.path.clone(),
                dir: false,
                docs: 1,
                blocks: row.blocks,
                ts: row.ts.clone(),
            });
            continue;
        }
        let dir = format!("{prefix}{}/", segs[..depth].join("/"));
        match by_path.iter_mut().find(|e| e.path == dir) {
            Some(cur) => {
                cur.docs += 1;
                cur.blocks += row.blocks;
                if let Some(ts) = &row.ts {
                    if cur.ts.as_ref().is_none_or(|c| ts > c) {
                        cur.ts = Some(ts.clone());
                    }
                }
            }
            None => by_path.push(Entry {
                path: dir,
                dir: true,
                docs: 1,
                blocks: row.blocks,
                ts: row.ts.clone(),
            }),
        }
    }
    by_path.sort_by(|a, b| a.path.cmp(&b.path));
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        let after = decode_cursor(c, "docs_list/docs_tree", 1)?.remove(0);
        by_path.retain(|e| e.path > after);
    }
    let entries: Vec<(String, Json)> = by_path
        .into_iter()
        .map(|e| {
            (
                e.path.clone(),
                json!({
                    "path": e.path,
                    "kind": if e.dir { "dir" } else { "doc" },
                    "docs": e.docs,
                    "blocks": e.blocks,
                    "ts": e.ts,
                }),
            )
        })
        .collect();
    let (items, truncated, cursor) = page_path_ordered(entries, limit, budget_tokens, false);
    Ok(json!({
        "prefix": prefix,
        "depth": depth,
        "total": { "docs": total_docs, "blocks": total_blocks },
        "entries": items,
        "truncated": truncated,
        "cursor": cursor,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_prefixes() {
        assert_eq!(first_words("a  b\tc", 10), "a b c");
        assert_eq!(first_words("a b c", 2), "a b…");
        assert_eq!(normalize_tree_prefix(None), "");
        assert_eq!(normalize_tree_prefix(Some("/projects//")), "projects/");
        assert_eq!(normalize_tree_prefix(Some("a/b")), "a/b/");
        assert!(is_node_id("n_0123456789ab"));
        assert!(!is_node_id("n_0123456789AB"));
        assert!(!is_node_id("b_0123456789ab"));
    }

    #[test]
    fn token_cost_is_ceil_quarter_of_json_length() {
        assert_eq!(token_cost(&json!("ab")), 1); // "ab" → 4 chars
        assert_eq!(token_cost(&json!("abc")), 2); // 5 chars
    }
}
