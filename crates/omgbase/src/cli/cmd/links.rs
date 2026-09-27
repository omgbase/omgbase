//! `links` (§6): the open edges touching a node's document, grouped by
//! direction — doc-grain via the `doc_edges` rollup, block-grain (`--blocks`)
//! one row per edge with its source block. `show` reuses the read and the
//! rendering.

use omgbase_surface::read::resolve_ref;
use rusqlite::{Connection, params};
use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::{machine_out, str_of};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Direction {
    Out,
    In,
    #[default]
    Both,
}

/// What `links` asks for.
#[derive(Clone, Debug, Default)]
pub struct LinksQuery {
    pub direction: Direction,
    pub predicates: Option<Vec<String>>,
    pub blocks: bool,
}

impl LinksQuery {
    fn keeps(&self, predicate: &str) -> bool {
        self.predicates
            .as_ref()
            .is_none_or(|p| p.iter().any(|x| x == predicate))
    }
}

/// `docLinks`: `{ out: [{ predicate, node, kind, count, samples? | block? }], in: [...] }`.
pub fn doc_links(conn: &Connection, doc_id: &str, q: &LinksQuery) -> Result<Json> {
    let mut out: Vec<Json> = Vec::new();
    let mut inbound: Vec<Json> = Vec::new();
    let row = |predicate: String, node: String, kind: &str, count: i64| -> Map<String, Json> {
        let mut m = Map::new();
        m.insert("predicate".to_owned(), json!(predicate));
        m.insert("node".to_owned(), json!(node));
        m.insert("kind".to_owned(), json!(kind));
        m.insert("count".to_owned(), json!(count));
        m
    };
    if matches!(q.direction, Direction::Out | Direction::Both) {
        if q.blocks {
            let mut stmt = conn.prepare(
                "SELECT predicate, dst_node, dst_kind, src_block FROM edges
                 WHERE src_doc = ?1 AND to_commit IS NULL ORDER BY predicate, dst_node, src_block",
            )?;
            let rows = stmt.query_map(params![doc_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?;
            for r in rows {
                let (predicate, node, kind, block) = r?;
                if !q.keeps(&predicate) {
                    continue;
                }
                let mut m = row(predicate, node, &kind, 1);
                m.insert("block".to_owned(), json!(block));
                out.push(Json::Object(m));
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT predicate, dst_node, dst_kind, count, samples FROM doc_edges
                 WHERE src_doc = ?1 ORDER BY predicate, dst_node",
            )?;
            let rows = stmt.query_map(params![doc_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?;
            for r in rows {
                let (predicate, node, kind, count, samples) = r?;
                if !q.keeps(&predicate) {
                    continue;
                }
                let mut m = row(predicate, node, &kind, count);
                m.insert(
                    "samples".to_owned(),
                    serde_json::from_str(&samples).unwrap_or_else(|_| json!([])),
                );
                out.push(Json::Object(m));
            }
        }
    }
    if matches!(q.direction, Direction::In | Direction::Both) {
        if q.blocks {
            let mut stmt = conn.prepare(
                "SELECT predicate, src_doc, src_block FROM edges
                 WHERE dst_node = ?1 AND to_commit IS NULL ORDER BY predicate, src_doc, src_block",
            )?;
            let rows = stmt.query_map(params![doc_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?;
            for r in rows {
                let (predicate, node, block) = r?;
                if !q.keeps(&predicate) {
                    continue;
                }
                let mut m = row(predicate, node, "document", 1);
                m.insert("block".to_owned(), json!(block));
                inbound.push(Json::Object(m));
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT predicate, src_doc, count(*) AS cnt FROM edges
                 WHERE dst_node = ?1 AND to_commit IS NULL
                 GROUP BY predicate, src_doc ORDER BY predicate, src_doc",
            )?;
            let rows = stmt.query_map(params![doc_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for r in rows {
                let (predicate, node, count) = r?;
                if !q.keeps(&predicate) {
                    continue;
                }
                inbound.push(Json::Object(row(predicate, node, "document", count)));
            }
        }
    }
    Ok(json!({ "out": out, "in": inbound }))
}

fn src_of(cli: &Cli, e: &Json) -> String {
    let block = e
        .get("block")
        .and_then(Json::as_str)
        .unwrap_or("frontmatter");
    cli.style.dim(&format!("({block})"))
}

/// The two groups as `links` and `show` print them; a group prints only
/// when non-empty. A row carrying `block` (block-grain) names its source
/// block instead of a count.
pub fn render_link_groups(cli: &Cli, links: &Json, out_title: &str, in_title: &str) {
    let style = cli.style;
    let g = style.glyphs();
    let out = links.get("out").and_then(Json::as_array);
    let inbound = links.get("in").and_then(Json::as_array);
    if let Some(out) = out.filter(|o| !o.is_empty()) {
        cli.io.out(&style.dim(out_title));
        for e in out {
            let tail = if e.get("block").is_some() {
                src_of(cli, e)
            } else {
                style.dim(&format!(
                    "×{}",
                    e.get("count").and_then(Json::as_i64).unwrap_or(0)
                ))
            };
            cli.io.out(&format!(
                "    {} {} {} {tail}",
                style.accent(&str_of(e, "predicate")),
                style.dim(g.arrow),
                style.id(&str_of(e, "node"))
            ));
        }
    }
    if let Some(inbound) = inbound.filter(|i| !i.is_empty()) {
        cli.io.out(&style.dim(in_title));
        for e in inbound {
            if e.get("block").is_some() {
                cli.io.out(&format!(
                    "    {} {} {} {}",
                    style.id(&str_of(e, "node")),
                    src_of(cli, e),
                    style.dim(g.arrow),
                    style.accent(&str_of(e, "predicate"))
                ));
            } else {
                cli.io.out(&format!(
                    "    {} {} {} {}",
                    style.id(&str_of(e, "node")),
                    style.dim(g.arrow),
                    style.accent(&str_of(e, "predicate")),
                    style.dim(&format!(
                        "×{}",
                        e.get("count").and_then(Json::as_i64).unwrap_or(0)
                    ))
                ));
            }
        }
    }
}

pub fn links(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "links");
    }
    let a = parse_args(
        args,
        &[
            Opt::flag("in"),
            Opt::flag("out"),
            Opt::value("pred"),
            Opt::flag("blocks"),
        ],
    )?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("links requires a <node>"));
    };
    let repo = cli.repo()?;
    let resolved = resolve_ref(cli.store()?.conn(), &repo.repo_id, r)?
        .ok_or_else(|| CliError::engine("doc_missing", format!("no node {r}")))?;
    let direction = match (a.flag("in"), a.flag("out")) {
        (true, false) => Direction::In,
        (false, true) => Direction::Out,
        _ => Direction::Both,
    };
    let q = LinksQuery {
        direction,
        predicates: a
            .value("pred")
            .map(|p| p.split(',').map(|s| s.trim().to_owned()).collect()),
        blocks: a.flag("blocks"),
    };
    let result = doc_links(cli.store()?.conn(), resolved.doc_id(), &q)?;
    cli.capture(&result); // shell: edges (out+in) become the addressable frame
    let far: Vec<String> = ["out", "in"]
        .iter()
        .flat_map(|k| {
            result
                .get(*k)
                .and_then(Json::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .map(|e| str_of(&e, "node"))
        .collect();
    let empty = far.is_empty();
    if let Some(code) = machine_out(cli, &result, None, Some(&far)) {
        return code;
    }
    if empty {
        cli.io.err(&cli.style.dim("  no links"));
        return Ok(EXIT_OK);
    }
    render_link_groups(cli, &result, "  out", "  in (backlinks)");
    Ok(EXIT_OK)
}
