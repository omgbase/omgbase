//! Store-backed equality indexes for the OQX engine (`DataContext::index_for`):
//! when a nested block's receiver is a ROOT SCAN (`$repo.docs`, `$repo.edges`,
//! a bare `docs` at the root scope — a lazy [`crate::context`] marker) and its
//! correlated or constant equality is on a column or property SQLite can look
//! up — `where $path == ^^$path`, `where customer == ^$path`, `where $dst ==
//! ^$id`, `where type == "order"` — the probe runs ONE cached statement
//! against the store's indexes instead of materializing every row of the
//! target and hashing it. The rows come back exactly as the root scan
//! constructs them (same columns, same `__path`, same tag, same `(path, id)`
//! order) under the same live-row and repo guards as the planner's, so every
//! intrinsic and relation keeps working downstream and the result cannot
//! differ from the scan — only the work does. Port of
//! `packages/core/src/oqx-js/store-index.ts`.
//!
//! Typed equality (OQX SEMANTICS §5) is preserved by probing per VALUE KIND:
//!
//! * a text column (`doc_id`, `path`, `type`, `kind`, `name`, `src_doc`, …)
//!   matches a string probe by `= ?` (TEXT = TEXT, exact); a number, boolean,
//!   object or any other non-string probe matches NO row (the column holds
//!   strings or NULL and `5 == "5"` is false); an absent probe (`null`,
//!   `undefined`: `name == null`) is answered by the fallback below;
//! * a document property (`customer`, `$title`) matches a string probe only on
//!   a `type = 'string'` row (`val_text = ?`), a number probe only on a
//!   `type = 'number'` row (`val_num = ?`), a boolean only on a `type = 'bool'`
//!   row (`val_bool = ?`), each under the scalar-in-scope rule the in-memory
//!   `doc_prop` applies (exactly one live row for the key on the document and
//!   it is `card = 'scalar'`; a list-valued, repeated or nested key is an array
//!   or object in memory and equals no scalar). `NaN` equals nothing. An
//!   absent probe (`key == null`: a `null` scalar OR a document lacking the
//!   key) is an anti-join SQLite has no index for, and an array, object or
//!   range probe compares structurally in this engine (a `json` property could
//!   match), so both are answered by the fallback.
//!
//! The fallback — a probe value no statement covers — reads the collection
//! once per run (the same lazy root scan the engine would have walked) and
//! filters it with the context's own `get` under OQX equality: the engine's
//! own hash index could do no better, and the answer is by construction the
//! scan's.
//!
//! `lookup(value)` (positions into the collection) is implemented for the
//! seam's contract but the engine never calls it for these indexes: it probes
//! `lookup_rows` first and so never reads the root whole.

use std::rc::Rc;

use oqx::semantics::equals;
use oqx::{DataContext, RowIndex, Value};
use rusqlite::types::Value as SqlValue;

use crate::context::{StoreContext, Target};
use crate::paths::storage_path;
use crate::planner::{columns, from_by_doc, from_clause, guards, guards_by_doc, order_clause};
use crate::translate::{RESERVED_DOC_BASENAMES, non_property_handles};

/// How a one-segment path on a target is probed.
#[derive(Clone, Debug)]
enum Probe {
    /// An indexed TEXT column (or an equivalent indexed test) with one `?` for
    /// the value; `?r`, when present, is the repo id (bound ahead of it).
    Column(&'static str),
    /// A docs property by key, optionally within one source.
    Property {
        key: String,
        source: Option<&'static str>,
    },
}

/// The indexed TEXT column (or an equivalent indexed test) a one-segment local
/// path reads, per target — the paths a probe pushes to SQLite. Each is served
/// by a primary key, a `UNIQUE`, or an index of `spec/store/schema.sql`: docs
/// `doc_id` (PK) and `(repo_id, path)`; blocks `block_id` (PK), `idx_blocks_doc
/// (doc_id, …)`, `idx_blocks_type (repo_id, type)`; nodes `node_id` (PK),
/// `idx_nodes_doc`, `idx_nodes_kind`, `idx_nodes_name`; edges `edge_id` (PK),
/// `idx_edges_src (src_doc, …)`, `idx_edges_dst (dst_node, …)`; `$path` on a
/// joined target reaches the docs `(repo_id, path)` key and then the target's
/// `doc_id` / `src_doc` index. `$dst_path` is the destination document's path
/// (deleted or not — the intrinsic reads `docs` by id without a liveness
/// guard); a destination is resolved within the edge's repo (spec/graph §3),
/// where `(repo_id, path)` is UNIQUE, so the probe is that one document.
fn column_probe(t: Target, key: &str) -> Option<&'static str> {
    Some(match (t, key) {
        (Target::Docs, "$id") => "d.doc_id = ?",
        (Target::Docs, "$path") => "d.path = ?",
        (Target::Blocks, "$id") => "b.block_id = ?",
        (Target::Blocks, "$doc") => "b.doc_id = ?",
        (Target::Blocks, "type") => "b.type = ?",
        (Target::Blocks, "$path") => "d.path = ?",
        (Target::Nodes, "$id" | "$node_id") => "n.node_id = ?",
        (Target::Nodes, "$doc_id") => "n.doc_id = ?",
        (Target::Nodes, "kind") => "n.kind = ?",
        (Target::Nodes, "name") => "n.name = ?",
        (Target::Nodes, "$path") => "d.path = ?",
        (Target::Edges, "$id") => "e.edge_id = ?",
        (Target::Edges, "$src") => "e.src_doc = ?",
        (Target::Edges, "$dst") => "e.dst_node = ?",
        (Target::Edges, "$path") => "d.path = ?",
        (Target::Edges, "$dst_path") => {
            "e.dst_node IN (SELECT doc_id FROM docs WHERE repo_id = ?r AND path = ?)"
        }
        _ => return None,
    })
}

/// How a one-segment path on `target` is probed, or `None` when SQLite has no
/// index for it (the engine then builds its own over the materialized scan).
fn probe_for(t: Target, path: &[String]) -> Option<Probe> {
    let [key] = path else { return None };
    if let Some(sql) = column_probe(t, key) {
        return Some(Probe::Column(sql));
    }
    if t != Target::Docs {
        return None;
    }
    // A docs property: any bare name the context reads through `doc_prop` —
    // not a relation / handle (`out`, `frontmatter`, …), not a reserved
    // basename (a loud error in memory, left to the scan to raise), not the
    // `format` column (not indexed), and of the intrinsics only `$title` (a
    // computed scalar property).
    if key == "$title" {
        return Some(Probe::Property {
            key: key.clone(),
            source: Some("computed"),
        });
    }
    if key.starts_with('$') || key == "format" {
        return None;
    }
    if non_property_handles(Target::Docs).contains(&key.as_str())
        || RESERVED_DOC_BASENAMES.contains(&key.as_str())
    {
        return None;
    }
    Some(Probe::Property {
        key: key.clone(),
        source: None,
    })
}

/// The paths [`index_for`] answers from SQLite, per target (for tests and
/// docs); docs also answer `$title` and every property key.
#[must_use]
pub fn indexable_paths(t: Target) -> &'static [&'static str] {
    match t {
        Target::Docs => &["$id", "$path", "$title", "<property key>"],
        Target::Blocks => &["$id", "$doc", "type", "$path"],
        Target::Nodes => &["$id", "$node_id", "$doc_id", "kind", "name", "$path"],
        Target::Edges => &["$id", "$src", "$dst", "$path", "$dst_path"],
    }
}

/// A store-backed [`RowIndex`] for the root scan of `target` on `path`, or
/// `None` when SQLite has no index for the path (table above; multi-segment
/// paths; `format`, edge `predicate` / `src_field`, `$tags`, …).
pub(crate) fn index_for<'c, 'a>(
    ctx: &'c StoreContext<'a>,
    target: Target,
    path: &[String],
) -> Option<Rc<dyn RowIndex + 'c>> {
    let probe = probe_for(target, path)?;
    Some(Rc::new(StoreIndex {
        ctx,
        target,
        path: path[0].clone(),
        probe,
    }))
}

struct StoreIndex<'c, 'a> {
    ctx: &'c StoreContext<'a>,
    target: Target,
    path: String,
    probe: Probe,
}

impl StoreIndex<'_, '_> {
    fn rows(&self, value: &Value) -> oqx::Result<Vec<Value>> {
        if value.is_absent() {
            return self.fallback(value);
        }
        match &self.probe {
            // `$path` / `$dst_path` are the reference form in memory (`/a.md`,
            // `spec/surface` §1 "Paths"); the column holds the storage form. A
            // rooted probe is de-rooted; a bare one can equal no rooted path.
            Probe::Column(sql) if self.path == "$path" || self.path == "$dst_path" => match value {
                Value::Str(s) if s.starts_with('/') => self.column(sql, storage_path(s)),
                _ => Ok(Vec::new()),
            },
            Probe::Column(sql) => match value {
                Value::Str(s) => self.column(sql, s),
                _ => Ok(Vec::new()),
            },
            Probe::Property { key, source } => match value {
                Value::Str(s) => self.property(
                    key,
                    *source,
                    "p.type = 'string' AND p.val_text = ?",
                    SqlValue::Text(s.clone()),
                ),
                Value::Number(n) if n.is_nan() => Ok(Vec::new()),
                Value::Number(n) => self.property(
                    key,
                    *source,
                    "p.type = 'number' AND p.val_num = ?",
                    SqlValue::Real(*n),
                ),
                Value::Bool(b) => self.property(
                    key,
                    *source,
                    "p.type = 'bool' AND p.val_bool = ?",
                    SqlValue::Integer(i64::from(*b)),
                ),
                // Array, Object, Range: this engine compares them structurally,
                // so a decoded `json` property could equal one — the scan decides.
                _ => self.fallback(value),
            },
        }
    }

    /// A `$path` probe on a joined target drives from the document
    /// (`from_by_doc`), every other column probe from the target's own index.
    fn column(&self, probe: &str, value: &str) -> oqx::Result<Vec<Value>> {
        let t = self.target;
        let repo = self.ctx.repo_id();
        let by_doc = t != Target::Docs && self.path == "$path";
        let (from, guard, mut params) = if by_doc {
            (
                from_by_doc(t),
                guards_by_doc(t),
                vec![
                    SqlValue::Text(repo.to_owned()),
                    SqlValue::Text(repo.to_owned()),
                ],
            )
        } else {
            (
                from_clause(t),
                guards(t),
                vec![SqlValue::Text(repo.to_owned())],
            )
        };
        if probe.contains("?r") {
            params.push(SqlValue::Text(repo.to_owned()));
        }
        params.push(SqlValue::Text(value.to_owned()));
        let sql = format!(
            "SELECT {} FROM {} WHERE {} AND {} ORDER BY {}",
            columns(t),
            from,
            guard,
            probe.replace("?r", "?"),
            order_clause(t)
        );
        self.ctx.probe_rows(t, &sql, &params)
    }

    /// The scalar-in-scope rule as SQL: the document has exactly one live row
    /// for the key (within the source, for a sourced read) and that row is a
    /// scalar of the probe's type with the probe's value. The loop is driven
    /// from the properties index (`CROSS JOIN`: `idx_props_key_text` /
    /// `idx_props_key_num`, `(repo_id, key, val_*)`) and reaches the document
    /// by primary key; the count runs per candidate only, and with it at one
    /// no document repeats.
    fn property(
        &self,
        key: &str,
        source: Option<&str>,
        typed: &str,
        bound: SqlValue,
    ) -> oqx::Result<Vec<Value>> {
        let repo = self.ctx.repo_id();
        let src = source.map_or("", |_| " AND p.source = ?");
        let src2 = source.map_or("", |_| " AND p2.source = ?");
        let sql = format!(
            "SELECT d.* FROM properties p CROSS JOIN docs d ON d.doc_id = p.doc_id
             WHERE p.repo_id = ? AND p.key = ? AND {typed} AND p.card = 'scalar' AND p.deleted_commit IS NULL{src}
               AND {} AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = d.doc_id AND p2.key = ? AND p2.deleted_commit IS NULL{src2}) = 1
             ORDER BY {}",
            guards(Target::Docs),
            order_clause(Target::Docs)
        );
        let mut params = vec![
            SqlValue::Text(repo.to_owned()),
            SqlValue::Text(key.to_owned()),
            bound,
        ];
        if let Some(s) = source {
            params.push(SqlValue::Text(s.to_owned()));
        }
        params.push(SqlValue::Text(repo.to_owned()));
        params.push(SqlValue::Text(key.to_owned()));
        if let Some(s) = source {
            params.push(SqlValue::Text(s.to_owned()));
        }
        self.ctx.probe_rows(Target::Docs, &sql, &params)
    }

    /// The scan's own answer for a probe no statement covers.
    fn fallback(&self, value: &Value) -> oqx::Result<Vec<Value>> {
        let rows = self.ctx.scan_rows(self.target)?;
        let mut out = Vec::new();
        for r in rows.iter() {
            if equals(&self.ctx.get(r, &self.path)?, value) {
                out.push(r.clone());
            }
        }
        Ok(out)
    }
}

impl RowIndex for StoreIndex<'_, '_> {
    fn lookup(&self, value: &Value) -> Vec<usize> {
        let Ok(all) = self.ctx.scan_rows(self.target) else {
            return Vec::new();
        };
        let Ok(hits) = self.rows(value) else {
            return Vec::new();
        };
        let ids: Vec<Value> = hits.iter().map(|r| self.ctx.identity(r)).collect();
        all.iter()
            .enumerate()
            .filter(|(_, r)| ids.contains(&self.ctx.identity(r)))
            .map(|(i, _)| i)
            .collect()
    }

    fn lookup_rows(&self, value: &Value) -> Option<oqx::Result<Vec<Value>>> {
        Some(self.rows(value))
    }
}
