//! The admin verbs (`spec/cli` §6): `rebuild-index`, `gc`, `doctor`,
//! `config`, `embed`. No MCP tool maps to them — each is a library operation
//! over the store (`spec/store` §7), the settings of `spec/sync` §3 or the
//! embedding queue of `spec/search` §2 — so §3.2 gives their `--json` shapes
//! and the CLI names what it did.

use omgbase_search::{EmbeddingProvider, EmbeddingSettings, create_external_provider};
use omgbase_store::{LIVE_LEAF_SQL, RebuildTarget};
use omgbase_sync::settings::{
    Settings, repo_own_settings, resolve_settings, workspace_settings, write_repo_settings,
    write_workspace_settings,
};
use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_ERROR, EXIT_OK, Result, js_json};

use super::machine_out;

// ---- rebuild-index --------------------------------------------------------------------

/// `rebuild-index [--sections|--edges|--fts|--block-changes|--all]` —
/// stderr `  ok rebuilt <target>`; every machine mode `{"rebuilt":"<target>"}`.
pub fn rebuild_index(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "rebuild-index");
    }
    let a = parse_args(
        args,
        &[
            Opt::flag("sections"),
            Opt::flag("edges"),
            Opt::flag("fts"),
            Opt::flag("block-changes"),
            Opt::flag("all"),
        ],
    )?;
    let (target, name) = if a.flag("sections") {
        (RebuildTarget::Sections, "sections")
    } else if a.flag("edges") {
        (RebuildTarget::Edges, "edges")
    } else if a.flag("fts") {
        (RebuildTarget::Fts, "fts")
    } else if a.flag("block-changes") {
        (RebuildTarget::BlockChanges, "block_changes")
    } else {
        (RebuildTarget::All, "all")
    };
    cli.workspace()?;
    cli.store()?.rebuild_index(target)?;
    let doc = json!({ "rebuilt": name });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(&format!(
        "  {} rebuilt {name}",
        cli.style.ok(cli.style.glyphs().ok)
    )));
    Ok(EXIT_OK)
}

// ---- gc -------------------------------------------------------------------------------

/// JavaScript's `Boolean(x)` over a settings value.
fn truthy(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Json::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `gc [--dry-run]` — mark-and-sweep, refused unless `gc.enabled` (§9
/// Pinned: under the code `target_missing`); the command's own `--dry-run`
/// or the global one previews without deleting.
pub fn gc(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "gc");
    }
    let a = parse_args(args, &[Opt::flag("dry-run")])?;
    let dry = a.flag("dry-run") || cli.flags.dry_run;
    cli.workspace()?;
    let repo = cli.repo()?;
    let store = cli.store()?;
    let settings = resolve_settings(store, Some(&repo.repo_id))?;
    let enabled = truthy(settings.get("gc").and_then(|g| g.get("enabled")));
    if !enabled && !dry {
        return Err(CliError::engine(
            "target_missing",
            "gc is disabled; set gc.enabled=true (or use --dry-run)",
        ));
    }
    let result = if dry {
        store.gc_dry_run()?
    } else {
        store.gc(true)?
    };
    let doc =
        json!({ "blobsSwept": result.blobs_swept, "treeNodesSwept": result.tree_nodes_swept });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(&format!(
        "  swept {} blobs, {} tree nodes",
        result.blobs_swept, result.tree_nodes_swept
    )));
    Ok(EXIT_OK)
}

// ---- doctor ---------------------------------------------------------------------------

struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

/// `doctor [--json]` — the four checks on the selected repo; exit 1 when any fails.
pub fn doctor(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "doctor");
    }
    parse_args(args, &[])?;
    cli.workspace()?;
    let repo = cli.repo()?;
    let store = cli.store()?;
    let conn = store.conn();
    let mut checks: Vec<Check> = Vec::with_capacity(4);

    let status = omgbase_sync::repos_status(store, &repo.repo_id, None)?;
    checks.push(Check {
        name: "convergence",
        ok: status.unconverged == 0,
        detail: format!("{} unconverged", status.unconverged),
    });

    // The index holds exactly the live leaf blocks (`spec/search` §1.1),
    // counted from FTS5's shadow table — a `count(*)` on the
    // external-content table answers from `blocks` (§9 Fixed).
    let fts: i64 = conn.query_row("SELECT count(*) FROM blocks_fts_docsize", [], |r| r.get(0))?;
    let leaves: i64 = conn.query_row(
        &format!("SELECT count(*) FROM blocks b WHERE {LIVE_LEAF_SQL}"),
        [],
        |r| r.get(0),
    )?;
    checks.push(Check {
        name: "fts rows == live leaf blocks",
        ok: fts == leaves,
        detail: format!("fts={fts} leaves={leaves}"),
    });

    let dangling: i64 = conn.query_row(
        "SELECT count(*) c FROM docs d WHERE d.deleted_commit IS NULL AND d.current_rev IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.rev_id = d.current_rev)",
        [],
        |r| r.get(0),
    )?;
    checks.push(Check {
        name: "no dangling current_rev",
        ok: dangling == 0,
        detail: format!("{dangling} dangling"),
    });

    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    checks.push(Check {
        name: "sqlite integrity",
        ok: integrity == "ok",
        detail: integrity,
    });

    let all_ok = checks.iter().all(|c| c.ok);
    let exit = if all_ok { EXIT_OK } else { EXIT_ERROR };
    if cli.machine() {
        let doc = json!({
            "ok": all_ok,
            "checks": checks
                .iter()
                .map(|c| json!({ "name": c.name, "ok": c.ok, "detail": c.detail }))
                .collect::<Vec<_>>(),
        });
        cli.io.out(&js_json(&doc));
        return Ok(exit);
    }
    let style = cli.style;
    let g = style.glyphs();
    for c in &checks {
        let mark = if c.ok {
            style.ok(g.ok)
        } else {
            style.err(g.err)
        };
        let detail = if c.ok {
            String::new()
        } else {
            style.dim(&format!("  ({})", c.detail))
        };
        cli.io.out(&format!("  {mark} {}{detail}", c.name));
    }
    Ok(exit)
}

// ---- config ---------------------------------------------------------------------------

/// Which settings layer a `config` command targets (§6 `config`): the
/// selected repo's, or the workspace's for `--repo ""` and when no repo is
/// selectable without an explicit `--repo` (§9 Fixed).
enum Scope {
    Workspace,
    Repo { repo_id: String, slug: String },
}

fn resolve_scope(cli: &mut Cli) -> Result<Scope> {
    if cli.flags.repo.as_deref() == Some("") {
        return Ok(Scope::Workspace);
    }
    match cli.repo() {
        Ok(r) => Ok(Scope::Repo {
            repo_id: r.repo_id,
            slug: r.slug,
        }),
        Err(CliError::Engine { code, .. })
            if code == "repo_not_found" && cli.flags.repo.as_deref().is_none_or(str::is_empty) =>
        {
            Ok(Scope::Workspace)
        }
        Err(e) => Err(e),
    }
}

/// A dotted path into a settings object (`getPath`).
fn get_path<'a>(obj: &'a Settings, path: &str) -> Option<&'a Json> {
    let mut parts = path.split('.');
    let mut cur: &Json = obj.get(parts.next()?)?;
    for k in parts {
        cur = match cur {
            Json::Object(m) => m.get(k)?,
            Json::Array(a) => a.get(k.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// Set a dotted path, creating (or replacing a non-object with) an object
/// along the way (`setPath`).
fn set_path(obj: &mut Settings, path: &str, value: Json) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = obj;
    for k in &parts[..parts.len() - 1] {
        let slot = cur
            .entry((*k).to_owned())
            .or_insert_with(|| Json::Object(Map::new()));
        if !slot.is_object() {
            *slot = Json::Object(Map::new());
        }
        cur = slot.as_object_mut().expect("just made an object");
    }
    cur.insert(parts[parts.len() - 1].to_owned(), value);
}

/// `true`, `false`, `null` and numbers (`/^-?\d+(\.\d+)?$/`) are typed; else a string.
fn coerce(raw: &str) -> Json {
    match raw {
        "true" => return Json::Bool(true),
        "false" => return Json::Bool(false),
        "null" => return Json::Null,
        _ => {}
    }
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    let numeric = match digits.split_once('.') {
        Some((i, f)) => {
            !i.is_empty()
                && !f.is_empty()
                && i.bytes().all(|b| b.is_ascii_digit())
                && f.bytes().all(|b| b.is_ascii_digit())
        }
        None => !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()),
    };
    if numeric {
        if let Ok(i) = raw.parse::<i64>() {
            return json!(i);
        }
        if let Ok(f) = raw.parse::<f64>() {
            return json!(f);
        }
    }
    Json::String(raw.to_owned())
}

/// `config [list]` · `config get <key>` · `config set <key> <value>`.
pub fn config(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let sub = args.first().map(String::as_str);
    if matches!(sub, Some("--help" | "help")) || args.iter().any(|a| a == "--help") {
        return render_help_for(cli, "config");
    }
    cli.workspace()?;
    let scope = resolve_scope(cli)?;
    let label = match &scope {
        Scope::Workspace => "workspace",
        Scope::Repo { slug, .. } => slug.as_str(),
    };
    let store = cli.store()?;
    match sub {
        None | Some("list") => {
            let (settings, own): (Settings, Option<Settings>) = match &scope {
                Scope::Workspace => (workspace_settings(store)?, None),
                Scope::Repo { repo_id, .. } => (
                    resolve_settings(store, Some(repo_id))?,
                    Some(repo_own_settings(store, repo_id)?),
                ),
            };
            let doc = Json::Object(settings.clone());
            if let Some(code) = machine_out(cli, &doc, None, None) {
                return code;
            }
            let style = cli.style;
            match own {
                None => {
                    cli.io.err(&style.dim("  workspace defaults"));
                    for (k, v) in &settings {
                        cli.io.out(&format!(
                            "  {} {} {}",
                            style.accent(k),
                            style.dim("="),
                            js_json(v)
                        ));
                    }
                }
                Some(own) => {
                    let diamond = style.glyphs().diamond;
                    cli.io.err(&style.dim(&format!(
                        "  {label} (effective; {diamond} = overrides workspace default)"
                    )));
                    for (k, v) in &settings {
                        let mark = if own.contains_key(k) {
                            style.accent(diamond)
                        } else {
                            " ".to_owned()
                        };
                        cli.io.out(&format!(
                            "  {mark} {} {} {}",
                            style.accent(k),
                            style.dim("="),
                            js_json(v)
                        ));
                    }
                }
            }
            Ok(EXIT_OK)
        }
        Some("get") => {
            let Some(key) = args.get(1) else {
                return Err(CliError::usage("config get <key>"));
            };
            let source = match &scope {
                Scope::Workspace => workspace_settings(store)?,
                Scope::Repo { repo_id, .. } => resolve_settings(store, Some(repo_id))?,
            };
            let line = match get_path(&source, key) {
                None => String::new(),
                Some(Json::String(s)) => s.clone(),
                Some(other) => js_json(other),
            };
            cli.io.out(&line);
            Ok(EXIT_OK)
        }
        Some("set") => {
            let (Some(key), Some(raw)) = (args.get(1), args.get(2)) else {
                return Err(CliError::usage("config set <key> <value>"));
            };
            match &scope {
                Scope::Workspace => {
                    let mut s = workspace_settings(store)?;
                    set_path(&mut s, key, coerce(raw));
                    write_workspace_settings(store, &s)?;
                }
                Scope::Repo { repo_id, .. } => {
                    let mut s = repo_own_settings(store, repo_id)?;
                    set_path(&mut s, key, coerce(raw));
                    write_repo_settings(store, repo_id, &s)?;
                }
            }
            cli.io
                .err(&cli.style.dim(&format!("  set {key} ({label})")));
            Ok(EXIT_OK)
        }
        Some(other) => Err(CliError::usage_hint(
            format!("unknown config subcommand '{other}' (get|set|list)"),
            format!("run '{} config --help'", cli.prog),
        )),
    }
}

// ---- embed ----------------------------------------------------------------------------

/// The repo's effective `embedding.*` settings when a provider is named.
fn embedding_settings(cli: &mut Cli, repo_id: &str) -> Result<Option<EmbeddingSettings>> {
    let settings = resolve_settings(cli.store()?, Some(repo_id))?;
    let Some(emb) = settings.get("embedding").and_then(Json::as_object) else {
        return Ok(None);
    };
    let s = |k: &str| emb.get(k).and_then(Json::as_str).map(str::to_owned);
    let n = |k: &str| emb.get(k).and_then(Json::as_u64);
    let cfg = EmbeddingSettings {
        provider: s("provider"),
        model: s("model"),
        dim: n("dim").map(|d| usize::try_from(d).unwrap_or(0)),
        max_input_tokens: n("maxInputTokens")
            .or_else(|| n("max_input_tokens"))
            .map(|d| u32::try_from(d).unwrap_or(u32::MAX)),
    };
    Ok(cfg
        .provider
        .as_deref()
        .is_some_and(|p| !p.trim().is_empty())
        .then_some(cfg))
}

/// A configured embedder that cannot start is a loud, typed fault — never
/// mistaken for an unconfigured one (`data { provider, reason }`; the reason
/// is the OS's spawn error, unpinned).
fn embedder_failed(provider: &str, reason: &str) -> CliError {
    CliError::engine_data(
        "embedder_failed",
        format!(
            "embedder '{provider}' is configured but failed to start: {reason}. Fix: put it on PATH or use an absolute path / http(s) URL for embedding.provider — or unset embedding.provider to run without semantic search."
        ),
        json!({ "provider": provider, "reason": reason }),
    )
}

/// `embed [status]` · `embed drain [--verbose] [--prune]` — the embedding queue.
pub fn embed(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let sub = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(String::as_str);
    if args.iter().any(|a| a == "--help" || a == "-h") || sub == Some("help") {
        return render_help_for(cli, "embed");
    }
    let prune = args.iter().any(|a| a == "--prune");
    cli.workspace()?;
    let repo = cli.repo()?;
    let Some(cfg) = embedding_settings(cli, &repo.repo_id)? else {
        return no_provider(cli);
    };
    let provider_name = cfg.provider.clone().unwrap_or_default();
    let provider: Box<dyn EmbeddingProvider> = match create_external_provider(&cfg) {
        Ok(Some(p)) => p,
        Ok(None) => return no_provider(cli),
        Err(e) => return Err(embedder_failed(&provider_name, &e.to_string())),
    };
    let model = provider.model().to_owned();
    let style = cli.style;
    let io = cli.io;
    let machine = cli.machine();
    let store = cli.store()?;

    if sub == Some("drain") {
        let tasks = store.build_embed_tasks(&repo.repo_id)?;
        let pending = store.stale_blocks(&tasks, &model)?.len();
        // Egress notice (`spec/search` §4): a remote provider receives block text.
        let remote = provider_name.to_ascii_lowercase().starts_with("http://")
            || provider_name.to_ascii_lowercase().starts_with("https://");
        if remote {
            io.err(&style.warn(&format!(
                "  embedding {pending} block(s) via {provider_name} — block text is sent to this remote endpoint"
            )));
        } else {
            io.err(&style.dim(&format!(
                "  embedding {pending} block(s) via {provider_name} (local process)"
            )));
        }
        let stats = store.drain(&repo.repo_id, provider.as_ref())?;
        let pruned = if prune {
            let p = store.prune_foreign_vectors(&model)?;
            if !machine && (p.blocks > 0 || p.docs > 0) {
                io.err(&style.dim(&format!(
                    "  pruned {} block + {} doc vector(s) from other models",
                    p.blocks, p.docs
                )));
            }
            Some(p)
        } else {
            None
        };
        let embedded = stats.blocks.embedded + stats.docs.embedded + stats.docs.pooled;
        let cached = stats.blocks.cached + stats.docs.cached;
        let mut m = Map::new();
        m.insert("provider".to_owned(), json!(provider_name));
        m.insert("embedded".to_owned(), json!(embedded));
        m.insert("cached".to_owned(), json!(cached));
        if let Some(p) = pruned {
            m.insert(
                "pruned".to_owned(),
                json!({ "blocks": p.blocks, "docs": p.docs }),
            );
        }
        let doc = Json::Object(m);
        if let Some(code) = machine_out(cli, &doc, None, None) {
            return code;
        }
        cli.io.err(&format!(
            "  {} embedded {embedded}, cached {cached}",
            style.ok(style.glyphs().ok)
        ));
        return Ok(EXIT_OK);
    }

    // status
    let tasks = store.build_embed_tasks(&repo.repo_id)?;
    let queued = store.stale_blocks(&tasks, &model)?.len();
    let doc_tasks = store.build_doc_embed_tasks(&repo.repo_id)?;
    let docs_queued = store.stale_docs(&doc_tasks, &model)?.len();
    let foreign = store.foreign_vector_count(&model)?;
    let dim = provider.dim();
    let doc = json!({
        "provider": provider_name,
        "model": model,
        "dim": dim,
        "embeddable": tasks.len(),
        "queued": queued,
        "docs": doc_tasks.len(),
        "docsQueued": docs_queued,
        "foreignBlocks": foreign.blocks,
        "foreignDocs": foreign.docs,
    });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.out(&format!(
        "  provider  {} {}",
        style.accent(&provider_name),
        style.dim(&format!("({model}, {dim}d)"))
    ));
    cli.io.out(&format!(
        "  embeddable {}   {} {queued}",
        tasks.len(),
        style.dim("queued")
    ));
    cli.io.out(&format!(
        "  docs {}   {} {docs_queued}",
        doc_tasks.len(),
        style.dim("queued")
    ));
    if queued > 0 || docs_queued > 0 {
        cli.io.out(&style.dim(&format!(
            "  run `omg embed drain` to embed the {queued} queued block(s) + {docs_queued} doc(s)"
        )));
    }
    if foreign.blocks > 0 || foreign.docs > 0 {
        cli.io.out(&style.dim(&format!(
            "  {} block + {} doc vector(s) from other models — `omg embed drain --prune` to reclaim",
            foreign.blocks, foreign.docs
        )));
    }
    Ok(EXIT_OK)
}

/// No `embedding.provider` in the effective settings: an honest note, exit 0.
fn no_provider(cli: &mut Cli) -> Result<i32> {
    let doc = json!({ "provider": null, "queued": 0 });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(
        "  no embedding provider configured — set one with `omg config set embedding.provider <command|url>` (e.g. omgbase-embedder)",
    ));
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coercion_and_paths() {
        assert_eq!(coerce("true"), json!(true));
        assert_eq!(coerce("null"), Json::Null);
        assert_eq!(coerce("5000"), json!(5000));
        assert_eq!(coerce("-0.5"), json!(-0.5));
        assert_eq!(coerce("1."), json!("1."));
        assert_eq!(coerce("gte-base"), json!("gte-base"));
        let mut s = Settings::new();
        set_path(&mut s, "embedding.model", json!("x"));
        set_path(&mut s, "embedding.dim", json!(3));
        set_path(&mut s, "flag", json!(false));
        assert_eq!(
            Json::Object(s.clone()),
            json!({ "embedding": { "model": "x", "dim": 3 }, "flag": false })
        );
        assert_eq!(get_path(&s, "embedding.model"), Some(&json!("x")));
        assert_eq!(get_path(&s, "nope.deeper"), None);
        assert_eq!(get_path(&s, "flag.x"), None);
        set_path(&mut s, "flag.on", json!(1));
        assert_eq!(get_path(&s, "flag.on"), Some(&json!(1)));
        assert!(truthy(Some(&json!(true))) && !truthy(Some(&json!(0))) && !truthy(None));
    }
}
