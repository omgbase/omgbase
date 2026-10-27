//! The admin verbs (`spec/cli` §6): `rebuild-index`, `gc`, `doctor`,
//! `config`, `embed`. No MCP tool maps to them — each is a library operation
//! over the store (`spec/store` §7), the settings of `spec/sync` §3 or the
//! embedding queue of `spec/search` §2 — so §3.2 gives their `--json` shapes
//! and the CLI names what it did.

use omgbase_search::{EmbeddingProvider, create_external_provider};
use omgbase_store::{
    Error as StoreError, LIVE_LEAF_SQL, ManifestState, NATIVE_PROVIDER, RebuildTarget,
    SemanticLifecycleResult, SizeCapability, SizeReport, active_alerts, format_share,
    history_provider_of, human_bytes, open_coverage_from, read_capability,
    refresh_legacy_bytes_alert, semantic_provider_of,
};
use omgbase_sync::settings::{
    Settings, repo_own_settings, resolve_settings, workspace_settings, write_repo_settings_at,
    write_workspace_settings_at,
};
use omgbase_sync::with_writer_lock;
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
/// wrote, reported as the third count (`sameDispositionsSwept`); since store
/// 17.0 the same run prunes the id claims older than
/// `identity.claims_retain_days` that name no row (`spec/store` §7.3),
/// reported as `claimsReleased` — the human line shows it only when
/// non-zero (the line is pinned by shape without it, and the setting is off
/// by default) — and (3d) the change-feed rows past `feed.retain_days` /
/// `feed.retain_entries` (`spec/store` §7.4), reported as `feedPruned`, the
/// human line likewise only when non-zero.
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
    doc.insert("claimsReleased".to_owned(), json!(result.claims_released));
    doc.insert("feedPruned".to_owned(), json!(result.feed_pruned));
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
    let released = if result.claims_released > 0 {
        format!(", {} id claims released", result.claims_released)
    } else {
        String::new()
    };
    let pruned = if result.feed_pruned > 0 {
        format!(", {} feed rows pruned", result.feed_pruned)
    } else {
        String::new()
    };
    cli.io.err(&cli.style.dim(&format!(
        "  swept {} blobs, {} tree nodes, {} same dispositions{released}{pruned}",
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

/// `doctor [--json]` — the five checks on the selected repo; exit 1 when any
/// fails. `doctor --size` (cli 4.3) is the size report instead (exit 0). The
/// `convergence` check — `repos_status.unconverged === 0` — left with the
/// count in store 17.0 (D9): `file_hash` IS the head's hash by construction
/// (I1), so it was identically true; `disk.changed` is the signal.
pub fn doctor(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "doctor");
    }
    let a = parse_args(args, &[Opt::flag("size")])?;
    cli.workspace()?;
    if a.flag("size") {
        // The retention advice (15.0) is evaluated at the pinned clock. The
        // size report is store-wide; its `feed` line is a repository's
        // (`spec/store` §7.2, 17.0) — the selected one when the selection
        // resolves, else the store's only one (the report decides), never an
        // error.
        let now = cli.now();
        let repo_id = selected_repo_id(cli)?;
        let report = cli.store()?.size_report_at(&now, repo_id.as_deref())?;
        return doctor_size(cli, &report);
    }
    // The selected repo must resolve (`repo_not_found` otherwise); the checks
    // are store-wide but the alerts are its.
    let repo = cli.repo()?;
    let now = cli.now();
    let store = cli.store()?;
    let conn = store.conn();
    let mut checks: Vec<Check> = Vec::with_capacity(6);

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
    // capture is on the recorder's `revisions` row agrees with it
    // (`spec/store` §8 H1 — the check `doctor` used to call "no dangling
    // current_rev"). Phase 4a: the check reads the repository's manifest — a
    // head minted within the open coverage interval owes a revision; a
    // repository whose capture is off (or a build without the module) owes
    // none and the check says so in its detail.
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

    // Store 17.4 (Phase 5a-ii; `spec/store` §5.11, §8 C9): every live
    // document's rows reproduce its `file_hash` — the fidelity check the
    // migration runs, re-derived here in full for the selected repository,
    // and the `legacy_bytes` alert written to match (raised with the count and
    // a sample of ids, or cleared), so the `alerts` check below sees the
    // current condition. A document ingested before block trivia was stored
    // fails it until `omg sync` repairs its rows from the file.
    let legacy = refresh_legacy_bytes_alert(conn, &repo.repo_id, &now, None)?;
    checks.push(Check {
        name: "bytes reproducible",
        ok: legacy.is_empty(),
        detail: format!(
            "{} document(s) not reproducible from their rows",
            legacy.len()
        ),
    });

    let manifest = read_capability(conn, &repo.repo_id, "history")?;
    let since = open_coverage_from(manifest.as_ref());
    let recorder = store.capture_for(Some(&repo.repo_id))?;
    let provider = history_provider_of(manifest.as_ref()).to_owned();
    match (recorder, since) {
        // Phase 6a (`spec/cli` §6, 5.5): a git-provider repository's capture is
        // the worker's — the check reads how far the branch tip lags the heads;
        // `provider git: <n> heads not yet checkpointed`, or `unavailable` when
        // the provider cannot run.
        (_, Some(since)) if provider != NATIVE_PROVIDER => {
            let counted = store
                .require_history_reader(Some(&repo.repo_id))
                .and_then(|reader| reader.uncaptured_heads(conn, &repo.repo_id, since));
            match counted {
                Ok(uncaptured) => checks.push(Check {
                    name: "capture complete",
                    ok: uncaptured == 0,
                    detail: format!("provider {provider}: {uncaptured} heads not yet checkpointed"),
                }),
                Err(StoreError::HistoryProviderUnavailable { reason, .. }) => checks.push(Check {
                    name: "capture complete",
                    ok: false,
                    detail: format!("provider {provider}: unavailable ({reason})"),
                }),
                Err(e) => return Err(e.into()),
            }
        }
        (Some(recorder), Some(since)) => {
            let uncaptured = recorder.uncaptured_heads(conn, &repo.repo_id, since)?;
            checks.push(Check {
                name: "capture complete",
                ok: uncaptured == 0,
                detail: format!("{uncaptured} heads without a revision"),
            });
        }
        _ => {
            let detail = match &manifest {
                Some(m) if m.state == ManifestState::Enabled => {
                    "history unavailable in this build".to_owned()
                }
                Some(m) if !m.coverage.is_empty() => format!(
                    "history disabled (captured {})",
                    m.coverage
                        .iter()
                        .map(|i| format!("{}..{}", i.from, i.to.as_deref().unwrap_or("now")))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                _ => "history disabled".to_owned(),
            };
            checks.push(Check {
                name: "capture complete",
                ok: true,
                detail,
            });
        }
    }

    // Store 17.0 (3e-ii): the alert channel (`spec/store` §3.1 `alerts`) —
    // the conditions the engine raised for a human on the selected
    // repository; any active one fails the check and is named in its detail.
    let alerts = active_alerts(conn, &repo.repo_id, &now)?;
    checks.push(Check {
        name: "alerts",
        ok: alerts.is_empty(),
        detail: if alerts.is_empty() {
            "none active".to_owned()
        } else {
            alerts
                .iter()
                .map(|a| format!("{}[{}]: {}", a.code, a.severity.as_str(), a.message))
                .collect::<Vec<_>>()
                .join("; ")
        },
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

/// The selected repository's id when the selection resolves; `None` when it
/// does not (an explicit `--repo <slug>` that fails is still the error).
fn selected_repo_id(cli: &mut Cli) -> Result<Option<String>> {
    match cli.repo() {
        Ok(r) => Ok(Some(r.repo_id)),
        Err(CliError::Engine { code, .. })
            if code == "repo_not_found" && cli.flags.repo.is_none() =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
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
        // 17.0: the identity claims (`spec/store` §2.1) — one row per id ever
        // minted and still held; `identity.claims_retain_days` lets `gc`
        // release old ones (§7.3).
        vec![
            "id claims".to_owned(),
            format!("{} ids claimed", report.id_claims),
        ],
        // 17.0 (3e): the change feed's position (`spec/store` §7.2 `feed`,
        // §7.4) — the report's repository's; none when the store has several
        // and none was selected.
        vec![
            "feed".to_owned(),
            match &report.feed {
                Some(f) => format!(
                    "epoch {}, {} entries, seq {}..{}",
                    f.epoch, f.entries, f.oldest, f.head
                ),
                None => "no repository selected".to_owned(),
            },
        ],
        // 17.0 (3e-ii): the capability manifest of the same repository
        // (`spec/store` §3.1 `capabilities`): `history  enabled since <ts> |
        // disabled`, `semantic  enabled (<model>) | disabled`.
        vec![
            "history".to_owned(),
            capability_line(report.capabilities.as_deref(), "history"),
        ],
        vec![
            "semantic".to_owned(),
            capability_line(report.capabilities.as_deref(), "semantic"),
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

/// The manifest line of one capability: `enabled since <coverage_from>` for
/// history, `enabled (<model>)` for semantic, `disabled`, or `no repository
/// selected` like `feed`.
fn capability_line(capabilities: Option<&[SizeCapability]>, name: &str) -> String {
    let Some(capabilities) = capabilities else {
        return "no repository selected".to_owned();
    };
    let Some(c) = capabilities
        .iter()
        .find(|c| c.capability == name && c.state == ManifestState::Enabled)
    else {
        return "disabled".to_owned();
    };
    if name == "history" {
        // Phase 6a: a provider row says which — `enabled since <ts> (git)`.
        let provider = c
            .config
            .get("provider")
            .and_then(Json::as_str)
            .map_or_else(String::new, |p| format!(" ({p})"));
        return match &c.coverage_from {
            Some(from) => format!("enabled since {from}{provider}"),
            None => format!("enabled{provider}"),
        };
    }
    match c.config.get("model").and_then(Json::as_str) {
        Some(model) => format!("enabled ({model})"),
        None => "enabled".to_owned(),
    }
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
    let now = cli.now();
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
            // Store 17.0 (3e-ii): a settings write re-derives the semantic
            // manifest row at the clock (`spec/store` §3.1 `capabilities`).
            match &scope {
                Scope::Workspace => {
                    let mut s = workspace_settings(store)?;
                    set_path(&mut s, key, coerce(raw));
                    write_workspace_settings_at(store, &s, &now)?;
                }
                Scope::Repo { repo_id, .. } => {
                    let mut s = repo_own_settings(store, repo_id)?;
                    set_path(&mut s, key, coerce(raw));
                    write_repo_settings_at(store, repo_id, &s, &now)?;
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

/// `embed [status]` · `embed enable [--provider <p>]` · `embed disable` ·
/// `embed drain [--verbose] [--prune]` — semantic indexing: its switch per
/// repository (`spec/store` §5.10, Phase 4b) and the embedding queue.
pub fn embed(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let sub = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(String::as_str);
    if args.iter().any(|a| a == "--help" || a == "-h") || sub == Some("help") {
        return render_help_for(cli, "embed");
    }
    if let Some(verb @ ("enable" | "disable")) = sub {
        let rest: Vec<String> = args.iter().filter(|a| *a != verb).cloned().collect();
        return embed_lifecycle(cli, verb, &rest);
    }
    let prune = args.iter().any(|a| a == "--prune");
    cli.workspace()?;
    let repo = cli.repo()?;
    // The repo's effective `embedding.*` settings when a provider is named —
    // and the capability discovery that goes with them (Phase 2).
    let Some(cfg) = cli.discover_semantic()? else {
        return no_provider(cli);
    };
    // `status`/`drain` are the explicit semantic verbs: a row switched off by
    // `embed disable` while the provider stays configured refuses them
    // (`spec/store` §5.10, Phase 4b) rather than reporting nothing.
    if cli.store()?.semantic_switched_off(&repo.repo_id)? {
        return Err(StoreError::SemanticSwitchedOff.into());
    }
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

/// A semantic coverage interval's `from..to` as the human lines print it.
fn semantic_interval(i: &omgbase_store::CoverageInterval) -> String {
    format!("{}..{}", i.from, i.to.as_deref().unwrap_or("now"))
}

/// `embed enable [--provider <p>]` / `embed disable` (`spec/store` §5.10,
/// Phase 4b): the semantic manifest row is the verbs'. `enable` with
/// `--provider` first writes `embedding.provider` at the WORKSPACE layer (as
/// `init --embedder` does — one vector space per workspace; that write
/// re-derives every repository's row whose provider changed), then sets the
/// selected repository's row `enabled` with an open coverage interval;
/// without a configured provider it is a usage error. `disable` closes the
/// interval and sets `disabled` — the provider setting and the vectors stay.
/// Stderr `  semantic enabled since <ts> (provider <p>)` / `  semantic
/// already enabled since <ts> (provider <p>)` / `  semantic disabled
/// (embedded <from>..<to>[, …])` / `  semantic already disabled`; `--json` `{
/// state, coverage, provider, changed }`. Under the writer lock (a manifest
/// write). The reference's `runEmbedLifecycle`.
fn embed_lifecycle(cli: &mut Cli, verb: &str, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[Opt::value("provider")])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let provider_flag = a.value("provider").map(str::to_owned);
    if verb == "disable" && provider_flag.is_some() {
        return Err(CliError::usage("--provider goes with embed enable"));
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    // `--provider`'s settings write may itself flip the row (a provider change
    // re-derives it): the verb reports `changed` when the state moved either way.
    let state_before = read_capability(store.conn(), &repo.repo_id, "semantic")?
        .map_or(ManifestState::Disabled, |r| r.state);
    let result: SemanticLifecycleResult = with_writer_lock(&ws.omgbase_dir, lock, || {
        if verb == "enable" {
            if let Some(p) = &provider_flag {
                if p.trim().is_empty() {
                    return Err(omgbase_sync::Error::Other(
                        "usage: --provider needs a <command|url>".to_owned(),
                    ));
                }
                let mut current = workspace_settings(store)?;
                let mut embedding = current
                    .get("embedding")
                    .and_then(Json::as_object)
                    .cloned()
                    .unwrap_or_default();
                embedding.insert("provider".to_owned(), json!(p));
                current.insert("embedding".to_owned(), Json::Object(embedding));
                write_workspace_settings_at(store, &current, &now)?;
            }
            // A core-only build cannot enable what it does not carry
            // (`capability_unavailable { semantic, disabled }`).
            if store.semantic().is_none() {
                return Err(omgbase_sync::Error::Other(
                    "semantic module absent".to_owned(),
                ));
            }
            store
                .enable_semantic(&repo.repo_id, &now)
                .map_err(omgbase_sync::Error::from)
        } else {
            store
                .disable_semantic(&repo.repo_id, &now)
                .map_err(omgbase_sync::Error::from)
        }
    })
    .map_err(|e| match e {
        omgbase_sync::Error::Store(StoreError::SemanticProviderMissing) => {
            CliError::usage(omgbase_store::SEMANTIC_PROVIDER_MISSING_MESSAGE)
        }
        omgbase_sync::Error::Other(m) if m == "usage: --provider needs a <command|url>" => {
            CliError::usage("--provider needs a <command|url>")
        }
        omgbase_sync::Error::Other(m) if m == "semantic module absent" => CliError::engine_data(
            "capability_unavailable",
            omgbase_surface::SEMANTIC_DISABLED_MESSAGE,
            json!({
                "capability": "semantic",
                "state": "disabled",
                "fix": omgbase_surface::SEMANTIC_DISABLED_FIX,
            }),
        ),
        other => other.into(),
    })?;
    let row = &result.row;
    let changed = result.changed || row.state != state_before;
    let provider = semantic_provider_of(store.conn(), &repo.repo_id)?;
    let mut doc = result.to_json(provider.as_deref());
    doc["changed"] = json!(changed);
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let style = cli.style;
    let line = if verb == "enable" {
        let since =
            open_coverage_from(Some(row)).map_or_else(String::new, |s| format!(" since {s}"));
        let with = provider
            .as_deref()
            .map_or_else(String::new, |p| format!(" (provider {p})"));
        format!(
            "  semantic {}{since}{with}",
            if changed {
                "enabled"
            } else {
                "already enabled"
            }
        )
    } else if changed || !row.coverage.is_empty() {
        format!(
            "  semantic {} (embedded {})",
            if changed {
                "disabled"
            } else {
                "already disabled"
            },
            row.coverage
                .iter()
                .map(semantic_interval)
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        "  semantic already disabled".to_owned()
    };
    cli.io.err(&style.dim(&line));
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
            id_claims: 438,
            archived: omgbase_store::SizeArchived {
                revisions: 2,
                segments: 1,
                bytes: 12_288,
            },
            feed: Some(omgbase_store::SizeFeed {
                epoch: "ep_0".into(),
                oldest: 1,
                head: 20,
                entries: 20,
                retain_days: 10,
                retain_entries: 10_000,
                max_entries: 100_000,
            }),
            capabilities: Some(vec![
                SizeCapability {
                    capability: "history",
                    state: ManifestState::Enabled,
                    coverage_from: Some("2026-09-27T00:00:00.000Z".into()),
                    config: Map::new(),
                },
                SizeCapability {
                    capability: "semantic",
                    state: ManifestState::Enabled,
                    coverage_from: Some("2026-09-27T00:00:00.000Z".into()),
                    config: json!({ "model": "gte-base", "dim": 768 })
                        .as_object()
                        .cloned()
                        .unwrap(),
                },
            ]),
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
                "  id claims    438 ids claimed",
                "  feed         epoch ep_0, 20 entries, seq 1..20",
                "  history      enabled since 2026-09-27T00:00:00.000Z",
                "  semantic     enabled (gte-base)",
                "  advice: nothing to reclaim",
            ]
        );
        // The manifest lines' other forms: disabled, enabled without a
        // model or a coverage start, and no repository selected.
        assert_eq!(capability_line(None, "history"), "no repository selected");
        let rows = [
            SizeCapability {
                capability: "history",
                state: ManifestState::Enabled,
                coverage_from: None,
                config: Map::new(),
            },
            SizeCapability {
                capability: "semantic",
                state: ManifestState::Disabled,
                coverage_from: None,
                config: Map::new(),
            },
        ];
        assert_eq!(capability_line(Some(&rows), "history"), "enabled");
        assert_eq!(capability_line(Some(&rows), "semantic"), "disabled");
        let bare = [SizeCapability {
            capability: "semantic",
            state: ManifestState::Enabled,
            coverage_from: Some("2026-09-27T00:00:00.000Z".into()),
            config: Map::new(),
        }];
        assert_eq!(capability_line(Some(&bare), "semantic"), "enabled");
        assert_eq!(capability_line(Some(&bare), "history"), "disabled");
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
