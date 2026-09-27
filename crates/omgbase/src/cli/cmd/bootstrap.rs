//! `init` and `repos` (§6).

use std::path::{Path, PathBuf};

use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::{Cli, resolve_path};
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};
use crate::cli::render::{columns, shorten_home};

use super::machine_out;

const EMBEDDER_CMD: &str = "omgbase-embedder";
const EMBEDDER_INSTALL: &str = "npm i -g @omgbase/embedder";

/// Nearest ancestor (inclusive) that is a git working tree.
fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
}

/// A `[y/N]` question on stderr, read from stdin; `false` without a TTY.
fn confirm_tty(cli: &Cli, question: &str) -> bool {
    if !cli.io.stdout_tty() || !cli.io.stdin_tty() {
        return false;
    }
    eprint!("{question} [y/N] ");
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    let a = line.trim().to_lowercase();
    a == "y" || a == "yes"
}

/// Keep the db out of git: offer the `.omgbase/` line to the closest
/// `.gitignore` at or above the workspace (bounded by the git root).
fn offer_gitignore(cli: &Cli, dir: &Path, yes: bool) -> Result<()> {
    let Some(git_root) = find_git_root(dir) else {
        cli.io.err(
            &cli.style
                .dim("  not inside a git repo — no .gitignore needed for .omgbase/"),
        );
        return Ok(());
    };
    let mut probe = dir.to_path_buf();
    let (target, exists) = loop {
        let gi = probe.join(".gitignore");
        if gi.exists() {
            break (gi, true);
        }
        if probe == git_root {
            break (git_root.join(".gitignore"), false);
        }
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => break (git_root.join(".gitignore"), false),
        }
    };
    let holder = target.parent().unwrap_or(&git_root);
    let rel = dir
        .join(".omgbase")
        .strip_prefix(holder)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".omgbase".to_owned());
    let line = format!("{rel}/");
    if exists {
        let text = std::fs::read_to_string(&target)?;
        if text.lines().any(|l| l.trim() == line || l.trim() == rel) {
            return Ok(());
        }
    }
    let write = || -> Result<()> {
        if exists {
            let text = std::fs::read_to_string(&target)?;
            let prefix = if text.ends_with('\n') { "" } else { "\n" };
            let mut f = std::fs::OpenOptions::new().append(true).open(&target)?;
            std::io::Write::write_all(&mut f, format!("{prefix}{line}\n").as_bytes())?;
        } else {
            std::fs::write(&target, format!("{line}\n"))?;
        }
        cli.io.err(&cli.style.dim(&format!(
            "  {} {line} in {}",
            if exists { "added" } else { "created" },
            shorten_home(&target.to_string_lossy())
        )));
        Ok(())
    };
    if yes {
        return write();
    }
    let verb = if exists { "append to" } else { "create" };
    if confirm_tty(
        cli,
        &format!(
            "{verb} {} to ignore {line}?",
            shorten_home(&target.to_string_lossy())
        ),
    ) {
        write()
    } else {
        cli.io.err(&cli.style.dim(&format!(
            "  skipped .gitignore; add {line} yourself to keep the db out of git"
        )));
        Ok(())
    }
}

fn command_exists(cmd: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(cmd).is_file()))
}

fn set_provider(cli: &mut Cli, provider: &str) -> Result<()> {
    let store = cli.store()?;
    let mut settings = omgbase_sync::workspace_settings(store)?;
    let mut emb = settings
        .get("embedding")
        .and_then(Json::as_object)
        .cloned()
        .unwrap_or_default();
    emb.insert("provider".to_owned(), Json::String(provider.to_owned()));
    settings.insert("embedding".to_owned(), Json::Object(emb));
    omgbase_sync::write_workspace_settings(store, &settings)?;
    cli.io.err(&cli.style.dim(&format!(
        "  embedding.provider = {provider} (workspace default)"
    )));
    Ok(())
}

/// The embedder offer; returns whether the "no provider" guidance prints.
fn offer_embedder(cli: &mut Cli, yes: bool, embedder: Option<&str>) -> Result<bool> {
    let current = omgbase_sync::workspace_settings(cli.store()?)?;
    if current
        .get("embedding")
        .and_then(|e| e.get("provider"))
        .and_then(Json::as_str)
        .is_some_and(|p| !p.is_empty())
    {
        return Ok(false);
    }
    if let Some(v) = embedder {
        set_provider(cli, v)?;
        return Ok(false);
    }
    if !command_exists(EMBEDDER_CMD) {
        return Ok(true);
    }
    let accept = yes
        || confirm_tty(
            cli,
            &format!("set {EMBEDDER_CMD} as the embedding provider (enables semantic search)?"),
        );
    if !accept {
        return Ok(true);
    }
    set_provider(cli, EMBEDDER_CMD)?;
    Ok(false)
}

pub fn init(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "init");
    }
    let a = parse_args(
        args,
        &[
            Opt::flag_short("yes", 'y'),
            Opt::value("embedder"),
            Opt::flag("no-embedder"),
        ],
    )?;
    let dir = match a.pos(0) {
        Some(d) => resolve_path(&cli.cwd, d),
        None => cli.cwd.clone(),
    };
    std::fs::create_dir_all(&dir)?;
    if dir.join(".omgbase").join("omgbase.db").exists() {
        return Err(CliError::engine(
            "path_taken",
            format!("workspace already initialized at {}", dir.display()),
        ));
    }
    cli.open_at(dir.clone())?;
    let yes = a.flag("yes");
    offer_gitignore(cli, &dir, yes)?;
    let needs_hint = if a.flag("no-embedder") {
        false
    } else {
        offer_embedder(cli, yes, a.value("embedder"))?
    };
    let shown = dir.to_string_lossy().into_owned();
    if cli.machine() {
        cli.io.out(&js_json(&json!({ "workspace": shown })));
        return Ok(EXIT_OK);
    }
    let style = cli.style;
    let g = style.glyphs();
    cli.io.out(&style.wordmark("initialized"));
    cli.io.out(&style.rule());
    cli.io.out(&format!(
        "  {} workspace  {}",
        style.ok(g.ok),
        style.path(&shown)
    ));
    cli.io.err(&style.dim(&format!(
        "  next: {} to point a repo at a directory of files",
        style.accent("omg source add .")
    )));
    if needs_hint {
        let prog = cli.prog.clone();
        cli.io.err(&style.dim("  optional: semantic search is off — no embedding provider set. Full-text search, queries, and edits all work without one."));
        cli.io.err(&style.dim(&format!(
            "  to enable it, install the built-in embedder (@omgbase/embedder: a local transformers.js model that turns blocks into vectors so {} and {} can rank by meaning), then point the workspace at it:",
            style.accent(&format!("{prog} find")),
            style.accent("semantic(\"…\")")
        )));
        cli.io.err(&style.dim(&format!(
            "    {EMBEDDER_INSTALL} && {prog} config set embedding.provider {EMBEDDER_CMD} --repo \"\""
        )));
    }
    Ok(EXIT_OK)
}

pub fn repos(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "repos");
    }
    parse_args(args, &[])?;
    let rows = cli.repos()?;
    let mut counts: Vec<(i64, i64)> = Vec::with_capacity(rows.len());
    {
        let store = cli.store()?;
        for r in &rows {
            let st = omgbase_sync::repos_status(store, &r.repo_id, None)?;
            counts.push((st.docs, st.blocks));
        }
    }
    // §9 Fixed: `--json` is the `repos` tool's shape.
    let items: Vec<Json> = rows
        .iter()
        .map(|r| json!({ "slug": r.slug, "hasSource": r.root_path.is_some() }))
        .collect();
    let doc = json!({ "repos": items });
    let ids: Vec<String> = rows.iter().map(|r| r.slug.clone()).collect();
    if let Some(code) = machine_out(cli, &doc, Some(&items), Some(&ids)) {
        return code;
    }
    let style = cli.style;
    if rows.is_empty() {
        // §9 Fixed: empty-result notes go to stderr.
        cli.io.err(&style.dim("  no repos attached"));
        return Ok(EXIT_OK);
    }
    let g = style.glyphs();
    let table: Vec<Vec<String>> = rows
        .iter()
        .zip(&counts)
        .map(|(r, (docs, blocks))| {
            vec![
                format!("  {} {}", g.diamond, style.accent(&r.slug)),
                style.path(
                    &r.root_path
                        .as_deref()
                        .map_or_else(|| "(no source)".to_owned(), shorten_home),
                ),
                style.dim(&format!("{docs} docs")),
                style.dim(&format!("{blocks} blocks")),
            ]
        })
        .collect();
    for line in columns(&table, &[]) {
        cli.io.out(&line);
    }
    Ok(EXIT_OK)
}
