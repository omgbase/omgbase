//! `node` (§6): `node set <nodeId> <prop> <value>` — `node_set`, one
//! surgical update of a projected node's editable property; `node props
//! <nodeId>` — the editable properties of the node's kind (a local lookup
//! with no tool). No subcommand, `help` or `--help` prints the card.

use omgbase_store::macros::editable_props_for;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::render_help_for;
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::machine_out;
use super::mutate::run_tool;

pub fn node(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let sub = args.first().map(String::as_str);
    if sub.is_none_or(|s| s == "help") || args.iter().any(|a| a == "--help") {
        return render_help_for(cli, "node");
    }
    let rest = &args[1..];
    match sub.unwrap_or_default() {
        "set" => set(cli, rest),
        "props" => props(cli, rest),
        other => Err(CliError::usage(format!(
            "unknown node subcommand '{other}' (set|props)"
        ))),
    }
}

fn set(cli: &mut Cli, rest: &[String]) -> Result<i32> {
    // §9 Fixed: `--actor` is an option with a value, taken out by the parser —
    // the value is every positional after <prop>, joined by a space.
    let a = parse_args(rest, &[Opt::value("actor")])?;
    let (Some(node_id), Some(prop)) = (a.pos(0), a.pos(1)) else {
        return Err(CliError::usage("node set <nodeId> <prop> <value>"));
    };
    if a.positionals.len() < 3 {
        return Err(CliError::usage("node set <nodeId> <prop> <value>"));
    }
    let value = a.positionals[2..].join(" ");
    let mut m = Map::new();
    m.insert("node".to_owned(), json!(node_id));
    m.insert("prop".to_owned(), json!(prop));
    m.insert("value".to_owned(), json!(value));
    run_tool(cli, "node_set", m, a.value("actor"))
}

fn props(cli: &mut Cli, rest: &[String]) -> Result<i32> {
    let a = parse_args(rest, &[])?;
    let Some(node_id) = a.pos(0) else {
        return Err(CliError::usage("node props <nodeId>"));
    };
    let node_id = node_id.to_owned();
    let row: Option<(String, String)> = cli
        .store()?
        .conn()
        .query_row(
            "SELECT n.kind, d.format FROM nodes n JOIN docs d ON d.doc_id = n.doc_id WHERE n.node_id = ?1",
            params![node_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((kind, format)) = row else {
        return Err(CliError::engine(
            "block_missing",
            format!("no node {node_id}"),
        ));
    };
    let editable = editable_props_for(&format, &kind);
    let doc = json!({ "node": node_id, "kind": kind, "editable": editable });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    if editable.is_empty() {
        cli.io.err(
            &cli.style
                .dim(&format!("  {kind} has no editable properties")),
        );
    } else {
        cli.io.out(&format!(
            "  {} {} {}",
            cli.style.accent(&kind),
            cli.style.dim("editable:"),
            editable.join(", ")
        ));
    }
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_is_the_remaining_positionals() {
        let a = parse_args(
            &["n_1", "text", "two", "words", "--actor", "human:spec"].map(str::to_owned),
            &[Opt::value("actor")],
        )
        .unwrap();
        assert_eq!(a.positionals[2..].join(" "), "two words");
        assert_eq!(a.value("actor"), Some("human:spec"));
    }
}
