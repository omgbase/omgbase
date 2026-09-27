//! `hist` (§6): `history_node` for a block, newest first.

use omgbase_surface::read::{ResolvedRef, resolve_ref};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, number, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::{fmt_value, machine_out, str_of};

pub fn hist(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "hist");
    }
    let a = parse_args(args, &[Opt::value_short("n", 'n')])?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("hist requires a <node>"));
    };
    // §2.3: `history_node` keys on a block id (globally unique) — the ref
    // goes through as given; a locator would need a local resolve.
    let block_id = if cli.remote_mode() {
        r.to_owned()
    } else {
        let repo = cli.repo()?;
        let resolved = resolve_ref(cli.store()?.conn(), &repo.repo_id, r)?;
        let Some(ResolvedRef::Block { block_id, .. }) = resolved else {
            return Err(CliError::engine(
                "block_missing",
                format!("hist needs a block id; got {r}"),
            ));
        };
        block_id
    };
    let mut req = serde_json::Map::new();
    req.insert("id".to_owned(), json!(block_id));
    if let Some(n) = number(&a, "n")? {
        req.insert("limit".to_owned(), json!(n));
    }
    let changes = cli.call("history_node", Json::Object(req))?;
    let items: Vec<Json> = changes.as_array().cloned().unwrap_or_default();
    // §9 Fixed: `--ids` on a result without an id list prints the document.
    if let Some(code) = machine_out(cli, &changes, Some(&items), None) {
        return code;
    }
    let style = cli.style;
    if items.is_empty() {
        cli.io.err(&style.dim("  no history"));
        return Ok(EXIT_OK);
    }
    for c in &items {
        let conf = match c.get("confidence").and_then(Json::as_f64) {
            Some(f) => style.dim(&format!(" ({f:.2})")),
            None => String::new(),
        };
        cli.io.out(&format!(
            "{} {}{conf} {} {}",
            style.dim(&format!(
                "#{}",
                fmt_value(c.get("seq").unwrap_or(&Json::Null))
            )),
            style.accent(&str_of(c, "kind")),
            style.dim(&str_of(c, "origin")),
            style.dim(&str_of(c, "ts"))
        ));
    }
    Ok(EXIT_OK)
}
