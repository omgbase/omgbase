//! `sync` (§6): the one-shot freshness sweep, rendered. `--watch` (the
//! long-running local watcher) and `--server` (the remote coordinator) are
//! later waves of this binary.

use std::path::Path;

use omgbase_sync::{RealFileSystem, freshness_sweep};
use serde_json::json;

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};

pub fn sync(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "sync");
    }
    let a = parse_args(
        args,
        &[Opt::flag("watch"), Opt::flag("out"), Opt::value("root")],
    )?;
    if a.flag("watch") {
        return Err(CliError::engine(
            "not_implemented",
            "sync --watch is not yet implemented in this binary; `omgbase mcp` runs the in-process watcher",
        ));
    }
    cli.workspace()?;
    let repo = cli.repo()?;
    let style = cli.style;
    let Some(root) = repo.root_path.as_deref() else {
        if cli.machine() {
            cli.io.out(&js_json(
                &json!({ "scanned": 0, "ingested": [], "deleted": [], "conflicted": [], "changed": false }),
            ));
        } else {
            // §9 Fixed: the note goes to stderr.
            cli.io.err(&style.dim(&format!(
                "  {} has no filesystem source — nothing to sync",
                repo.slug
            )));
        }
        return Ok(EXIT_OK);
    };
    let now = cli.now();
    let result = freshness_sweep(
        cli.store_mut()?,
        &repo.repo_id,
        &RealFileSystem,
        Path::new(root),
        &now,
        None,
        &omgbase_store::Config::default(),
    )?;
    let cp = &result.checkpoint;
    if cli.machine() {
        // The `SweepResult` as the reference spells it (camelCase).
        cli.io.out(&js_json(&json!({
            "checkpointId": cp.checkpoint_id, "ingested": cp.ingested, "suppressed": cp.suppressed,
            "deleted": cp.deleted, "conflicted": cp.conflicted, "scanned": result.scanned,
            "candidates": result.candidates, "changed": result.changed,
        })));
        return Ok(EXIT_OK);
    }
    let g = style.glyphs();
    cli.io.out(&style.wordmark("sync"));
    cli.io.out(&style.rule());
    cli.io.out(&format!(
        "  {}   {} files",
        style.dim("scanned"),
        result.scanned
    ));
    if !cp.ingested.is_empty() {
        cli.io.out(&format!(
            "  {} ingested  {}",
            style.ok(g.ok),
            cp.ingested.len()
        ));
        for p in &cp.ingested {
            cli.io.out(&format!("      {}", style.accent(p)));
        }
    }
    if !cp.deleted.is_empty() {
        cli.io.out(&format!(
            "  {} deleted   {}",
            style.err(g.err),
            cp.deleted.len()
        ));
        for p in &cp.deleted {
            cli.io.out(&format!("      {}", style.dim(p)));
        }
    }
    if !cp.conflicted.is_empty() {
        cli.io.out(&format!(
            "  {} conflicts {}",
            style.warn(g.warn),
            cp.conflicted.len()
        ));
        for p in &cp.conflicted {
            cli.io.out(&format!("      {}", style.warn(p)));
        }
    }
    if !result.changed {
        cli.io
            .out(&format!("  {}", style.dim("already up to date")));
    }
    Ok(EXIT_OK)
}
