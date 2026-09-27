//! `query` / `q` and `run` (§6): OQX over the `query` tool, rendered by the
//! result's consumer — a scalar, bare values, or the hit table (§4).

use omgbase_surface::collect_semantic_phrases;
use omgbase_surface::read::{BlockNode, ResolvedRef, block_raw, load_doc_blocks, resolve_ref};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Mode, Opt, number, parse_args, read_stdin};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, js_json, render_hits, truncation_footer};

use super::{fmt_value, str_of};

/// Run `source` with the query tool; a `semantic(...)` phrase needs the
/// provider (none configured → `semantic_unavailable` with the config hint).
pub fn run_source(
    cli: &mut Cli,
    source: &str,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<Json> {
    // §2.3: remotely the engine's own provider (or its `semantic_unavailable`)
    // answers; the local provider check would open the workspace.
    let semantic = !collect_semantic_phrases(source).is_empty();
    if semantic && !cli.remote_mode() && !cli.has_provider()? {
        return Err(CliError::engine_hint(
            "semantic_unavailable",
            "semantic(...) needs an embedding provider",
            format!("{} config set embedding.provider <command|url>", cli.prog),
        ));
    }
    let mut req = serde_json::Map::new();
    req.insert("query".to_owned(), json!(source));
    if let Some(l) = limit {
        req.insert("limit".to_owned(), json!(l));
    }
    if let Some(c) = cursor {
        req.insert("cursor".to_owned(), json!(c));
    }
    cli.call_with("query", Json::Object(req), semantic)
}

/// The projected column names of `source`'s top-level `select`, in order —
/// a projected key heads its column even when every hit lacks it (the
/// reference's hits carry the key with `undefined`; the wire drops it).
fn projected_columns(source: &str) -> Vec<String> {
    oqx::parse_string(source)
        .map(|q| {
            q.select
                .iter()
                .map(|item| item.name().to_owned())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Shell capture (the typed result before formatting): a scalar for
/// count/exists/none, the bare `values`, else the whole result (its `hits`
/// become the addressable frame).
fn capture_result(cli: &mut Cli, result: &Json) {
    if !cli.capturing {
        return;
    }
    let consumer = str_of(result, "consumer");
    let captured = match consumer.as_str() {
        "count" | "exists" | "none" => result.get(&consumer).cloned().unwrap_or(Json::Null),
        _ => result
            .get("values")
            .cloned()
            .unwrap_or_else(|| result.clone()),
    };
    cli.capture(&captured);
}

/// Render an `OqxResult` per the mode and the consumer.
pub fn render_result(cli: &Cli, result: &Json, source: &str) -> Result<i32> {
    let style = cli.style;
    let io = cli.io;
    if cli.flags.mode == Mode::Json {
        io.out(&js_json(result));
        return Ok(EXIT_OK);
    }
    let consumer = str_of(result, "consumer");
    if matches!(consumer.as_str(), "count" | "exists" | "none") {
        io.out(&fmt_value(result.get(&consumer).unwrap_or(&Json::Null)));
        return Ok(EXIT_OK);
    }
    let truncated = result
        .get("truncated")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let cursor = str_of(result, "cursor");
    if let Some(values) = result.get("values").and_then(Json::as_array) {
        for v in values {
            match v {
                Json::String(s) if cli.flags.mode != Mode::Jsonl => io.out(s),
                other => io.out(&js_json(other)),
            }
        }
        if truncated {
            truncation_footer(io, &style, &cursor);
        }
        return Ok(EXIT_OK);
    }
    let hits: Vec<Json> = result
        .get("hits")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    match cli.flags.mode {
        Mode::Ids => {
            for h in &hits {
                io.out(&str_of(h, "id"));
            }
        }
        Mode::Jsonl => {
            for h in &hits {
                io.out(&js_json(h));
            }
        }
        _ => {
            if hits.is_empty() {
                io.err(&style.dim("  no hits"));
                return Ok(EXIT_OK);
            }
            render_hits(io, &style, &hits, &projected_columns(source));
        }
    }
    if truncated {
        truncation_footer(io, &style, &cursor);
    }
    Ok(EXIT_OK)
}

pub fn query(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "query");
    }
    let a = parse_args(
        args,
        &[
            Opt::value_short("n", 'n'),
            Opt::value("cursor"),
            Opt::value_short("file", 'f'),
        ],
    )?;
    let source = match a.value("file") {
        Some("-") => read_stdin(),
        Some(f) => std::fs::read_to_string(f)?,
        None => a.positionals.join(" "),
    };
    let source = source.trim().to_owned();
    if source.is_empty() {
        // §9 Fixed: an empty or missing source is a usage error.
        return Err(CliError::usage("query requires a <source> (or -f file|-)"));
    }
    let limit = number(&a, "n")?;
    let result = run_source(cli, &source, limit, a.value("cursor"))?;
    capture_result(cli, &result);
    render_result(cli, &result, &source)
}

fn first_omg_fence(roots: &[BlockNode]) -> Option<&BlockNode> {
    for n in roots {
        if n.kind == "code_fence" && n.attrs.get("lang").and_then(Json::as_str) == Some("omg") {
            return Some(n);
        }
        if let Some(inner) = first_omg_fence(&n.children) {
            return Some(inner);
        }
    }
    None
}

fn find_block<'n>(roots: &'n [BlockNode], id: &str) -> Option<&'n BlockNode> {
    for n in roots {
        if n.block_id == id {
            return Some(n);
        }
        if let Some(inner) = find_block(&n.children, id) {
            return Some(inner);
        }
    }
    None
}

/// The body of a fence: the opening and closing ``` lines dropped.
fn fence_body(raw: &str) -> String {
    let mut lines: Vec<&str> = raw.split('\n').collect();
    if lines
        .first()
        .is_some_and(|l| l.trim_start().starts_with("```"))
    {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines
        .last()
        .is_some_and(|l| l.trim_start().starts_with("```"))
    {
        lines.pop();
    }
    lines.join("\n")
}

pub fn run(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "run");
    }
    let a = parse_args(args, &[])?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("run requires a <locator|path>"));
    };
    let repo = cli.repo()?;
    let raw = {
        let conn = cli.store()?.conn();
        let resolved = resolve_ref(conn, &repo.repo_id, r)?
            .ok_or_else(|| CliError::engine("doc_missing", format!("no node {r}")))?;
        match resolved {
            ResolvedRef::Block { doc_id, block_id } => {
                let roots = load_doc_blocks(conn, &doc_id)?;
                let node = find_block(&roots, &block_id).filter(|n| n.kind == "code_fence");
                let Some(node) = node else {
                    return Err(CliError::engine(
                        "opaque_block",
                        format!("block {r} is not an omg fence"),
                    ));
                };
                block_raw(conn, &node.raw_hash_hex)?
            }
            ResolvedRef::Document { doc_id } => {
                let roots = load_doc_blocks(conn, &doc_id)?;
                let Some(fence) = first_omg_fence(&roots) else {
                    return Err(CliError::engine(
                        "target_missing",
                        format!("no ```omg fence in {r}"),
                    ));
                };
                block_raw(conn, &fence.raw_hash_hex)?
            }
        }
    };
    let source = fence_body(&raw).trim().to_owned();
    if source.is_empty() {
        return Err(CliError::engine(
            "target_missing",
            format!("the omg fence in {r} is empty"),
        ));
    }
    let result = run_source(cli, &source, None, None)?;
    capture_result(cli, &result);
    render_result(cli, &result, &source)
}
