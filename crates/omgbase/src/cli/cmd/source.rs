//! `source` (§6): the source registry of `spec/sync` §2 — `add` creates the
//! repo, registers and attaches the filesystem source and runs the initial
//! sweep; `list`, `attach`, `detach`, `rm`.

use std::path::Path;

use omgbase_sync::registry::{FS_ADAPTER, FS_ADAPTER_COMMAND, NewSource};
use omgbase_sync::{RealFileSystem, freshness_sweep, rebuild_file_stats};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::{Cli, resolve_path};
use crate::cli::help::render_help_for;
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};
use crate::cli::render::{columns, shorten_home};

use super::machine_out;

pub fn source(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let Some(sub) = args.first().map(String::as_str) else {
        return render_help_for(cli, "source");
    };
    if sub == "--help" || sub == "help" {
        return render_help_for(cli, "source");
    }
    let rest = &args[1..];
    match sub {
        "add" => add(cli, rest),
        "list" => list(cli, rest),
        "attach" => attach_detach(cli, rest, true),
        "detach" => attach_detach(cli, rest, false),
        "rm" => rm(cli, rest),
        other => Err(CliError::usage(format!(
            "unknown source subcommand '{other}'"
        ))),
    }
}

/// The `[y/N]` consent prompt on a TTY.
fn confirm(slug: &str) -> bool {
    eprint!("  add source for {slug}  [y/N] ");
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    let a = line.trim().to_lowercase();
    a == "y" || a == "yes"
}

fn add(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[Opt::value("name"), Opt::flag_short("yes", 'y')])?;
    let Some(dir) = a.pos(0) else {
        return Err(CliError::usage("source add requires a <dir>"));
    };
    let abs = resolve_path(&cli.cwd, dir);
    if !abs.is_dir() {
        return Err(CliError::engine(
            "target_missing",
            format!("no such directory: {}", abs.display()),
        ));
    }
    let abs_str = abs.to_string_lossy().into_owned();
    // `--repo` is the global flag: for `source add` it names the repo being
    // created, defaulting to the directory's name.
    let slug = match cli.flags.repo.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => s.to_owned(),
        None => abs
            .file_name()
            .map(|b| b.to_string_lossy().into_owned())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "vault".to_owned()),
    };
    let source_name = a
        .value("name")
        .map_or_else(|| format!("{slug}-fs"), str::to_owned);
    cli.workspace()?;
    if omgbase_sync::source_by_name(cli.store()?, &source_name)?.is_some() {
        return Err(CliError::engine(
            "path_taken",
            format!("a source named '{source_name}' already exists"),
        ));
    }
    if !a.flag("yes") {
        let tty = cli.io.stdout_tty() && cli.io.stdin_tty();
        if !tty {
            // §9 Fixed: refusing without -y on a non-TTY is a usage error.
            return Err(CliError::usage_hint(
                format!(
                    "refusing without -y (would ingest files under {})",
                    shorten_home(&abs_str)
                ),
                "there is no TTY to confirm on; pass -y to consent to the ingest",
            ));
        }
        if !confirm(&slug) {
            cli.io.err(&cli.style.dim("  cancelled"));
            return Ok(EXIT_OK);
        }
    }
    let now = cli.now();
    let (repo_id, ingested) = {
        let store = cli.store_mut()?;
        let repo_id = omgbase_sync::ensure_repo(store, &slug, None)?;
        omgbase_sync::ensure_adapter(store, FS_ADAPTER, FS_ADAPTER_COMMAND, &[])?;
        let mut config = serde_json::Map::new();
        config.insert("root".to_owned(), json!(abs_str));
        let source_id = omgbase_sync::create_source(
            store,
            &NewSource {
                name: &source_name,
                adapter: FS_ADAPTER,
                config: Some(&config),
                env: None,
            },
        )?;
        omgbase_sync::attach(store, &repo_id, &source_id)?;
        let swept = freshness_sweep(
            store,
            &repo_id,
            &RealFileSystem,
            Path::new(&abs_str),
            &now,
            None,
            &omgbase_store::Config::default(),
        )?;
        rebuild_file_stats(store, &repo_id, &RealFileSystem, Path::new(&abs_str))?;
        (repo_id, swept.checkpoint.ingested.len())
    };
    if cli.machine() {
        cli.io.out(&js_json(&json!({
            "repo": slug, "repoId": repo_id, "source": source_name, "root": abs_str, "ingested": ingested,
        })));
        return Ok(EXIT_OK);
    }
    let style = cli.style;
    cli.io.out(&format!(
        "  {} {} ← {}  {}",
        style.glyphs().diamond,
        style.accent(&slug),
        style.path(&shorten_home(&abs_str)),
        style.dim(&format!("{ingested} files"))
    ));
    Ok(EXIT_OK)
}

fn list(cli: &mut Cli, args: &[String]) -> Result<i32> {
    parse_args(args, &[])?;
    cli.workspace()?;
    let repos = cli.repos()?;
    let store = cli.store()?;
    let sources = omgbase_sync::list_sources(store)?;
    let mut items: Vec<Json> = Vec::with_capacity(sources.len());
    let mut rows: Vec<(String, String, String, Vec<String>)> = Vec::new();
    for s in &sources {
        let mut attached: Vec<String> = Vec::new();
        for r in &repos {
            if omgbase_sync::sources_for_repo(store, &r.repo_id)?
                .iter()
                .any(|x| x.source_id == s.source_id)
            {
                attached.push(r.slug.clone());
            }
        }
        items.push(
            json!({ "name": s.name, "adapter": s.adapter, "config": s.config, "repos": attached }),
        );
        let root = s
            .config
            .get("root")
            .map(|v| match v {
                Json::String(x) => x.clone(),
                other => js_json(other),
            })
            .unwrap_or_default();
        rows.push((s.name.clone(), s.adapter.clone(), root, attached));
    }
    let doc = Json::Array(items.clone());
    let ids: Vec<String> = sources.iter().map(|s| s.name.clone()).collect();
    if let Some(code) = machine_out(cli, &doc, Some(&items), Some(&ids)) {
        return code;
    }
    let style = cli.style;
    if rows.is_empty() {
        // §9 Fixed: empty-result notes go to stderr.
        cli.io.err(&style.dim("  no sources registered"));
        return Ok(EXIT_OK);
    }
    let table: Vec<Vec<String>> = rows
        .iter()
        .map(|(name, adapter, root, repos)| {
            vec![
                format!("  {}", style.accent(name)),
                style.dim(adapter),
                style.path(root),
                style.dim(&if repos.is_empty() {
                    "(unattached)".to_owned()
                } else {
                    format!("→ {}", repos.join(", "))
                }),
            ]
        })
        .collect();
    for line in columns(&table, &[]) {
        cli.io.out(&line);
    }
    Ok(EXIT_OK)
}

fn attach_detach(cli: &mut Cli, args: &[String], attach: bool) -> Result<i32> {
    let verb = if attach { "attach" } else { "detach" };
    let a = parse_args(args, &[])?;
    let Some(name) = a.pos(0) else {
        return Err(CliError::usage(format!("source {verb} requires a <name>")));
    };
    cli.workspace()?;
    let src = omgbase_sync::source_by_name(cli.store()?, name)?
        .ok_or_else(|| CliError::engine("target_missing", format!("no source named '{name}'")))?;
    let repo = cli.repo()?;
    let store = cli.store()?;
    if attach {
        omgbase_sync::attach(store, &repo.repo_id, &src.source_id)?;
    } else {
        omgbase_sync::detach(store, &repo.repo_id, &src.source_id)?;
    }
    if cli.machine() {
        cli.io.out(&js_json(
            &json!({ "source": name, "repo": repo.slug, "attached": attach }),
        ));
        return Ok(EXIT_OK);
    }
    let style = cli.style;
    cli.io.out(&format!(
        "  {} {} {} {} {}",
        style.glyphs().ok,
        if attach { "attached" } else { "detached" },
        style.accent(name),
        if attach { "→" } else { "⇸" },
        style.accent(&repo.slug)
    ));
    Ok(EXIT_OK)
}

fn rm(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    let Some(name) = a.pos(0) else {
        return Err(CliError::usage("source rm requires a <name>"));
    };
    cli.workspace()?;
    let store = cli.store()?;
    let src = omgbase_sync::source_by_name(store, name)?
        .ok_or_else(|| CliError::engine("target_missing", format!("no source named '{name}'")))?;
    omgbase_sync::delete_source(store, &src.source_id)?;
    if cli.machine() {
        cli.io
            .out(&js_json(&json!({ "source": name, "deleted": true })));
        return Ok(EXIT_OK);
    }
    let style = cli.style;
    cli.io.out(&format!(
        "  {} deleted source {}",
        style.glyphs().ok,
        style.accent(name)
    ));
    Ok(EXIT_OK)
}
