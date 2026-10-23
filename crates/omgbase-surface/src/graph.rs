//! The `graph` neighborhood macro (`spec/surface/README.md` §4): compiled to
//! an OQX `follow _out_links { from _dst }` / `follow _in_links
//! { from _doc }` walk over the link rows (3.0 follow-up: there are no
//! `out`/`in` relations — `_dst` is a link's destination document, `_doc` its
//! source; an absent `_dst`, an external or phantom target, contributes no
//! successor) run through the shared runner and
//! shaped into `{ documents, links, frontier }`. Port of
//! `packages/core/src/mcp/graph.ts`; nothing here walks the graph itself.

use std::cmp::Ordering;
use std::collections::HashMap;

use omgbase_search::EmbeddingProvider;
use omgbase_store::Store;
use oqx::ast::{BinaryOp, Consumer, FollowDestination, SelectItem, Where};
use oqx::{build, print_query};
use serde_json::{Map, Value as Json, json};

use crate::error::{Result, SurfaceError};
use crate::query::{QueryOptions, query};
use crate::read::find_doc_by_ref;

const DEFAULT_DEGREES: i64 = 1;
const DEFAULT_MAX_DOCUMENTS: i64 = 200;
const MAX_DEPTH: i64 = 8;

/// `graph`'s arguments.
#[derive(Clone, Debug, Default)]
pub struct GraphArgs {
    pub roots: Vec<String>,
    pub degrees: Option<i64>,
    /// `in` | `out` | `both` (default).
    pub direction: Option<String>,
    pub predicate: Option<String>,
    pub select: Vec<String>,
    pub max_documents: Option<i64>,
}

/// The edge fields projected from `_out_links`/`_in_links` — the `links`
/// target's own names, projected under themselves (`spec/surface` §1.2, 5.0:
/// no rename between the language and the result) — identical for both
/// directions so a single filter handles either scan (an edge is a directional
/// fact regardless of which endpoint the walk reached it from).
const EDGE_FIELDS: [&str; 12] = [
    "_id",
    "_doc_id",
    "_block_id",
    "_via_id",
    "_dst_id",
    "_dst_path",
    "_uri",
    "_dst_kind",
    "_predicate",
    "_provenance",
    "_anchor",
    "_field",
];

// The macro's own aliases: `__oqx_`/`__omg_` (two underscores) are the
// runner's and the selector compiler's reserved prefixes; a single underscore
// is the engine prefix of 5.0, which an ALIAS may use freely (an alias is never
// a row read), and keeps these off any authored key.
const DEPTH_ALIAS: &str = "_depth";
const STOP_ALIAS: &str = "_stop";
const LINKS_ALIAS: &str = "_links";

/// The extra `select` items for caller projections. Each expression gets a
/// stable internal alias (`_u0`, `_u1`, …) so it can never collide with a
/// reserved word or the macro's own aliases; the clean output name is derived
/// separately. An expression is parsed as the item of a projection, so it may
/// be anything a `select` item may be and nothing more; a malformed one is
/// `filter_invalid`, as it would be in the `query` tool.
fn build_user_select(select: &[String]) -> Result<(Vec<SelectItem>, Vec<Option<String>>)> {
    let mut items = Vec::new();
    let mut out_names: Vec<Option<String>> = vec![None; select.len()];
    let mut used: Vec<String> = Vec::new();
    for (i, expr) in select.iter().enumerate() {
        let trimmed = expr.trim();
        if trimmed.is_empty() {
            continue;
        }
        // An identifier keeps its spelling as the output key (5.0: a `layer`
        // or `_title` selection is its own key in the document, as a `query`
        // hit's would be; an OQX `$` name too); anything else is `sel_<i>`,
        // so a projection can never overwrite the envelope here.
        let ident = trimmed.strip_prefix('$').unwrap_or(trimmed);
        let is_ident = ident
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let mut name = if is_ident {
            trimmed.to_owned()
        } else {
            format!("sel_{i}")
        };
        // The envelope keys are the row's own identity: an `_id`/`_path`
        // selection lands on them rather than beside them (the engine reads
        // the same value).
        if name != "_id" && name != "_path" {
            while used.contains(&name) {
                name = format!("{name}_{i}");
            }
            used.push(name.clone());
        }
        out_names[i] = Some(name);
        let parsed = oqx::parse_string(&format!("docs {{ select _u{i}: {trimmed} }}"))?;
        items.extend(parsed.select);
    }
    Ok((items, out_names))
}

/// The walk, as an AST (`spec/oqx/AST.md` §7) printed canonically — never
/// spliced strings: the seed ids are literals, the caller's projections parsed
/// items.
///
/// ```text
/// select _depth: $depth, _stop: $stop, _links: _<dir>_links collect { <edge fields> } <user items>
/// docs { … where _id == <root> or … follow distinct _<dir>_links { from <_dst | _doc> depth <depth> } }
/// ```
fn build_query(root_ids: &[String], dir: &str, depth: u32, user_select: &[SelectItem]) -> String {
    let mut edges_body = build::subquery();
    edges_body.select = EDGE_FIELDS
        .iter()
        .map(|name| build::field(name, build::ident(name)))
        .collect();
    let edges = build::op(
        build::ident(&format!("_{dir}_links")),
        Consumer::Collect,
        edges_body,
    );
    let mut seed: Vec<Where> = root_ids
        .iter()
        .map(|id| {
            build::scalar(build::binary(
                BinaryOp::Eq,
                build::ident("_id"),
                build::lit(id.as_str()),
            ))
        })
        .collect();
    let mut q = build::query(build::ident("docs"));
    q.select = vec![
        build::field(DEPTH_ALIAS, build::ident("$depth")),
        build::field(STOP_ALIAS, build::ident("$stop")),
        build::collect(LINKS_ALIAS, edges),
    ];
    q.select.extend(user_select.iter().cloned());
    q.r#where = Some(if seed.len() == 1 {
        seed.pop().expect("one seed")
    } else {
        build::or(seed)
    });
    // `depth` is the destination block's own clause (oqx 0.20).
    let mut step = build::subquery();
    step.from = vec![build::ident(if dir == "out" { "_dst" } else { "_doc" })];
    step.depth = Some(depth);
    let mut walk = build::follow(vec![FollowDestination::Block(Box::new(build::op(
        build::ident(&format!("_{dir}_links")),
        Consumer::Collect,
        step,
    )))]);
    walk.distinct = true;
    q.follow = Some(walk);
    print_query(&q).expect("a built query has no bindings")
}

/// Bytewise order (§9: the reference's `localeCompare` was replaced).
fn locale_compare(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

struct Doc {
    id: String,
    path: String,
    degree: i64,
    extra: Vec<(String, Json)>,
}

/// Run the macro.
pub fn graph_neighborhood(
    store: &Store,
    repo_id: &str,
    args: &GraphArgs,
    provider: Option<&dyn EmbeddingProvider>,
    now_ms: Option<i64>,
) -> Result<Json> {
    if args.roots.is_empty() {
        return Err(SurfaceError::new(
            "target_missing",
            "graph requires at least one root (path or id)",
        ));
    }
    let mut root_ids: Vec<String> = Vec::new();
    for r in &args.roots {
        let Some(info) = find_doc_by_ref(store.conn(), repo_id, r)? else {
            return Err(SurfaceError::with_data(
                "doc_missing",
                format!("no document for {}", Json::String(r.clone())),
                json!({ "root": r }),
            ));
        };
        if !root_ids.contains(&info.doc_id) {
            root_ids.push(info.doc_id);
        }
    }
    let degrees = args.degrees.unwrap_or(DEFAULT_DEGREES).max(0);
    let depth = MAX_DEPTH.min(degrees + 1);
    let walk_depth = u32::try_from(depth).expect("1..=8");
    let effective_degrees = depth - 1;
    let direction = args.direction.clone().unwrap_or_else(|| "both".to_owned());
    let max_documents =
        usize::try_from(args.max_documents.unwrap_or(DEFAULT_MAX_DOCUMENTS).max(1)).unwrap_or(1);
    let dirs: Vec<&str> = match direction.as_str() {
        "both" => vec!["out", "in"],
        "in" => vec!["in"],
        _ => vec!["out"],
    };
    let (user_select, out_names) = build_user_select(&args.select)?;

    let mut queries = Vec::new();
    let mut docs: Vec<Doc> = Vec::new();
    let mut edges: Vec<Json> = Vec::new();
    let mut query_truncated = false;
    for dir in &dirs {
        let q = build_query(&root_ids, dir, walk_depth, &user_select);
        queries.push(q.clone());
        let res = query(
            store,
            repo_id,
            &q,
            QueryOptions {
                limit: Some(max_documents + 1),
                cursor: None,
                provider,
                in_memory: false,
                bare: false,
                unknown_names: None,
                vocabulary: None,
                now_ms,
                request: None,
            },
        )?;
        if res.truncated {
            query_truncated = true;
        }
        for hit in &res.hits {
            // The walk's hits carry `_id`/`_path` (§1.4, 5.0), and so does
            // `graph`'s own envelope (§4): one spelling for a document's identity.
            let id = hit["_id"].as_str().unwrap_or_default().to_owned();
            let path = hit["_path"].as_str().unwrap_or_default().to_owned();
            let hop = hit[DEPTH_ALIAS].as_f64().unwrap_or(f64::NAN);
            let degree = (hop - 1.0) as i64;
            let replace = docs
                .iter()
                .position(|d| d.id == id)
                .map(|i| (i, degree < docs[i].degree));
            match replace {
                Some((_, false)) => {}
                found => {
                    let extra: Vec<(String, Json)> = out_names
                        .iter()
                        .enumerate()
                        .filter_map(|(i, n)| {
                            n.as_ref().map(|name| {
                                (
                                    name.clone(),
                                    hit.get(format!("_u{i}")).cloned().unwrap_or(Json::Null),
                                )
                            })
                        })
                        .collect();
                    let doc = Doc {
                        id: id.clone(),
                        path,
                        degree,
                        extra,
                    };
                    match found {
                        Some((i, true)) => docs[i] = doc,
                        _ => docs.push(doc),
                    }
                }
            }
            if let Some(raw) = hit[LINKS_ALIAS].as_array() {
                for e in raw {
                    let eid = e["_id"].as_str().unwrap_or_default();
                    if !edges.iter().any(|x| x["_id"].as_str() == Some(eid)) {
                        edges.push(e.clone());
                    }
                }
            }
        }
    }

    if let Some(p) = &args.predicate {
        let mut adj: HashMap<String, Vec<String>> = HashMap::new();
        for e in &edges {
            if e["_predicate"].as_str() != Some(p.as_str()) {
                continue;
            }
            let src = e["_doc_id"].as_str().unwrap_or_default().to_owned();
            let dst = e["_dst_id"].as_str().unwrap_or_default().to_owned();
            if dirs.contains(&"out") {
                adj.entry(src.clone()).or_default().push(dst.clone());
            }
            if dirs.contains(&"in") {
                adj.entry(dst).or_default().push(src);
            }
        }
        let mut depth_of: Vec<(String, i64)> = root_ids.iter().map(|id| (id.clone(), 0)).collect();
        let mut wave: Vec<String> = root_ids.clone();
        let mut lvl = 1;
        while lvl <= effective_degrees && !wave.is_empty() {
            let mut next = Vec::new();
            for from in &wave {
                for to in adj.get(from).map_or(&[][..], Vec::as_slice) {
                    if docs.iter().any(|d| &d.id == to) && !depth_of.iter().any(|(id, _)| id == to)
                    {
                        depth_of.push((to.clone(), lvl));
                        next.push(to.clone());
                    }
                }
            }
            wave = next;
            lvl += 1;
        }
        let mut restricted: Vec<Doc> = Vec::new();
        for (id, d) in depth_of {
            if let Some(orig) = docs.iter().find(|x| x.id == id) {
                restricted.push(Doc {
                    id: orig.id.clone(),
                    path: orig.path.clone(),
                    degree: d,
                    extra: orig.extra.clone(),
                });
            }
        }
        docs = restricted;
    }

    docs.sort_by(|a, b| {
        a.degree
            .cmp(&b.degree)
            .then_with(|| locale_compare(&a.path, &b.path))
    });
    let capped = docs.len() > max_documents;
    docs.truncate(max_documents);
    let truncated = query_truncated || capped;

    let mut frontier = Vec::new();
    let documents: Vec<Json> = docs
        .iter()
        .map(|d| {
            let is_frontier = d.degree == effective_degrees;
            if is_frontier {
                frontier.push(json!({ "_id": d.id, "_path": d.path, "degree": d.degree }));
            }
            let mut m = Map::new();
            m.insert("_id".to_owned(), json!(d.id));
            m.insert("_path".to_owned(), json!(d.path));
            m.insert("degree".to_owned(), json!(d.degree));
            m.insert("frontier".to_owned(), json!(is_frontier));
            for (k, v) in &d.extra {
                m.insert(k.clone(), v.clone());
            }
            Json::Object(m)
        })
        .collect();

    let reached = |id: &str| docs.iter().any(|d| d.id == id);
    let mut kept: Vec<Json> = edges
        .into_iter()
        .filter(|e| {
            if let Some(p) = &args.predicate
                && e["_predicate"].as_str() != Some(p.as_str())
            {
                return false;
            }
            let src_in = reached(e["_doc_id"].as_str().unwrap_or_default());
            let dst_kind = e["_dst_kind"].as_str().unwrap_or_default();
            let dst_dangling =
                dst_kind == "external" || (dst_kind == "document" && e["_dst_path"].is_null());
            let dst_in = reached(e["_dst_id"].as_str().unwrap_or_default()) || dst_dangling;
            src_in && dst_in
        })
        .collect();
    kept.sort_by(|a, b| {
        let (sa, sb) = (
            a["_doc_id"].as_str().unwrap_or_default(),
            b["_doc_id"].as_str().unwrap_or_default(),
        );
        if sa == sb {
            locale_compare(
                a["_id"].as_str().unwrap_or_default(),
                b["_id"].as_str().unwrap_or_default(),
            )
        } else {
            locale_compare(sa, sb)
        }
    });

    Ok(json!({
        "roots": root_ids,
        "degrees": effective_degrees,
        "direction": direction,
        "documents": documents,
        "links": kept,
        "frontier": frontier,
        "truncated": truncated,
        "queries": queries,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_select_aliases() {
        let (items, names) = build_user_select(&[
            "layer".into(),
            "_path".into(),
            "a + 1".into(),
            "layer".into(),
        ])
        .unwrap();
        let printed: Vec<String> = items
            .iter()
            .map(|it| oqx::print(oqx::Node::Select(it)).unwrap())
            .collect();
        assert_eq!(
            printed,
            ["_u0: layer", "_u1: _path", "_u2: a + 1", "_u3: layer"]
        );
        assert_eq!(
            names,
            [
                Some("layer".into()),
                Some("_path".into()),
                Some("sel_2".into()),
                Some("layer_3".into())
            ]
        );
        assert!(build_user_select(&[]).unwrap().0.is_empty());
        let e = build_user_select(&["a +".into()]).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
    }

    #[test]
    fn query_shape() {
        let q = build_query(&["d_0".to_owned()], "out", 2, &[]);
        assert!(q.starts_with("docs { _depth: $depth, _stop: $stop, _links: _out_links {"));
        assert!(
            q.ends_with("where _id == \"d_0\" follow distinct _out_links { from _dst depth 2 } }")
        );
        assert!(oqx::parse_string(&q).is_ok());
        // several roots: an `or` seed (the canonical print of the `or` node since
        // oqx 0.18); the generated text is exactly the macro's pinned shape
        // (spec/surface `reads.json`)
        let q = build_query(&["d_14".to_owned(), "d_15".to_owned()], "in", 8, &[]);
        assert_eq!(
            q,
            "docs { _depth: $depth, _stop: $stop, _links: _in_links { _id: _id, _doc_id: _doc_id, _block_id: _block_id, _via_id: _via_id, _dst_id: _dst_id, _dst_path: _dst_path, _uri: _uri, _dst_kind: _dst_kind, _predicate: _predicate, _provenance: _provenance, _anchor: _anchor, _field: _field } where _id == \"d_14\" or _id == \"d_15\" follow distinct _in_links { from _doc depth 8 } }"
        );
    }

    #[test]
    fn order_is_bytewise() {
        assert_eq!(locale_compare("B", "a"), Ordering::Less);
        assert_eq!(locale_compare("a", "b"), Ordering::Less);
    }
}
