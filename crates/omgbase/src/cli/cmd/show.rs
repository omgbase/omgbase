//! `show` (§6): the metadata card — a document's properties and edges, a
//! block's type, placement, attrs, text and (with `--include history`) its
//! last five changes.

use omgbase_surface::read::{ResolvedRef, find_doc_by_id, resolve_ref};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, expand_dash, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};
use crate::cli::render::type_glyph;

use super::links::{LinksQuery, doc_links, render_link_groups};
use super::{fmt_value, machine_out, str_of};

/// One card: its `--json` payload and the human rendering.
enum Card {
    Document {
        payload: Json,
        path: String,
        properties: Json,
        links: Json,
    },
    Block {
        payload: Json,
        history: Option<Json>,
    },
}

impl Card {
    fn payload(&self) -> &Json {
        match self {
            Card::Document { payload, .. } | Card::Block { payload, .. } => payload,
        }
    }
}

fn show_one(cli: &mut Cli, r: &str, include_history: bool) -> Result<Card> {
    let repo = cli.repo()?;
    let resolved = resolve_ref(cli.store()?.conn(), &repo.repo_id, r)?
        .ok_or_else(|| CliError::engine("doc_missing", format!("no node {r}")))?;
    match resolved {
        ResolvedRef::Document { doc_id } => {
            let (path, properties, links) = {
                let store = cli.store()?;
                let info = find_doc_by_id(store.conn(), &doc_id)?
                    .ok_or_else(|| CliError::engine("doc_missing", format!("no node {r}")))?;
                let links = doc_links(store.conn(), &doc_id, &LinksQuery::default())?;
                (info.path, store.properties_merged(&doc_id)?, links)
            };
            // §9 Fixed: `--json` is the `read_ref` result.
            let payload = cli.call("read_ref", json!({ "ref": doc_id }))?;
            Ok(Card::Document {
                payload,
                path,
                properties,
                links,
            })
        }
        ResolvedRef::Block { doc_id, block_id } => {
            let node = cli.call(
                "nodes_get",
                json!({ "id": block_id, "doc": doc_id, "resolution": "full" }),
            )?;
            let history = if include_history {
                Some(cli.call("history_node", json!({ "id": block_id, "limit": 5 }))?)
            } else {
                None
            };
            let mut payload = node;
            if let (Some(h), Some(m)) = (&history, payload.as_object_mut()) {
                m.insert("history".to_owned(), h.clone());
            }
            Ok(Card::Block { payload, history })
        }
    }
}

fn render_doc_card(cli: &Cli, path: &str, properties: &Json, links: &Json) {
    let style = cli.style;
    cli.io.out(&style.wordmark(path));
    cli.io.out(&style.rule());
    if let Some(m) = properties.as_object().filter(|m| !m.is_empty()) {
        cli.io.out(&format!("  {}", style.dim("properties")));
        for (k, v) in m {
            cli.io.out(&format!(
                "    {} {} {}",
                style.accent(k),
                style.dim("="),
                fmt_value(v)
            ));
        }
    }
    render_link_groups(cli, links, "  out edges", "  backlinks");
}

fn render_block_card(cli: &Cli, node: &Json, history: Option<&Json>) {
    let style = cli.style;
    let kind = str_of(node, "type");
    cli.io.out(&format!(
        "  {} {}  {}",
        type_glyph(&style, &kind),
        style.bold(&kind),
        style.id(&str_of(node, "id"))
    ));
    cli.io.out(&style.rule());
    if let Some(p) = node.get("placement").filter(|p| p.is_object()) {
        let parent = p
            .get("parent")
            .and_then(Json::as_str)
            .unwrap_or("—")
            .to_owned();
        cli.io.out(&format!(
            "  {}  parent={} ordinal={} depth={}",
            style.dim("placement"),
            style.id(&parent),
            fmt_value(p.get("ordinal").unwrap_or(&Json::Null)),
            fmt_value(p.get("depth").unwrap_or(&Json::Null))
        ));
    }
    if let Some(attrs) = node.get("attrs").and_then(Json::as_object) {
        if !attrs.is_empty() {
            cli.io.out(&format!("  {}", style.dim("attrs")));
            for (k, v) in attrs {
                cli.io.out(&format!(
                    "    {} {} {}",
                    style.accent(k),
                    style.dim("="),
                    fmt_value(v)
                ));
            }
        }
    }
    if let Some(text) = node.get("text").and_then(Json::as_str) {
        if !text.is_empty() {
            cli.io.out(&format!("  {}  {text}", style.dim("text")));
        }
    }
    if let Some(items) = history.and_then(Json::as_array) {
        if !items.is_empty() {
            cli.io.out(&format!("  {}", style.dim("history")));
            for h in items {
                cli.io.out(&format!(
                    "    {} {} {} {}",
                    style.dim(&format!(
                        "#{}",
                        fmt_value(h.get("seq").unwrap_or(&Json::Null))
                    )),
                    style.accent(&str_of(h, "kind")),
                    style.dim(&str_of(h, "origin")),
                    style.dim(&str_of(h, "ts"))
                ));
            }
        }
    }
}

pub fn show(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "show");
    }
    let a = parse_args(args, &[Opt::value("include")])?;
    let refs = expand_dash(&a.positionals);
    if refs.is_empty() {
        return Err(CliError::usage(
            "show requires a <node> (or - to read refs from stdin)",
        ));
    }
    let include_history = a
        .value("include")
        .unwrap_or("")
        .split(',')
        .any(|s| s.trim() == "history");
    let mut cards: Vec<Card> = Vec::with_capacity(refs.len());
    for r in &refs {
        cards.push(show_one(cli, r, include_history)?);
    }
    let items: Vec<Json> = cards.iter().map(|c| c.payload().clone()).collect();
    let doc = if items.len() == 1 {
        items[0].clone()
    } else {
        Json::Array(items.clone())
    };
    cli.capture(&doc); // shell: the card (a single entity) or the list of cards
    if let Some(code) = machine_out(cli, &doc, Some(&items), None) {
        return code;
    }
    for c in &cards {
        match c {
            Card::Document {
                path,
                properties,
                links,
                ..
            } => render_doc_card(cli, path, properties, links),
            Card::Block { payload, history } => render_block_card(cli, payload, history.as_ref()),
        }
    }
    Ok(EXIT_OK)
}
