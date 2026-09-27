//! `outline` / `ol` (§6): `docs_outline`, the wire format under the wordmark.

use omgbase_surface::read::find_doc_by_ref;
use serde_json::{Value as Json, json};

use crate::cli::argv::{Mode, Opt, number, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, truncation_footer};

use super::machine_out;

pub fn outline(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "outline");
    }
    // §9 Fixed: `--section` is removed (an unknown option).
    let a = parse_args(args, &[Opt::value("depth"), Opt::flag("skeleton")])?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("outline requires a <doc|path>"));
    };
    let depth = number(&a, "depth")?;
    let skeleton = a.flag("skeleton");
    // §2.3: the tool resolves the ref; the header shows the ref as passed
    // (no local path lookup), as the reference's remote branch does.
    let (doc, header) = if cli.remote_mode() {
        (r.to_owned(), r.to_owned())
    } else {
        let repo = cli.repo()?;
        let info = find_doc_by_ref(cli.store()?.conn(), &repo.repo_id, r)?
            .ok_or_else(|| CliError::engine("doc_missing", format!("no document {r}")))?;
        (info.doc_id, info.path)
    };
    let mut req = serde_json::Map::new();
    req.insert("doc".to_owned(), json!(doc));
    if let Some(d) = depth {
        req.insert("depth".to_owned(), json!(d));
    }
    if skeleton {
        req.insert("resolution".to_owned(), json!("skeleton"));
    }
    let result = cli.call("docs_outline", Json::Object(req))?;
    let truncated = result
        .get("truncated")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let style = cli.style;
    if let Some(code) = machine_out(cli, &result, None, None) {
        if truncated && cli.flags.mode != Mode::Json {
            truncation_footer(cli.io, &style, "budget");
        }
        return code;
    }
    cli.io.out(&style.wordmark(&header));
    cli.io.out(&style.rule());
    let text = result.get("text").and_then(Json::as_str).unwrap_or("");
    for line in text.split('\n') {
        cli.io.out(line);
    }
    if truncated {
        truncation_footer(cli.io, &style, "budget");
    }
    Ok(EXIT_OK)
}
