//! `find` (§6): `resolve` — ranked `{ id, locator, preview, evidence }`.

use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, number, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};

use super::{machine_out, str_of};

pub fn find(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "find");
    }
    let a = parse_args(
        args,
        &[
            Opt::value_short("n", 'n'),
            Opt::flag_short("one", '1'),
            Opt::flag_short("verbose", 'v'),
            Opt::flag("no-semantic"),
        ],
    )?;
    let text = a.positionals.join(" ").trim().to_owned();
    if text.is_empty() {
        return Err(CliError::usage("find requires <text>"));
    }
    let limit = if a.flag("one") {
        1
    } else {
        number(&a, "n")?.unwrap_or(10)
    };
    // Hybrid by default: the configured provider fuses the query vector into
    // the ranking; `--no-semantic` keeps it FTS-only.
    let semantic = !a.flag("no-semantic");
    let hits = cli
        .surface(semantic)?
        .call_result("resolve", &json!({ "query": text, "limit": limit }))?;
    let items: Vec<Json> = hits.as_array().cloned().unwrap_or_default();
    cli.capture(&hits); // shell: the ranked hits become the addressable frame
    if a.flag("one") {
        if let Some(h) = items.first() {
            cli.io.out(&str_of(h, "id"));
        }
        return Ok(EXIT_OK);
    }
    let ids: Vec<String> = items.iter().map(|h| str_of(h, "id")).collect();
    if let Some(code) = machine_out(cli, &hits, Some(&items), Some(&ids)) {
        return code;
    }
    let style = cli.style;
    if items.is_empty() {
        cli.io.err(&style.dim("  no matches"));
        return Ok(EXIT_OK);
    }
    for h in &items {
        cli.io.out(&format!(
            "{}  {}  {}",
            style.id(&str_of(h, "id")),
            style.accent(&str_of(h, "locator")),
            str_of(h, "preview")
        ));
        if a.flag("verbose") {
            cli.io.err(&style.dim(&format!(
                "    {}",
                js_json(h.get("evidence").unwrap_or(&Json::Null))
            )));
        }
    }
    Ok(EXIT_OK)
}
