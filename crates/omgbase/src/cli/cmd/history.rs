//! `history <enable|disable|purge|checkpoint|plan|export|attach|detach|list>`
//! (`spec/cli` §6 `history`, cli 4.6; `enable|disable` cli 5.1 — store 17.1
//! Phase 4a; `purge` cli 5.2 — store 17.2 Phase 4b; `enable --provider git`,
//! `checkpoint` and `purge` on a git repository cli 5.5 — store 17.5 Phase
//! 6a, `spec/store` §5.12): the operator surface of history
//! CAPTURE (`spec/store` §5.9: `enable` turns the repository's capture on with
//! a baseline commit and opens a coverage interval, `disable` closes it — the
//! rows stay, reads of what was captured keep working; §7.6: `purge` removes
//! the rows) and of history RETENTION (`spec/store` §7.1, 15.0: `plan`
//! evaluates the policy and prints what would move; `export` writes one
//! archive segment and with `--prune` squashes the store; `attach` / `detach`
//! / `list` manage the segment registry). No MCP tool: the catalog's traces
//! are `version.capabilities.history`, the `revisions.archived` attribute,
//! `capability_unavailable` and `revision_archived`. Port of
//! `packages/cli/src/cmd/history.ts`.

use std::path::{Path, PathBuf};

use omgbase_git_adapter::{GIT_PROVIDER, parse_cadence};
use omgbase_store::{
    ARCHIVE_DIR, ArchiveListing, CheckpointResult, CoverageInterval, Error as StoreError,
    ExportOptions, ExportResult, HistoryLifecycleResult, HistoryPurgeResult, ManifestState,
    NATIVE_PROVIDER, RetentionOptions, RetentionPlan, RetentionPolicy, SegmentInfo,
    history_provider_of, human_bytes, open_coverage_from, read_capability,
};
use omgbase_sync::with_writer_lock;
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::{Cli, WsInfo, resolve_path};
use crate::cli::help::render_help_for;
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};
use crate::cli::render::{Align, columns};
use crate::cli::seams::canonical_instant;

use super::machine_out;

const SUBCOMMANDS: [&str; 9] = [
    "enable",
    "disable",
    "purge",
    "checkpoint",
    "plan",
    "export",
    "attach",
    "detach",
    "list",
];
/// `--provider`'s values (`spec/cli` §6, 5.5).
const PROVIDERS: [&str; 2] = [NATIVE_PROVIDER, GIT_PROVIDER];

pub fn history(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let sub = args.first().map(String::as_str);
    let rest: &[String] = if args.is_empty() { &[] } else { &args[1..] };
    if matches!(sub, None | Some("--help" | "-h" | "help"))
        || rest.iter().any(|a| a == "--help" || a == "-h")
    {
        return render_help_for(cli, "history");
    }
    let sub = sub.unwrap_or_default();
    if !SUBCOMMANDS.contains(&sub) {
        return Err(CliError::usage_hint(
            format!(
                "unknown history subcommand '{sub}' ({})",
                SUBCOMMANDS.join("|")
            ),
            format!("run '{} history --help'", cli.prog),
        ));
    }
    match sub {
        "enable" => enable(cli, rest),
        "disable" => disable(cli, rest),
        "purge" => purge(cli, rest),
        "checkpoint" => checkpoint(cli, rest),
        "plan" => plan(cli, rest),
        "export" => export(cli, rest),
        "attach" => attach(cli, rest),
        "detach" => detach(cli, rest),
        _ => list(cli, rest),
    }
}

/// `--policy <json|@file>`: a JSON value, or the contents of the file after `@`.
fn parse_policy(cli: &Cli, raw: Option<&str>) -> Result<Option<Json>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let text = match raw.strip_prefix('@') {
        Some(file) => std::fs::read_to_string(resolve_path(&cli.cwd, file))
            .map_err(|e| CliError::usage(format!("--policy: cannot read {file}: {e}")))?,
        None => raw.to_owned(),
    };
    serde_json::from_str::<Json>(&text).map(Some).map_err(|_| {
        CliError::usage(format!(
            "--policy: not JSON ({})",
            if raw.starts_with('@') {
                raw
            } else {
                "pass an object, or @file"
            }
        ))
    })
}

/// `--before <ts>`: an RFC 3339 instant, canonicalized to the store's form.
fn parse_before(raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    // `Date.parse` also takes a bare date (midnight UTC).
    let canonical = canonical_instant(raw).or_else(|| {
        (raw.len() == 10 && raw.as_bytes()[4] == b'-' && raw.as_bytes()[7] == b'-')
            .then(|| canonical_instant(&format!("{raw}T00:00:00.000Z")))
            .flatten()
    });
    canonical
        .map(Some)
        .ok_or_else(|| CliError::usage(format!("bad --before '{raw}' (use an RFC 3339 instant)")))
}

/// The repo's effective policy with the run's `--policy` over it; a malformed
/// policy is a usage error.
fn policy_of(cli: &mut Cli, repo_id: &str, raw: Option<&str>) -> Result<RetentionPolicy> {
    let override_ = parse_policy(cli, raw)?;
    match cli.store()?.retention_policy(repo_id, override_.as_ref()) {
        Ok(p) => Ok(p),
        Err(StoreError::RetentionPolicy(msg)) => Err(CliError::usage(format!("--policy: {msg}"))),
        Err(e) => Err(e.into()),
    }
}

/// A coverage interval's `from..to` as the human lines print it.
fn interval(i: &CoverageInterval) -> String {
    format!("{}..{}", i.from, i.to.as_deref().unwrap_or("now"))
}

/// The `enable`/`disable` rendering: `--json` the manifest row's capture
/// state `{ state, coverage, writer_requires, changed, provider?, baseline?,
/// tip? }` (`baseline` the commit and the revisions it wrote, on an `enable`
/// that changed something; the git provider's enable — `spec/cli` §6, 5.5 —
/// adds `provider` and the branch `tip` of its baseline commit); human one
/// stderr line — `  history enabled since <ts>[ via git][ (baseline …)]` /
/// `  history already enabled since <ts>[ via git]` / `  history disabled
/// (captured <from>..<to>[, …])` / `  history already disabled`.
fn render_lifecycle(cli: &mut Cli, verb: &str, r: &HistoryLifecycleResult) -> Result<i32> {
    let doc = r.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let style = cli.style;
    let row = &r.row;
    let provider = r.provider();
    let line = if verb == "enable" {
        let state = if r.changed {
            "enabled"
        } else {
            "already enabled"
        };
        let since =
            open_coverage_from(Some(row)).map_or_else(String::new, |s| format!(" since {s}"));
        let via = if provider == NATIVE_PROVIDER {
            String::new()
        } else {
            format!(" via {provider}")
        };
        let baseline = r
            .baseline
            .as_ref()
            .map_or_else(String::new, |(commit, revisions)| {
                if provider == NATIVE_PROVIDER {
                    format!(" (baseline {commit}: {})", plural_s(*revisions, "revision"))
                } else {
                    format!(
                        " (baseline {commit}: {}{})",
                        plural_s(*revisions, "document"),
                        r.tip
                            .as_deref()
                            .map_or_else(String::new, |t| format!(", tip {t}"))
                    )
                }
            });
        format!("  history {state}{since}{via}{baseline}")
    } else if r.changed || !row.coverage.is_empty() {
        format!(
            "  history {} (captured {})",
            if r.changed {
                "disabled"
            } else {
                "already disabled"
            },
            row.coverage
                .iter()
                .map(interval)
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        "  history already disabled".to_owned()
    };
    cli.io.err(&style.dim(&line));
    Ok(EXIT_OK)
}

/// `history enable [--best-effort] [--provider native|git] [--branch <b>]
/// [--cadence every|<ms>]` (`spec/store` §5.9; §5.12 for the git provider): a
/// write (the baseline commit) under the workspace writer lock like every
/// other. One provider per repository: the conflict is a usage error.
fn enable(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(
        args,
        &[
            Opt::flag("best-effort"),
            Opt::value("provider"),
            Opt::value("branch"),
            Opt::value("cadence"),
        ],
    )?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let provider = a.value("provider").unwrap_or(NATIVE_PROVIDER).to_owned();
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(CliError::usage(format!(
            "--provider must be one of {} (got {})",
            PROVIDERS.join("|"),
            js_json(&Json::String(provider))
        )));
    }
    if provider == NATIVE_PROVIDER && (a.value("branch").is_some() || a.value("cadence").is_some())
    {
        return Err(CliError::usage(
            "--branch and --cadence go with --provider git",
        ));
    }
    let mut options = serde_json::Map::new();
    if let Some(branch) = a.value("branch") {
        options.insert("branch".to_owned(), Json::String(branch.to_owned()));
    }
    if let Some(cadence) = a.value("cadence") {
        let c = parse_cadence(cadence).map_err(CliError::usage)?;
        options.insert("cadence".to_owned(), c.to_json());
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let now = cli.now();
    let writer_requires = !a.flag("best-effort");
    let lock = cli.seams.lock_options();
    let store = cli.store_mut()?;
    let provider_arg = (provider != NATIVE_PROVIDER).then_some(provider.as_str());
    let result = with_writer_lock(&ws.omgbase_dir, lock, || {
        store
            .enable_history_with(&repo.repo_id, &now, writer_requires, provider_arg, &options)
            .map_err(omgbase_sync::Error::from)
    });
    match result {
        Ok(r) => render_lifecycle(cli, "enable", &r),
        // `spec/store` §5.12: one provider per repository — the switch is `disable` then `enable --provider`.
        Err(omgbase_sync::Error::Store(e @ StoreError::HistoryProviderConflict { .. })) => {
            Err(CliError::usage(e.to_string()))
        }
        Err(e) => Err(e.into()),
    }
}

/// `history disable` (`spec/store` §5.9): needs no module.
fn disable(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    let result = with_writer_lock(&ws.omgbase_dir, lock, || {
        store
            .disable_history(&repo.repo_id, &now)
            .map_err(omgbase_sync::Error::from)
    })?;
    render_lifecycle(cli, "disable", &result)
}

/// `history purge [--before <ts>]` (`spec/store` §7.6, Phase 4b): the receipt
/// `{ purged: { <table>: n }, claims_released, coverage, tables_dropped }`
/// under `--json`; human one stderr line — `  purged <c> commit(s), <r>
/// revision(s), <d> disposition(s), <b> block change(s), <e> edge
/// transition(s), <s> segment(s); swept <x> blob(s), <y> tree node(s);
/// released <n> id claim(s)` — then `  history tables dropped` when the
/// bundle left, or `  nothing to purge` when every count is zero. Coverage
/// is untouched (it records when capture was on; a purged token reads
/// `pruned`). The git provider (`spec/cli` §6, 5.5): the bare repository and
/// the worker's cursor leave — `  purged the git history (<path> removed,
/// cursor cleared)` / `  nothing to purge (<path> is already gone)`, the
/// receipt with `provider: { name, removed, path }`.
fn render_purge(cli: &mut Cli, r: &HistoryPurgeResult) -> Result<i32> {
    let doc = r.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let style = cli.style;
    if let Some(p) = &r.provider {
        let line = if p.removed {
            format!(
                "  purged the {} history ({} removed, cursor cleared)",
                p.name, p.path
            )
        } else {
            format!("  nothing to purge ({} is already gone)", p.path)
        };
        cli.io.err(&style.dim(&line));
        return Ok(EXIT_OK);
    }
    let p = &r.purged;
    if p.total() + r.claims_released == 0 && !r.tables_dropped {
        cli.io.err(&style.dim("  nothing to purge"));
        return Ok(EXIT_OK);
    }
    cli.io.err(&style.dim(&format!(
        "  purged {}, {}, {}, {}, {}, {}; swept {}, {}; released {}",
        plural_s(p.commits, "commit"),
        plural_s(p.revisions, "revision"),
        plural_s(p.dispositions, "disposition"),
        plural_s(p.block_changes, "block change"),
        plural_s(p.edge_transitions, "edge transition"),
        plural_s(p.archives, "segment"),
        plural_s(p.blobs, "blob"),
        plural_s(p.tree_nodes, "tree node"),
        plural_s(r.claims_released, "id claim"),
    )));
    if r.tables_dropped {
        cli.io.err(&style.dim("  history tables dropped"));
    }
    Ok(EXIT_OK)
}

/// `history purge [--before <ts>]`: a write under the workspace writer lock.
fn purge(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[Opt::value("before")])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let before = parse_before(a.value("before"))?;
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    // A git history is one line of commits: `--before` has no meaning there (`spec/cli` §6, 5.5).
    if before.is_some() {
        let row = read_capability(store.conn(), &repo.repo_id, "history")?;
        if history_provider_of(row.as_ref()) != NATIVE_PROVIDER {
            return Err(CliError::usage(
                "--before has no meaning for the git provider: history purge removes the whole bare repository",
            ));
        }
    }
    let result = with_writer_lock(&ws.omgbase_dir, lock, || {
        store
            .purge_history_at(&repo.repo_id, before.as_deref(), &now)
            .map_err(omgbase_sync::Error::from)
    })?;
    render_purge(cli, &result)
}

/// `history checkpoint` (`spec/cli` §6, 5.5; `spec/store` §5.12): the git
/// provider's worker, once, under the writer lock; `--json` the receipt `{
/// committed, from_seq, to_seq, tip, rescanned }`, human `  checkpointed <n>
/// commit(s) (seq <from>..<to>), tip <sha>` / `  nothing to checkpoint (tip
/// <sha>)` / `  rescanned: 1 commit at seq <head>, tip <sha>`. On a native
/// repository it is a usage error: the recorder captures in every commit.
fn checkpoint(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let now = cli.now();
    let prog = cli.prog.clone();
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    let row = read_capability(store.conn(), &repo.repo_id, "history")?;
    let provider = history_provider_of(row.as_ref()).to_owned();
    if provider == NATIVE_PROVIDER {
        return Err(CliError::usage_hint(
            "history checkpoint is the git provider's: this repository's history is native (captured in every commit)",
            format!(
                "run '{prog} history enable --provider git' after '{prog} history disable' to switch"
            ),
        ));
    }
    if !row.is_some_and(|r| r.state == ManifestState::Enabled) {
        return Err(CliError::usage(format!(
            "history is disabled for this repository — enable it with '{prog} history enable --provider {provider}'"
        )));
    }
    let result: CheckpointResult = with_writer_lock(&ws.omgbase_dir, lock, || {
        store
            .history_checkpoint(&repo.repo_id, &now)
            .map_err(omgbase_sync::Error::from)
    })?;
    let doc = result.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let style = cli.style;
    let tip = result.tip.as_deref().unwrap_or("none");
    let line = if result.rescanned {
        format!("  rescanned: 1 commit at seq {}, tip {tip}", result.to_seq)
    } else if result.committed == 0 {
        format!("  nothing to checkpoint (tip {tip})")
    } else {
        format!(
            "  checkpointed {} (seq {}..{}), tip {tip}",
            plural_s(result.committed, "commit"),
            result.from_seq,
            result.to_seq
        )
    };
    cli.io.err(&style.dim(&line));
    Ok(EXIT_OK)
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn plural_s(n: usize, one: &str) -> String {
    plural(n, one, &format!("{one}s"))
}

fn count(n: i64) -> usize {
    usize::try_from(n).unwrap_or(0)
}

/// The plan rendering (`history plan`, `history export --dry-run`).
fn render_plan(cli: &mut Cli, plan: &RetentionPlan) -> Result<i32> {
    let doc = plan.to_json();
    let items: Vec<Json> = doc["docs"].as_array().cloned().unwrap_or_default();
    let ids: Vec<String> = plan.docs.iter().map(|d| d.id.clone()).collect();
    if let Some(code) = machine_out(cli, &doc, Some(&items), Some(&ids)) {
        return code;
    }
    let style = cli.style;
    if !plan.docs.is_empty() {
        let mut rows: Vec<Vec<String>> = vec![vec![
            style.dim("path"),
            style.dim("revisions"),
            style.dim("keep"),
            style.dim("archive"),
            style.dim("bytes"),
        ]];
        for d in &plan.docs {
            rows.push(vec![
                style.accent(&d.path),
                d.revisions.to_string(),
                d.keep.len().to_string(),
                d.archive.len().to_string(),
                human_bytes(d.bytes),
            ]);
        }
        for line in columns(
            &rows,
            &[
                Align::Left,
                Align::Right,
                Align::Right,
                Align::Right,
                Align::Right,
            ],
        ) {
            cli.io.out(&format!("  {line}"));
        }
    }
    let t = &plan.totals;
    if t.archive == 0 {
        cli.io.out(&format!(
            "  nothing to archive: {}, all kept",
            plural_s(t.revisions, "revision")
        ));
    } else {
        cli.io.out(&format!(
            "  {} of {} in {} would archive {}",
            t.archive,
            plural_s(t.revisions, "revision"),
            plural_s(t.docs, "document"),
            human_bytes(t.bytes)
        ));
    }
    cli.io.out(&format!(
        "  {}  {}",
        style.dim("policy"),
        js_json(&plan.policy.to_json())
    ));
    if let Some(before) = &plan.before {
        cli.io.out(&format!("  {}  {before}", style.dim("before")));
    }
    Ok(EXIT_OK)
}

fn commit_range(lo: i64, hi: i64) -> String {
    if lo == hi {
        format!("commit #{lo}")
    } else {
        format!("commits #{lo}–#{hi}")
    }
}

fn retention_options(
    cli: &mut Cli,
    repo_id: &str,
    policy: Option<&str>,
    before: Option<&str>,
) -> Result<RetentionOptions> {
    let before = parse_before(before)?;
    let policy = policy_of(cli, repo_id, policy)?;
    Ok(RetentionOptions {
        now: cli.now(),
        before,
        policy,
    })
}

fn plan(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[Opt::value("before"), Opt::value("policy")])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    cli.workspace()?;
    let repo = cli.repo()?;
    let opts = retention_options(cli, &repo.repo_id, a.value("policy"), a.value("before"))?;
    let plan = cli.store()?.retention_plan(&repo.repo_id, &opts)?;
    render_plan(cli, &plan)
}

fn export_json(r: &ExportResult) -> Json {
    json!({
        "segment": r.segment.as_ref().map(SegmentInfo::to_json),
        "reused": r.reused,
        "squashed": r.squashed.map(|q| json!({
            "revisions": q.revisions,
            "commits": q.commits,
            "dispositions": q.dispositions,
            "block_changes": q.block_changes,
            "checkpointed": q.checkpointed,
        })),
        "gc": r.gc.map(|g| json!({ "blobs": g.blobs, "tree_nodes": g.tree_nodes })),
        "totals": r.plan.to_json()["totals"],
    })
}

fn render_export(cli: &mut Cli, r: &ExportResult) -> Result<i32> {
    let doc = export_json(r);
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let style = cli.style;
    let Some(s) = &r.segment else {
        cli.io.err(&style.dim("  nothing to archive"));
        return Ok(EXIT_OK);
    };
    cli.io.out(&s.path);
    let verb = if r.reused {
        format!("finished the unrecorded segment {}", s.id)
    } else {
        format!("wrote segment {}", s.id)
    };
    cli.io.err(&style.dim(&format!(
        "  {verb}: {} ({}), {}",
        plural_s(count(s.revision_count), "revision"),
        commit_range(s.seq_lo, s.seq_hi),
        human_bytes(u64::try_from(s.bytes).unwrap_or(0))
    )));
    if let (Some(q), Some(g)) = (r.squashed, r.gc) {
        cli.io.err(&style.dim(&format!(
            "  squashed {}, {}, {}, {}; swept {}, {}",
            plural_s(q.revisions, "revision"),
            plural_s(q.commits, "commit"),
            plural_s(q.dispositions, "disposition"),
            plural(q.block_changes, "block change", "block changes"),
            plural_s(g.blobs, "blob"),
            plural_s(g.tree_nodes, "tree node"),
        )));
    }
    Ok(EXIT_OK)
}

fn default_dest(ws: &WsInfo) -> PathBuf {
    ws.omgbase_dir.join(ARCHIVE_DIR)
}

fn export(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(
        args,
        &[
            Opt::flag("prune"),
            Opt::value("dest"),
            Opt::value("before"),
            Opt::value("policy"),
            Opt::flag("dry-run"),
        ],
    )?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let retention = retention_options(cli, &repo.repo_id, a.value("policy"), a.value("before"))?;
    if a.flag("dry-run") || cli.flags.dry_run {
        let plan = cli.store()?.retention_plan(&repo.repo_id, &retention)?;
        return render_plan(cli, &plan);
    }
    let dest = match a.value("dest") {
        Some(d) => resolve_path(&cli.cwd, d),
        None => default_dest(&ws),
    };
    let opts = ExportOptions {
        retention,
        dest,
        prune: a.flag("prune"),
    };
    let lock = cli.seams.lock_options();
    let store = cli.store_mut()?;
    // The squash is a write: under the workspace writer lock like every other.
    let result = if opts.prune {
        with_writer_lock(&ws.omgbase_dir, lock, || {
            store
                .export_history(&repo.repo_id, &opts)
                .map_err(omgbase_sync::Error::from)
        })
    } else {
        store
            .export_history(&repo.repo_id, &opts)
            .map_err(omgbase_sync::Error::from)
    };
    match result {
        Ok(r) => render_export(cli, &r),
        Err(omgbase_sync::Error::Store(StoreError::StaleSegment { path, rev })) => {
            Err(CliError::engine_data(
                "target_missing",
                StoreError::StaleSegment {
                    path: path.clone(),
                    rev: rev.clone(),
                }
                .to_string(),
                json!({ "path": path, "rev": rev }),
            ))
        }
        Err(e) => Err(e.into()),
    }
}

fn attach(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    let Some(target) = a.pos(0) else {
        return Err(CliError::usage("history attach requires a <file|dir>"));
    };
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let path = resolve_path(&cli.cwd, target);
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    let result = with_writer_lock(&ws.omgbase_dir, lock, || {
        store
            .attach_archive(&repo.repo_id, &path)
            .map_err(omgbase_sync::Error::from)
    });
    let result = match result {
        Ok(r) => r,
        Err(omgbase_sync::Error::Store(StoreError::NotASegment { path, detail })) => {
            return Err(CliError::engine_data(
                "target_missing",
                format!("{path}: {detail}"),
                json!({ "path": path }),
            ));
        }
        Err(e) => return Err(e.into()),
    };
    let attached: Vec<Json> = result
        .attached
        .iter()
        .map(|s| {
            json!({
                "segment_id": s.segment_id,
                "path": s.path,
                "seq_lo": s.seq_lo,
                "seq_hi": s.seq_hi,
                "revision_count": s.revision_count,
                "bytes": s.bytes,
            })
        })
        .collect();
    let doc = json!({ "attached": attached, "skipped": result.skipped });
    let ids: Vec<String> = result
        .attached
        .iter()
        .map(|s| s.segment_id.clone())
        .collect();
    if let Some(code) = machine_out(cli, &doc, Some(&attached), Some(&ids)) {
        return code;
    }
    let style = cli.style;
    if result.attached.is_empty() {
        cli.io.err(&style.dim("  nothing to attach"));
    }
    for s in &result.attached {
        cli.io.err(&style.dim(&format!(
            "  attached {}: {} ({}) {}",
            s.segment_id,
            plural_s(count(s.revision_count), "revision"),
            commit_range(s.seq_lo, s.seq_hi),
            s.path
        )));
    }
    if result.skipped > 0 {
        cli.io.err(&style.dim(&format!(
            "  skipped {} that {} not this repository's segments",
            plural_s(result.skipped, "file"),
            if result.skipped == 1 { "is" } else { "are" }
        )));
    }
    Ok(EXIT_OK)
}

fn detach(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage(
            "history detach requires a <segment_id|path>",
        ));
    };
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    // A ref holding `/` or ending in `.db` is a path, resolved against the cwd.
    let r = if r.contains('/') || r.ends_with(".db") {
        resolve_path(&cli.cwd, r).to_string_lossy().into_owned()
    } else {
        r.to_owned()
    };
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    let detached = with_writer_lock(&ws.omgbase_dir, lock, || {
        store
            .detach_archive(&repo.repo_id, &r)
            .map_err(omgbase_sync::Error::from)
    })?;
    let Some(detached) = detached else {
        return Err(CliError::engine_data(
            "target_missing",
            format!("no archive segment {}", Json::String(r.clone())),
            json!({ "segment": r }),
        ));
    };
    let doc = json!({ "detached": detached });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io
        .err(&cli.style.dim(&format!("  detached {detached}")));
    Ok(EXIT_OK)
}

fn list(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let dest = default_dest(&ws);
    let segments: Vec<ArchiveListing> = cli
        .store()?
        .list_archives(&repo.repo_id, Some(Path::new(&dest)))?;
    let items: Vec<Json> = segments.iter().map(ArchiveListing::to_json).collect();
    let ids: Vec<String> = segments.iter().map(|s| s.segment_id.clone()).collect();
    let doc = Json::Array(items.clone());
    if let Some(code) = machine_out(cli, &doc, Some(&items), Some(&ids)) {
        return code;
    }
    let style = cli.style;
    if segments.is_empty() {
        cli.io.err(&style.dim("  no segments"));
        return Ok(EXIT_OK);
    }
    let mut rows: Vec<Vec<String>> = vec![vec![
        style.dim("segment"),
        style.dim("commits"),
        style.dim("revisions"),
        style.dim("bytes"),
        style.dim("state"),
        style.dim("path"),
    ]];
    for s in &segments {
        rows.push(vec![
            style.id(&s.segment_id),
            if s.seq_lo == s.seq_hi {
                format!("#{}", s.seq_lo)
            } else {
                format!("#{}–#{}", s.seq_lo, s.seq_hi)
            },
            s.revision_count.to_string(),
            human_bytes(u64::try_from(s.bytes).unwrap_or(0)),
            s.state.as_str().to_owned(),
            style.path(&s.path),
        ]);
    }
    for line in columns(
        &rows,
        &[Align::Left, Align::Left, Align::Right, Align::Right],
    ) {
        cli.io.out(&format!("  {line}"));
    }
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_and_plurals() {
        assert_eq!(commit_range(2, 2), "commit #2");
        assert_eq!(commit_range(2, 21), "commits #2–#21");
        assert_eq!(plural_s(1, "revision"), "1 revision");
        assert_eq!(plural_s(2, "revision"), "2 revisions");
        assert_eq!(
            plural(0, "block change", "block changes"),
            "0 block changes"
        );
        assert_eq!(
            parse_before(Some("2026-09-27T00:00:00.000Z")).unwrap(),
            Some("2026-09-27T00:00:00.000Z".to_owned())
        );
        assert_eq!(
            parse_before(Some("2026-09-27")).unwrap(),
            Some("2026-09-27T00:00:00.000Z".to_owned())
        );
        assert_eq!(parse_before(None).unwrap(), None);
        assert_eq!(
            parse_before(Some("yesterday")).unwrap_err().message(),
            "bad --before 'yesterday' (use an RFC 3339 instant)"
        );
    }
}
