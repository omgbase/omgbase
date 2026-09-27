//! `retarget` (§6): `links_retarget`, plan by default — per hit the block id
//! and the unified diff of its raw (§9 Fixed: the same diff every preview
//! prints); `--apply` commits through the block confirmation and honors
//! `--dry-run` like any block mutator.

use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::mutate::{apply_result_of, render_apply, require_root, set_actor, unified_diff_lines};
use super::{machine_out, str_of};

pub fn retarget(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "retarget");
    }
    let a = parse_args(
        args,
        &[Opt::value("scope"), Opt::flag("apply"), Opt::value("actor")],
    )?;
    let (Some(from), Some(to)) = (a.pos(0), a.pos(1)) else {
        return Err(CliError::usage("retarget requires <from> and <to> targets"));
    };
    let (from, to) = (from.to_owned(), to.to_owned());
    let apply = a.flag("apply");
    require_root(cli)?;
    if apply {
        set_actor(cli, a.value("actor"))?;
    }
    let mut m = Map::new();
    m.insert("from_target".to_owned(), json!(from));
    m.insert("to_target".to_owned(), json!(to));
    if let Some(g) = a.value("scope").filter(|g| !g.is_empty()) {
        m.insert("path_glob".to_owned(), json!(g));
    }
    m.insert("dry_run".to_owned(), json!(!apply || cli.flags.dry_run));
    let res = cli.call("links_retarget", Json::Object(m))?;
    if apply {
        return render_apply(cli, apply_result_of(res));
    }
    // The plan: `{ from, to, hits }` (§9 Fixed: the `links_retarget` dry run).
    let hits: Vec<Json> = res
        .get("hits")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let plan = json!({ "from": from, "to": to, "hits": hits });
    cli.capture(&plan);
    if let Some(code) = machine_out(cli, &plan, None, None) {
        return code;
    }
    if hits.is_empty() {
        cli.io
            .err(&cli.style.dim(&format!("  no blocks reference {from}")));
        return Ok(EXIT_OK);
    }
    cli.io.err(&cli.style.dim(&format!(
        "  plan — {} block(s) would change; re-run with --apply to commit",
        hits.len()
    )));
    for h in &hits {
        cli.io.out(&cli.style.id(&str_of(h, "block")));
        for line in unified_diff_lines(&str_of(h, "oldRaw"), &str_of(h, "newRaw")) {
            let styled = if line.starts_with('+') {
                cli.style.ok(&line)
            } else if line.starts_with('-') {
                cli.style.err(&line)
            } else {
                cli.style.dim(&line)
            };
            cli.io.out(&styled);
        }
        cli.io.out("");
    }
    Ok(EXIT_OK)
}
