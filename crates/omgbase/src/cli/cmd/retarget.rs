//! `retarget` (§6; cli 4.0): plan by default — without `--apply` it is `plan
//! { effects: [retarget] }` and prints, per hit of the Plan's
//! `preview.retarget[0].hits`, the block id and the unified diff of its raw
//! (§9 Fixed: the same diff every preview prints); `--apply` commits the
//! `links_retarget` tool's call (the Receipt + `hits` + `pairs`) through the
//! Receipt confirmation and honors `--dry-run` like any block mutator (§3.6).

use omgbase_store::sugar;
use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::mutate::{effects_json, run_tool, unified_diff_lines};
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
    let scope = a
        .value("scope")
        .filter(|g| !g.is_empty())
        .map(str::to_owned);
    let effects = sugar::retarget(&[(from.clone(), to.clone())], scope.as_deref());
    if a.flag("apply") {
        let mut m = Map::new();
        m.insert("from_target".to_owned(), json!(from));
        m.insert("to_target".to_owned(), json!(to));
        if let Some(g) = &scope {
            m.insert("path_glob".to_owned(), json!(g));
        }
        return run_tool(
            cli,
            "links_retarget",
            m,
            a.value("actor"),
            Vec::new(),
            move |_| Ok(effects),
        );
    }
    // The plan (default): `{ from, to, hits }` from the Plan's
    // `preview.retarget[0]` (a plan over no hit still carries it, empty).
    let plan = cli.call(
        "plan",
        json!({ "effects": effects_json(&effects), "diffs": true }),
    )?;
    let hits: Vec<Json> = plan["preview"]["retarget"][0]["hits"]
        .as_array()
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
        cli.io.out(&cli.style.id(&str_of(h, "_id")));
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
