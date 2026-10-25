//! The admin verbs (`spec/cli` §6): `rebuild-index`, `gc`, `doctor`,
//! `config`, `embed`. No MCP tool maps to them — each is a library operation
//! over the store (`spec/store` §7), the settings of `spec/sync` §3 or the
//! embedding queue of `spec/search` §2 — so §3.2 gives their `--json` shapes
//! and the CLI names what it did.

use omgbase_search::{EmbeddingProvider, create_external_provider};
use omgbase_store::{LIVE_LEAF_SQL, RebuildTarget, SizeReport, format_share, human_bytes};
use omgbase_sync::settings::{
    Settings, repo_own_settings, resolve_settings, workspace_settings, write_repo_settings,
    write_workspace_settings,
};
use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_ERROR, EXIT_OK, Result, js_json};
use crate::cli::render::{Align, Style, columns, pad_start};

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

/// `gc [--dry-run] [--vacuum]` — mark-and-sweep, refused unless `gc.enabled`
/// (§9 Pinned: under the code `target_missing`); the command's own `--dry-run`
/// or the global one previews without deleting. `--vacuum` (cli 4.3) runs
/// `VACUUM` after the sweep — a dry run measures the free pages instead —
/// and the result gains `vacuum: { reclaimable, applied }`. Since store 14.2
/// (cli 4.5) the sweep also removes the `same` disposition rows a 14.1 store
/// wrote, reported as the third count (`sameDispositionsSwept`).
pub fn gc(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "gc");
    }
    let a = parse_args(args, &[Opt::flag("dry-run"), Opt::flag("vacuum")])?;
    let dry = a.flag("dry-run") || cli.flags.dry_run;
    let want_vacuum = a.flag("vacuum");
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
    // After the sweep: its freed pages are what a VACUUM returns.
    let vacuum = if want_vacuum {
        Some(if dry {
            (store.reclaimable_bytes()?, false)
        } else {
            (store.vacuum()?.reclaimable, true)
        })
    } else {
        None
    };
    let mut doc = Map::new();
    doc.insert("blobsSwept".to_owned(), json!(result.blobs_swept));
    doc.insert("treeNodesSwept".to_owned(), json!(result.tree_nodes_swept));
    doc.insert(
        "sameDispositionsSwept".to_owned(),
        json!(result.same_dispositions_swept),
    );
    if let Some((reclaimable, applied)) = vacuum {
        doc.insert(
            "vacuum".to_owned(),
            json!({ "reclaimable": reclaimable, "applied": applied }),
        );
    }
    let doc = Json::Object(doc);
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(&format!(
        "  swept {} blobs, {} tree nodes, {} same dispositions",
        result.blobs_swept, result.tree_nodes_swept, result.same_dispositions_swept
    )));
    match vacuum {
        Some((reclaimable, true)) => cli.io.err(&cli.style.dim(&format!(
            "  vacuumed, reclaimed {}",
            human_bytes(reclaimable)
        ))),
        Some((reclaimable, false)) => cli.io.err(
            &cli.style
                .dim(&format!("  would vacuum {}", human_bytes(reclaimable))),
        ),
        None => {}
    }
    Ok(EXIT_OK)
}

// ---- doctor ---------------------------------------------------------------------------

struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

/// `doctor [--json]` — the four checks on the selected repo; exit 1 when any
/// fails. `doctor --size` (cli 4.3) is the size report instead (exit 0).
pub fn doctor(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "doctor");
    }
    let a = parse_args(args, &[Opt::flag("size")])?;
    cli.workspace()?;
    if a.flag("size") {
        // The retention advice (15.0) is evaluated at the pinned clock.
        let now = cli.now();
        let report = cli.store()?.size_report_at(&now)?;
        return doctor_size(cli, &report);
    }
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

    // Store 17.0 (D1): every live document has a head token, and while
    // legacy capture is on the recorder's `revisions` row agrees with it
    // (`spec/store` §8 H1 — the check `doctor` used to call "no dangling
    // current_rev").
    let headless: i64 = conn.query_row(
        "SELECT count(*) c FROM docs d WHERE d.deleted_at IS NULL AND d.head IS NULL",
        [],
        |r| r.get(0),
    )?;
    checks.push(Check {
        name: "head present",
        ok: headless == 0,
        detail: format!("{headless} without a head"),
    });
    let uncaptured: i64 = conn.query_row(
        "SELECT count(*) c FROM docs d WHERE d.deleted_at IS NULL AND d.head IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.rev_id = d.head)",
        [],
        |r| r.get(0),
    )?;
    checks.push(Check {
        name: "capture complete",
        ok: uncaptured == 0,
        detail: format!("{uncaptured} heads without a revision"),
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

/// The tables shown under each category of the human size report.
const TOP_TABLES: usize = 3;
/// The bytes/share cell without dbstat.
const NO_BYTES: &str = "—";
/// The bytes cell's width: the widest humanized size, `1023.9 KB`.
const BYTES_CELL: usize = 9;
/// The share cell's width: `100.0%`.
const SHARE_CELL: usize = 6;

/// `doctor --size` (§6, cli 4.3): the store's size report (`spec/store` §7
/// "Size") as one aligned table — each category, then its three biggest
/// tables indented — the file's page accounting, and the advice lines.
/// Exit 0: a size report is information, not a check. The bytes and share
/// cells are right-aligned in fixed widths so the layout is the same
/// whatever the numbers — which is what lets the fixtures pin it by shape (§8).
fn doctor_size(cli: &mut Cli, report: &SizeReport) -> Result<i32> {
    let doc = report.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    for line in size_lines(report, &cli.style) {
        cli.io.out(&line);
    }
    Ok(EXIT_OK)
}

/// The human size report's stdout lines (§6 `doctor --size`).
fn size_lines(report: &SizeReport, style: &Style) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = |n: Option<u64>| {
        pad_start(
            &n.map_or_else(|| NO_BYTES.to_owned(), human_bytes),
            BYTES_CELL,
        )
    };
    let share = |s: Option<f64>| {
        pad_start(
            &s.map_or_else(|| NO_BYTES.to_owned(), format_share),
            SHARE_CELL,
        )
    };
    // The last column is never padded by `columns`, so the row counts are
    // right-aligned here (to the widest count, or the header).
    let rows_width = report
        .categories
        .iter()
        .flat_map(|c| {
            std::iter::once(c.rows).chain(c.tables.iter().take(TOP_TABLES).map(|t| t.rows))
        })
        .map(|n| n.to_string().len())
        .max()
        .unwrap_or(0)
        .max(4);
    let count = |n: u64| pad_start(&n.to_string(), rows_width);
    let mut rows: Vec<Vec<String>> = vec![vec![
        style.dim("category"),
        style.dim(&pad_start("bytes", BYTES_CELL)),
        style.dim(&pad_start("share", SHARE_CELL)),
        style.dim(&pad_start("rows", rows_width)),
    ]];
    for c in &report.categories {
        rows.push(vec![
            style.accent(c.name),
            bytes(c.bytes),
            share(c.share),
            count(c.rows),
        ]);
        for t in c.tables.iter().take(TOP_TABLES) {
            rows.push(vec![
                format!("  {}", t.name),
                bytes(t.bytes),
                share(t.share),
                count(t.rows),
            ]);
        }
    }
    for line in columns(&rows, &[Align::Left, Align::Right, Align::Right]) {
        out.push(format!("  {line}"));
    }
    if let Some(detail) = report.detail {
        out.push(style.dim(&format!("  {detail}: row counts only")));
    }
    out.push(String::new());
    let f = &report.file;
    let file = vec![
        vec!["file".to_owned(), style.path(&f.path)],
        vec![
            "size".to_owned(),
            format!(
                "{} on disk, wal {}",
                human_bytes(f.bytes),
                human_bytes(f.wal_bytes)
            ),
        ],
        vec![
            "pages".to_owned(),
            format!(
                "{} x {} bytes, {} free",
                f.page_count, f.page_size, f.freelist_count
            ),
        ],
        vec!["reclaimable".to_owned(), human_bytes(f.reclaimable)],
        // 15.0: the history that already moved to archive segments (`spec/store` §7.1).
        vec![
            "archived".to_owned(),
            format!(
                "{} revisions in {} segments, {} on disk",
                report.archived.revisions,
                report.archived.segments,
                human_bytes(report.archived.bytes)
            ),
        ],
    ];
    for line in columns(&file, &[Align::Left]) {
        out.push(format!("  {line}"));
    }
    for a in &report.advice {
        out.push(format!("  {} {a}", style.dim("advice:")));
    }
    out
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
    // The repo's effective `embedding.*` settings when a provider is named —
    // and the capability discovery that goes with them (Phase 2).
    let Some(cfg) = cli.discover_semantic()? else {
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
    // A configured provider means the capability is `enabled` (discovery);
    // only a store opened without the bundle (`OMGBASE_CAPABILITIES=core`)
    // lacks it here.
    let Some(sem) = store.semantic() else {
        return Err(CliError::engine_data(
            "capability_unavailable",
            omgbase_surface::SEMANTIC_DISABLED_MESSAGE,
            json!({
                "capability": "semantic",
                "state": "disabled",
                "fix": omgbase_surface::SEMANTIC_DISABLED_FIX,
            }),
        ));
    };
    let conn = store.conn();

    if sub == Some("drain") {
        let queue = sem.queue(conn, &repo.repo_id, Some(&model))?;
        let pending = queue.stale_blocks;
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
        // The indexer (Phase 2): positioned by the watermark — a bootstrap,
        // a catch-up over what the feed names, or a rescan with the prune of
        // gone entities when the cursor cannot be served.
        let outcome = sem.drain(store, &repo.repo_id, provider.as_ref())?;
        let stats = outcome.stats;
        let pruned = if prune {
            let p = sem.prune_foreign(conn, &model)?;
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
        m.insert("mode".to_owned(), json!(outcome.mode.as_str()));
        m.insert("processedSeq".to_owned(), json!(outcome.processed_seq));
        if let Some(n) = outcome.docs_rescanned {
            m.insert("docsRescanned".to_owned(), json!(n));
        }
        if stats.docs.skipped > 0 {
            m.insert("skipped".to_owned(), json!(stats.docs.skipped));
        }
        if outcome.pruned.blocks > 0 || outcome.pruned.docs > 0 {
            m.insert(
                "swept".to_owned(),
                json!({ "blocks": outcome.pruned.blocks, "docs": outcome.pruned.docs }),
            );
        }
        let doc = Json::Object(m);
        if let Some(code) = machine_out(cli, &doc, None, None) {
            return code;
        }
        let how = match outcome.docs_rescanned {
            Some(n) => format!("{} over {n} changed doc(s)", outcome.mode.as_str()),
            None => outcome.mode.as_str().to_owned(),
        };
        cli.io.err(&format!(
            "  {} embedded {embedded}, cached {cached} {}",
            style.ok(style.glyphs().ok),
            style.dim(&format!("({how}; watermark seq {})", outcome.processed_seq))
        ));
        if outcome.pruned.blocks > 0 || outcome.pruned.docs > 0 {
            cli.io.err(&style.dim(&format!(
                "  swept {} block + {} doc vector(s) whose entity is gone",
                outcome.pruned.blocks, outcome.pruned.docs
            )));
        }
        return Ok(EXIT_OK);
    }

    // status
    let queue = sem.queue(conn, &repo.repo_id, Some(&model))?;
    let foreign = sem.foreign(conn, &model)?;
    let identity = omgbase_store::IndexIdentity::of(provider.as_ref());
    let freshness = sem.freshness(store, &repo.repo_id, Some(&identity))?;
    let dim = provider.dim();
    let doc = json!({
        "provider": provider_name,
        "model": model,
        "dim": dim,
        "embeddable": queue.embeddable,
        "queued": queue.stale_blocks,
        "docs": queue.docs,
        "docsQueued": queue.stale_docs,
        "foreignBlocks": foreign.blocks,
        "foreignDocs": foreign.docs,
        "freshness": freshness.to_json(),
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
        "  embeddable {}   {} {}",
        queue.embeddable,
        style.dim("queued"),
        queue.stale_blocks
    ));
    cli.io.out(&format!(
        "  docs {}   {} {}",
        queue.docs,
        style.dim("queued"),
        queue.stale_docs
    ));
    // Phase 2: the indexer's position against the head.
    let position = match freshness.processed_seq {
        Some(seq) if freshness.fresh => format!("fresh (seq {seq} = head)"),
        Some(seq) if freshness.index.as_ref().is_some_and(|i| *i != identity) => format!(
            "indexed under another model/config (seq {seq}; head {}) — the next drain rebuilds",
            freshness.head
        ),
        Some(seq) => format!("behind (seq {seq}; head {})", freshness.head),
        None => format!("not yet drained (head {})", freshness.head),
    };
    cli.io.out(&format!("  index {}", style.dim(&position)));
    if queue.stale_blocks > 0 || queue.stale_docs > 0 {
        cli.io.out(&style.dim(&format!(
            "  run `omg embed drain` to embed the {} queued block(s) + {} doc(s)",
            queue.stale_blocks, queue.stale_docs
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

    /// §6 `doctor --size`: the human table — fixed-width bytes/share cells,
    /// row counts right-aligned, three tables per category, the file block
    /// and the advice lines — rendered from a report built by hand.
    #[test]
    fn size_report_lines() {
        use omgbase_store::{SizeCategory, SizeFile, SizeTable, share_of};
        let total = 1_000_000u64;
        let table = |name: &str, bytes: u64, rows: u64| SizeTable {
            name: name.to_owned(),
            bytes: Some(bytes),
            share: Some(share_of(bytes, total)),
            rows,
            indexes: Some(0),
        };
        let cat = |name: &'static str, tables: Vec<SizeTable>| {
            let bytes: u64 = tables.iter().filter_map(|t| t.bytes).sum();
            SizeCategory {
                name,
                bytes: Some(bytes),
                share: Some(share_of(bytes, total)),
                rows: tables.iter().map(|t| t.rows).sum(),
                tables,
            }
        };
        let report = SizeReport {
            file: SizeFile {
                path: "/w/.omgbase/omgbase.db".into(),
                bytes: 1_048_576,
                wal_bytes: 0,
                page_size: 4096,
                page_count: 256,
                freelist_count: 12,
                reclaimable: 49_152,
            },
            categories: vec![
                cat(
                    "content",
                    vec![
                        table("blocks", 500_000, 12345),
                        table("nodes", 100_000, 20),
                        table("docs", 20_000, 3),
                        table("edges", 4_096, 0),
                    ],
                ),
                cat("history", vec![table("blobs", 300_000, 400)]),
                cat("search", vec![]),
                cat("sync", vec![table("sqlite_schema", 75_904, 85)]),
            ],
            same_dispositions: 0,
            archived: omgbase_store::SizeArchived {
                revisions: 2,
                segments: 1,
                bytes: 12_288,
            },
            advice: vec!["nothing to reclaim".to_owned()],
            detail: None,
        };
        let style = Style::detect(true, false);
        let lines = size_lines(&report, &style);
        // The name column is as wide as `  sqlite_schema` (15); three tables
        // per category at most (`edges` is cut); 624,096 bytes is 609.5 KB.
        assert_eq!(
            lines,
            [
                "  category             bytes   share   rows",
                "  content           609.5 KB   62.4%  12368",
                "    blocks          488.3 KB   50.0%  12345",
                "    nodes            97.7 KB   10.0%     20",
                "    docs             19.5 KB    2.0%      3",
                "  history           293.0 KB   30.0%    400",
                "    blobs           293.0 KB   30.0%    400",
                "  search                 0 B    0.0%      0",
                "  sync               74.1 KB    7.6%     85",
                "    sqlite_schema    74.1 KB    7.6%     85",
                "",
                "  file         /w/.omgbase/omgbase.db",
                "  size         1.0 MB on disk, wal 0 B",
                "  pages        256 x 4096 bytes, 12 free",
                "  reclaimable  48.0 KB",
                "  archived     2 revisions in 1 segments, 12.0 KB on disk",
                "  advice: nothing to reclaim",
            ]
        );
        // Without dbstat the cells are `—` and the fallback line follows the table.
        let blind = SizeReport {
            categories: report
                .categories
                .iter()
                .map(|c| SizeCategory {
                    bytes: None,
                    share: None,
                    tables: c
                        .tables
                        .iter()
                        .map(|t| SizeTable {
                            bytes: None,
                            share: None,
                            indexes: None,
                            ..t.clone()
                        })
                        .collect(),
                    ..c.clone()
                })
                .collect(),
            detail: Some("dbstat unavailable"),
            ..report
        };
        let lines = size_lines(&blind, &style);
        assert_eq!(
            lines[1],
            format!("  {:<15}  {:>9}  {:>6}  12368", "content", "—", "—")
        );
        assert_eq!(lines[10], "  dbstat unavailable: row counts only");
        assert_eq!(lines[11], "");
    }
}
