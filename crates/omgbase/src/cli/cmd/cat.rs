//! `cat` (§6): the bytes — a document's exact content, a block's raw
//! markdown (or its `nodes_get` field at another resolution).

use omgbase_surface::read::{ResolvedRef, resolve_ref};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, expand_dash, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::machine_out;

/// One ref → its text, its `--json` object, and what the shell captures.
struct CatOne {
    text: String,
    json: Json,
    capture: Json,
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

/// §2.3: the polymorphic `read_ref` classifies and reads the ref server-side
/// — `{ kind: "document", ...docs_read }` or `{ kind: "block", ...nodes_get }`.
/// The document's `--json` is the `docs_read` result (`kind` dropped, the
/// other keys in their order); a block's is the `read_ref` result as it came
/// (with `kind`), as the reference renders it.
fn cat_one_remote(cli: &mut Cli, r: &str, resolution: &str) -> Result<CatOne> {
    let mut req = serde_json::Map::new();
    req.insert("ref".to_owned(), json!(r));
    if resolution != "raw" {
        req.insert("resolution".to_owned(), json!(resolution));
    }
    let res = cli.call("read_ref", Json::Object(req))?;
    if res.get("kind").and_then(Json::as_str) == Some("document") {
        if resolution != "raw" {
            warn_doc_resolution(cli, r, resolution);
        }
        let text = res
            .get("content")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned();
        let doc = match res {
            Json::Object(m) => Json::Object(m.into_iter().filter(|(k, _)| k != "kind").collect()),
            other => other,
        };
        return Ok(CatOne {
            capture: Json::String(text.clone()),
            text,
            json: doc,
        });
    }
    Ok(CatOne {
        text: node_text(&res),
        capture: res.clone(),
        json: res,
    })
}

/// `--resolution` only means something for a block; say so (stderr).
fn warn_doc_resolution(cli: &Cli, r: &str, resolution: &str) {
    cli.io.err(&cli.style.warn(&format!(
        "  --resolution {resolution} ignored for {r}: a document is always its exact bytes (resolutions apply to block refs)"
    )));
}

fn cat_one(cli: &mut Cli, r: &str, resolution: &str) -> Result<CatOne> {
    if cli.remote_mode() {
        return cat_one_remote(cli, r, resolution);
    }
    let repo = cli.repo()?;
    let resolved = resolve_ref(cli.store()?.conn(), &repo.repo_id, r)?
        .ok_or_else(|| CliError::engine("doc_missing", format!("no node {r}")))?;
    match resolved {
        ResolvedRef::Document { doc_id } => {
            // §9 Fixed: `--json` is the `docs_read` result.
            let res = cli.call("docs_read", json!({ "doc": doc_id }))?;
            if resolution != "raw" {
                warn_doc_resolution(cli, r, resolution);
            }
            let text = res
                .get("content")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_owned();
            // shell: the bytes (a string; `@_` only). `--json` is the `docs_read` result.
            let capture = Json::String(text.clone());
            Ok(CatOne {
                text,
                json: res,
                capture,
            })
        }
        ResolvedRef::Block { doc_id, block_id } => {
            let node = cli.call(
                "nodes_get",
                json!({ "id": block_id, "doc": doc_id, "resolution": resolution }),
            )?;
            Ok(CatOne {
                text: node_text(&node),
                capture: node.clone(), // shell: the block (a single entity)
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
    // One ref keeps the single-entity shape (a string/object); several become a list.
    if cli.capturing {
        let captured = match results.as_slice() {
            [one] => one.capture.clone(),
            many => Json::Array(many.iter().map(|r| r.capture.clone()).collect()),
        };
        cli.capture(&captured);
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
