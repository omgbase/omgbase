//! `diff` (§6): `diff_unified` between two revisions (default: previous →
//! current); `--blocks` is the block-grain `diff` tool over the same pair.

use omgbase_surface::read::find_doc_by_ref;
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::{machine_out, str_of};

pub fn diff(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "diff");
    }
    let a = parse_args(
        args,
        &[Opt::value("from"), Opt::value("to"), Opt::flag("blocks")],
    )?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("diff requires a <doc>"));
    };
    // §2.3: remotely the ref goes to the tool, which resolves it.
    let doc = if cli.remote_mode() {
        r.to_owned()
    } else {
        let repo = cli.repo()?;
        find_doc_by_ref(cli.store()?.conn(), &repo.repo_id, r)?
            .ok_or_else(|| CliError::engine("doc_missing", format!("no document {r}")))?
            .doc_id
    };
    let mut req = serde_json::Map::new();
    req.insert("doc".to_owned(), json!(doc));
    if let Some(f) = a.value("from") {
        req.insert("from_rev".to_owned(), json!(f));
    }
    if let Some(t) = a.value("to") {
        req.insert("to_rev".to_owned(), json!(t));
    }
    let result = cli.call("diff_unified", Json::Object(req))?;
    let style = cli.style;
    if a.flag("blocks") {
        // Block-grain over the same resolved revision pair.
        let entries = cli.call(
            "diff",
            json!({ "doc": doc, "from_rev": str_of(&result, "from"), "to_rev": str_of(&result, "to") }),
        )?;
        let items: Vec<Json> = entries.as_array().cloned().unwrap_or_default();
        let ids: Vec<String> = items.iter().map(|e| str_of(e, "blockId")).collect();
        if let Some(code) = machine_out(cli, &entries, Some(&items), Some(&ids)) {
            return code;
        }
        if items.is_empty() {
            cli.io.err(&style.dim("  no changes"));
            return Ok(EXIT_OK);
        }
        for e in &items {
            let mark = match str_of(e, "kind").as_str() {
                "added" => style.ok("+"),
                "removed" => style.err("-"),
                _ => style.warn("~"),
            };
            let preview = e
                .get("after")
                .or_else(|| e.get("before"))
                .and_then(Json::as_str)
                .unwrap_or("")
                .split('\n')
                .next()
                .unwrap_or("")
                .to_owned();
            let line = format!("{mark} {}  {preview}", style.id(&str_of(e, "blockId")));
            cli.io.out(line.trim_end());
        }
        return Ok(EXIT_OK);
    }
    // §9 Fixed: every machine mode prints the `diff_unified` document.
    if let Some(code) = machine_out(cli, &result, None, None) {
        return code;
    }
    let text = result.get("diff").and_then(Json::as_str).unwrap_or("");
    if text.is_empty() {
        cli.io.err(&style.dim("  no changes"));
        return Ok(EXIT_OK);
    }
    for line in text.split('\n') {
        if line.starts_with('+') {
            cli.io.out(&style.ok(line));
        } else if line.starts_with('-') {
            cli.io.out(&style.err(line));
        } else {
            cli.io.out(line);
        }
    }
    Ok(EXIT_OK)
}
