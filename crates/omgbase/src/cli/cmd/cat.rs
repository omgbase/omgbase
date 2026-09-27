//! `cat` (§6): the bytes — a document's exact content, a block's raw
//! markdown (or its `nodes_get` field at another resolution).

use omgbase_surface::read::{ResolvedRef, resolve_ref};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, expand_dash, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::machine_out;

/// One ref → its text and its `--json` object.
struct CatOne {
    text: String,
    json: Json,
}

/// `raw ?? text ?? label` of a `nodes_get` object.
pub fn node_text(node: &Json) -> String {
    for k in ["raw", "text", "label"] {
        if let Some(s) = node.get(k).and_then(Json::as_str) {
            return s.to_owned();
        }
    }
    String::new()
}

fn cat_one(cli: &mut Cli, r: &str, resolution: &str) -> Result<CatOne> {
    let repo = cli.repo()?;
    let resolved = resolve_ref(cli.store()?.conn(), &repo.repo_id, r)?
        .ok_or_else(|| CliError::engine("doc_missing", format!("no node {r}")))?;
    match resolved {
        ResolvedRef::Document { doc_id } => {
            // §9 Fixed: `--json` is the `docs_read` result.
            let res = cli.call("docs_read", json!({ "doc": doc_id }))?;
            if resolution != "raw" {
                cli.io.err(&cli.style.warn(&format!(
                    "  --resolution {resolution} ignored for {r}: a document is always its exact bytes (resolutions apply to block refs)"
                )));
            }
            let text = res
                .get("content")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_owned();
            Ok(CatOne { text, json: res })
        }
        ResolvedRef::Block { doc_id, block_id } => {
            let node = cli.call(
                "nodes_get",
                json!({ "id": block_id, "doc": doc_id, "resolution": resolution }),
            )?;
            Ok(CatOne {
                text: node_text(&node),
                json: node,
            })
        }
    }
}

pub fn cat(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "cat");
    }
    let a = parse_args(args, &[Opt::value("resolution")])?;
    let refs = expand_dash(&a.positionals);
    if refs.is_empty() {
        return Err(CliError::usage(
            "cat requires a <node> (or - to read refs from stdin)",
        ));
    }
    let resolution = a.value("resolution").unwrap_or("raw").to_owned();
    let mut results: Vec<CatOne> = Vec::with_capacity(refs.len());
    for r in &refs {
        results.push(cat_one(cli, r, &resolution)?);
    }
    let items: Vec<Json> = results.iter().map(|r| r.json.clone()).collect();
    let doc = if items.len() == 1 {
        items[0].clone()
    } else {
        Json::Array(items.clone())
    };
    if let Some(code) = machine_out(cli, &doc, Some(&items), None) {
        return code;
    }
    for r in &results {
        cli.io.out(&r.text);
    }
    Ok(EXIT_OK)
}
