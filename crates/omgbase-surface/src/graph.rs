//! The `graph` neighborhood macro (`spec/surface/README.md` §4): compiled to
//! an OQX `follow doc.out` / `doc.in` walk run through the shared runner and
//! shaped into `{ documents, edges, frontier }`. Port of
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

/// The edge fields projected from `doc.out_edges`/`doc.in_edges` — identical
/// for both directions so a single filter handles either scan (an edge is a
/// directional src→dst fact regardless of which endpoint the walk reached it
/// from).
const EDGE_FIELDS: [(&str, &str); 10] = [
    ("id", "$id"),
    ("src", "$src"),
    ("dst", "$dst"),
    ("dst_path", "$dst_path"),
    ("dst_uri", "$dst_uri"),
    ("dst_kind", "dst_kind"),
    ("predicate", "predicate"),
    ("provenance", "provenance"),
    ("anchor", "anchor"),
    ("src_field", "src_field"),
];

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
        let ident = trimmed.strip_prefix('$').unwrap_or(trimmed);
        let is_ident = ident
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let mut name = if is_ident {
            ident.to_owned()
        } else {
            format!("sel_{i}")
        };
        while used.contains(&name) {
            name = format!("{name}_{i}");
        }
        used.push(name.clone());
        out_names[i] = Some(name);
        let parsed = oqx::parse_string(&format!("select _u{i}: {trimmed} from docs"))?;
        items.extend(parsed.select);
    }
    Ok((items, out_names))
}

/// The walk, as an AST (`spec/oqx/AST.md` §7) printed canonically — never
/// spliced strings: the seed ids are literals, the caller's projections parsed
/// items.
///
/// ```text
/// select _depth: $depth, _stop: $stop, _edges: doc.<dir>_edges collect { <edge fields> } <user items>
/// from docs where $id == <root> || … follow distinct doc.<dir> { depth <depth> }
/// ```
fn build_query(root_ids: &[String], dir: &str, depth: u32, user_select: &[SelectItem]) -> String {
    let mut edges_body = build::subquery();
    edges_body.select = EDGE_FIELDS
        .iter()
        .map(|(name, expr)| build::field(name, build::ident(expr)))
        .collect();
    let edges = build::op(
        build::path(&["doc", &format!("{dir}_edges")]),
        Consumer::Collect,
        edges_body,
    );
    let mut seed: Vec<Where> = root_ids
        .iter()
        .map(|id| {
            build::scalar(build::binary(
                BinaryOp::Eq,
                build::ident("$id"),
                build::lit(id.as_str()),
            ))
        })
        .collect();
    let mut q = build::query(build::ident("docs"));
    q.select = vec![
        build::field("_depth", build::ident("$depth")),
        build::field("_stop", build::ident("$stop")),
        build::collect("_edges", edges),
    ];
    q.select.extend(user_select.iter().cloned());
    q.r#where = Some(if seed.len() == 1 {
        seed.pop().expect("one seed")
    } else {
        build::or(seed)
    });
    let mut walk = build::follow(vec![FollowDestination::Relation(build::path(&[
        "doc", dir,
    ]))]);
    walk.distinct = true;
    walk.depth = Some(depth);
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
            },
        )?;
        if res.truncated {
            query_truncated = true;
        }
        for hit in &res.hits {
            let id = hit["id"].as_str().unwrap_or_default().to_owned();
            let path = hit["path"].as_str().unwrap_or_default().to_owned();
            let hop = hit["_depth"].as_f64().unwrap_or(f64::NAN);
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
            if let Some(raw) = hit["_edges"].as_array() {
                for e in raw {
                    let eid = e["id"].as_str().unwrap_or_default();
                    if !edges.iter().any(|x| x["id"].as_str() == Some(eid)) {
                        edges.push(e.clone());
                    }
                }
            }
        }
    }

    if let Some(p) = &args.predicate {
        let mut adj: HashMap<String, Vec<String>> = HashMap::new();
        for e in &edges {
            if e["predicate"].as_str() != Some(p.as_str()) {
                continue;
            }
            let src = e["src"].as_str().unwrap_or_default().to_owned();
            let dst = e["dst"].as_str().unwrap_or_default().to_owned();
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
                frontier.push(json!({ "id": d.id, "path": d.path, "degree": d.degree }));
            }
            let mut m = Map::new();
            m.insert("id".to_owned(), json!(d.id));
            m.insert("path".to_owned(), json!(d.path));
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
            if let Some(p) = &args.predicate {
                if e["predicate"].as_str() != Some(p.as_str()) {
                    return false;
                }
            }
            let src_in = reached(e["src"].as_str().unwrap_or_default());
            let dst_kind = e["dst_kind"].as_str().unwrap_or_default();
            let dst_dangling =
                dst_kind == "external" || (dst_kind == "document" && e["dst_path"].is_null());
            let dst_in = reached(e["dst"].as_str().unwrap_or_default()) || dst_dangling;
            src_in && dst_in
        })
        .collect();
    kept.sort_by(|a, b| {
        let (sa, sb) = (
            a["src"].as_str().unwrap_or_default(),
            b["src"].as_str().unwrap_or_default(),
        );
        if sa == sb {
            locale_compare(
                a["id"].as_str().unwrap_or_default(),
                b["id"].as_str().unwrap_or_default(),
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
        "edges": kept,
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
            "$path".into(),
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
            ["_u0: layer", "_u1: $path", "_u2: a + 1", "_u3: layer"]
        );
        assert_eq!(
            names,
            [
                Some("layer".into()),
                Some("path".into()),
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
        assert!(
            q.starts_with("select _depth: $depth, _stop: $stop, _edges: doc.out_edges collect {")
        );
        assert!(q.ends_with("from docs where $id == \"d_0\" follow distinct doc.out { depth 2 }"));
        assert!(oqx::parse_string(&q).is_ok());
        // several roots: an `||` seed; the generated text is exactly the macro's
        // pinned shape (spec/surface `reads.json`)
        let q = build_query(&["d_14".to_owned(), "d_15".to_owned()], "in", 8, &[]);
        assert_eq!(
            q,
            "select _depth: $depth, _stop: $stop, _edges: doc.in_edges collect { id: $id, src: $src, dst: $dst, dst_path: $dst_path, dst_uri: $dst_uri, dst_kind: dst_kind, predicate: predicate, provenance: provenance, anchor: anchor, src_field: src_field } from docs where $id == \"d_14\" || $id == \"d_15\" follow distinct doc.in { depth 8 }"
        );
    }

    #[test]
    fn order_is_bytewise() {
        assert_eq!(locale_compare("B", "a"), Ordering::Less);
        assert_eq!(locale_compare("a", "b"), Ordering::Less);
    }
}
