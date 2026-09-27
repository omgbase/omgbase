//! `status` (§6): `repos_status` + `sync_status` + the watch-lease probe +
//! the embed queue depth.

use std::path::Path;

use omgbase_sync::{RealFileSystem, WatchLease};
use serde_json::{Value as Json, json};

use crate::cli::argv::parse_args;
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{EXIT_OK, Result, js_json};
use crate::cli::render::{pad_end, shorten_home};

/// `spec/search` §2.3 (§9 Fixed): the stale embeddable blocks — the embed
/// tasks whose `(content_hash, ctx_hash[, model])` has no cached vector;
/// the model is the effective `embedding.model` when one is set.
fn embed_queue(cli: &mut Cli, repo_id: &str) -> Result<i64> {
    let store = cli.store()?;
    let model = omgbase_sync::resolve_settings(store, Some(repo_id))?
        .get("embedding")
        .and_then(|e| e.get("model"))
        .and_then(serde_json::Value::as_str)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let conn = store.conn();
    let tasks = omgbase_store::search::build_embed_tasks(conn, repo_id)?;
    let mut stale = 0i64;
    for t in &tasks {
        let content = omgbase_store::tree::from_hex(&t.content_hash)?;
        let ctx = omgbase_search::ctx_hash(&t.ctx);
        let cached = match &model {
            Some(m) => conn
                .prepare_cached(
                    "SELECT 1 FROM embeddings WHERE content_hash = ?1 AND ctx_hash = ?2 AND model = ?3",
                )?
                .exists(rusqlite::params![content, &ctx[..], m])?,
            None => conn
                .prepare_cached(
                    "SELECT 1 FROM embeddings WHERE content_hash = ?1 AND ctx_hash = ?2",
                )?
                .exists(rusqlite::params![content, &ctx[..]])?,
        };
        if !cached {
            stale += 1;
        }
    }
    Ok(stale)
}

pub fn status(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "status");
    }
    parse_args(args, &[])?;
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let queued = embed_queue(cli, &repo.repo_id)?;
    let (rs, ss) = {
        let store = cli.store()?;
        let fs = RealFileSystem;
        let disk = repo
            .root_path
            .as_deref()
            .map(|r| (&fs as &dyn omgbase_sync::FileSystem, Path::new(r)));
        (
            omgbase_sync::repos_status(store, &repo.repo_id, disk)?,
            omgbase_sync::sync_status(store, &repo.repo_id, disk)?,
        )
    };
    let watcher = if WatchLease::live(&ws.omgbase_dir) {
        "live"
    } else {
        "none"
    };

    if cli.machine() {
        // §9 Fixed: `{ ...repos_status, sync: sync_status, watcher, embedQueue }`.
        let mut m = match rs.to_json() {
            Json::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        m.insert("sync".to_owned(), ss.to_json());
        m.insert("watcher".to_owned(), json!(watcher));
        m.insert("embedQueue".to_owned(), json!(queued));
        cli.io.out(&js_json(&Json::Object(m)));
        return Ok(EXIT_OK);
    }

    let style = cli.style;
    let g = style.glyphs();
    cli.io.out(&style.wordmark(&repo.slug));
    cli.io.out(&format!(
        "  {}",
        style.path(
            &repo
                .root_path
                .as_deref()
                .map_or_else(|| "(no source — headless)".to_owned(), shorten_home,)
        )
    ));
    cli.io.out(&style.rule());

    let synced = if ss.convergent {
        format!("{} converged", style.ok(g.ok))
    } else {
        let mut parts: Vec<String> = Vec::new();
        if rs.unconverged > 0 {
            parts.push(format!("{} behind", rs.unconverged));
        }
        if ss.disk.drift.deleted > 0 {
            parts.push(format!("{} deleted", ss.disk.drift.deleted));
        }
        if ss.disk.drift.changed > 0 {
            parts.push(format!("{} drifted", ss.disk.drift.changed));
        }
        if ss.disk.drift.untracked > 0 {
            parts.push(format!("{} untracked", ss.disk.drift.untracked));
        }
        if !ss.disk.checked {
            parts.push("disk unverified".to_owned());
        }
        let label = if parts.is_empty() {
            "unconverged".to_owned()
        } else {
            parts.join(", ")
        };
        format!("{} {label}", style.warn(g.warn))
    };
    let left: [(String, String); 4] = [
        (format!("{} docs", style.path(g.doc)), rs.docs.to_string()),
        (
            format!("{} blocks", style.dim(g.block)),
            rs.blocks.to_string(),
        ),
        (format!("{} commits", g.diamond), rs.commits.to_string()),
        (format!("{} edges", g.arrow), rs.open_edges.to_string()),
    ];
    let right: [(&str, String); 4] = [
        (
            "watcher",
            if watcher == "live" {
                format!("{} live", style.ok(g.live))
            } else {
                format!("{} none", style.dim(g.dead))
            },
        ),
        ("synced", synced),
        (
            "queue",
            if queued == 0 {
                style.dim("empty")
            } else {
                style.warn(&format!("{queued} queued"))
            },
        ),
        ("commit#", style.dim(&ss.last_commit_seq.to_string())),
    ];
    for i in 0..4 {
        let (l0, l1) = &left[i];
        let (r0, r1) = &right[i];
        let l_cell = format!("  {l0}  {}", style.bold(l1));
        let r_cell = format!("{}{r1}", style.dim(&format!("{r0:<8}")));
        cli.io.out(&format!("{}{r_cell}", pad_end(&l_cell, 26)));
    }
    Ok(EXIT_OK)
}
