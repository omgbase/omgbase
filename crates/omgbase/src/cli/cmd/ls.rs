//! `ls` (§6): `docs_list`, every page walked.

use serde_json::{Value as Json, json};

use crate::cli::argv::parse_args;
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{EXIT_OK, Result};
use crate::cli::render::{Align, columns, rel_time};

use super::{i64_of, machine_out, str_of};

pub fn ls(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "ls");
    }
    let a = parse_args(args, &[])?;
    let glob = a.pos(0).map(str::to_owned);
    let mut rows: Vec<Json> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut req = serde_json::Map::new();
        if let Some(g) = &glob {
            req.insert("path_glob".to_owned(), json!(g));
        }
        if let Some(c) = &cursor {
            req.insert("cursor".to_owned(), json!(c));
        }
        let page = cli.call("docs_list", Json::Object(req))?;
        if let Some(items) = page.get("items").and_then(Json::as_array) {
            rows.extend(items.iter().cloned());
        }
        let truncated = page
            .get("truncated")
            .and_then(Json::as_bool)
            .unwrap_or(false);
        cursor = page
            .get("cursor")
            .and_then(Json::as_str)
            .map(str::to_owned)
            .filter(|_| truncated);
        if cursor.is_none() {
            break;
        }
    }
    let doc = Json::Array(rows.clone());
    cli.capture(&doc); // shell: docs become the addressable frame (ref = path)
    let paths: Vec<String> = rows.iter().map(|r| str_of(r, "path")).collect();
    if let Some(code) = machine_out(cli, &doc, Some(&rows), Some(&paths)) {
        return code;
    }
    let style = cli.style;
    if rows.is_empty() {
        cli.io.err(&style.dim("  no documents"));
        return Ok(EXIT_OK);
    }
    let now = cli.now_ms();
    let table: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            vec![
                style.accent(&str_of(r, "path")),
                style.dim(&format!("{} blocks", i64_of(r, "blocks"))),
                style.dim(&rel_time(r.get("ts").and_then(Json::as_str), now)),
            ]
        })
        .collect();
    for line in columns(&table, &[Align::Left, Align::Right, Align::Right]) {
        cli.io.out(&line);
    }
    Ok(EXIT_OK)
}
