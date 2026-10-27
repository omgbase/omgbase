//! `history <enable|disable|purge|checkpoint|push|fetch|remote|plan|export|attach|detach|list>`
//! (`spec/cli` §6 `history`, cli 4.6; `enable|disable` cli 5.1 — store 17.1
//! Phase 4a; `purge` cli 5.2 — store 17.2 Phase 4b; `enable --provider git`,
//! `checkpoint` and `purge` on a git repository cli 5.5 — store 17.5 Phase
//! 6a, `spec/store` §5.12; the remote half `remote set|unset|status|resolve|
//! reconcile`, `push`, `fetch` cli 5.6 — store 17.6 Phase 6b): the operator surface of history
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

use omgbase_git_adapter::{
    FETCH_POLICIES, FetchResult, FetchState, GIT_PROVIDER, GitHistoryProvider, PUSH_POLICIES,
    ReconcileMode, ReconcileResult, RemoteOptions, RemoteStatus, ResolveChoice, ResolveResult,
    parse_cadence, read_remote_config, rewritten_message,
};
use omgbase_store::{
    ARCHIVE_DIR, ArchiveListing, CheckpointResult, Config, CoverageInterval, Error as StoreError,
    ExportOptions, ExportResult, HistoryLifecycleResult, HistoryPurgeResult, ManifestRow,
    ManifestState, NATIVE_PROVIDER, PushOutcome, RetentionOptions, RetentionPlan, RetentionPolicy,
    SegmentInfo, history_provider_of, human_bytes, open_coverage_from, provider_config_of,
    read_capability,
};
use omgbase_sync::{FsVaultSink, RealFileSystem, RepoRow, with_writer_lock};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::{Cli, WsInfo, resolve_path};
use crate::cli::help::render_help_for;
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};
use crate::cli::render::{Align, columns};
use crate::cli::seams::{canonical_instant, git_identity};

use super::machine_out;

const SUBCOMMANDS: [&str; 12] = [
    "enable",
    "disable",
    "purge",
    "checkpoint",
    "push",
    "fetch",
    "remote",
    "plan",
    "export",
    "attach",
    "detach",
    "list",
];
/// `history remote <sub>` (`spec/cli` §6, 5.6).
const REMOTE_SUBCOMMANDS: [&str; 5] = ["set", "unset", "status", "resolve", "reconcile"];
/// `history remote reconcile`'s modes, as flags.
const RECONCILE_MODES: [&str; 4] = ["rebase", "merge", "adopt", "fork"];
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
        "push" => push(cli, rest),
        "fetch" => fetch(cli, rest),
        "remote" => remote(cli, rest),
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
    // `push: "on-checkpoint"` (cli 5.6): the push that followed, or why it did not.
    if let Some(p) = &result.push {
        let line = match p {
            PushOutcome::Failed(e) => format!("  push failed: {e}"),
            PushOutcome::Pushed(r) if r.pushed => format!(
                "  pushed {}{}",
                r.tip.as_deref().unwrap_or("none"),
                through(r.pushed_through)
            ),
            PushOutcome::Pushed(_) => "  nothing to push".to_owned(),
        };
        cli.io.err(&style.dim(&line));
    }
    Ok(EXIT_OK)
}

// ---- the remote half (`spec/cli` §6 `history`, 5.6; `spec/store` §5.12 "The remote binding" …, 17.6 — Phase 6b) ----

/// ` (through seq <n>)` when a push covers a seq.
fn through(seq: Option<i64>) -> String {
    seq.map_or_else(String::new, |n| format!(" (through seq {n})"))
}

/// The selected repository as a git-provider repository: its row and a
/// handle on the provider over the workspace root, or the usage errors every
/// remote verb shares.
struct GitContext {
    ws: WsInfo,
    repo: RepoRow,
    row: ManifestRow,
    provider: GitHistoryProvider,
}

fn git_context(cli: &mut Cli, verb: &str) -> Result<GitContext> {
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    let now = cli.now();
    let prog = cli.prog.clone();
    let store = cli.store()?;
    let row = read_capability(store.conn(), &repo.repo_id, "history")?;
    let provider = history_provider_of(row.as_ref()).to_owned();
    if provider == NATIVE_PROVIDER {
        return Err(CliError::usage_hint(
            format!(
                "history {verb} is the git provider's: this repository's history is native (captured in every commit)"
            ),
            format!(
                "run '{prog} history enable --provider git' after '{prog} history disable' to switch"
            ),
        ));
    }
    let Some(row) = row.filter(|r| r.state == ManifestState::Enabled) else {
        return Err(CliError::usage(format!(
            "history is disabled for this repository — enable it with '{prog} history enable --provider {provider}'"
        )));
    };
    // The attached provider must be usable here (`git` on PATH): the store's
    // gate raises the alert and refuses as the reads do.
    store.require_provider_handle(&repo.repo_id, &provider, &now)?;
    if provider != GIT_PROVIDER {
        return Err(CliError::usage(format!(
            "history {verb} is the git provider's (this repository's provider is {provider})"
        )));
    }
    Ok(GitContext {
        provider: GitHistoryProvider::new(ws.root.clone(), git_identity()),
        ws,
        repo,
        row,
    })
}

/// The usage error of a verb needing a binding.
fn no_remote(cli: &Cli) -> CliError {
    CliError::usage_hint(
        "no remote is bound to this repository's git history",
        format!(
            "bind one with '{} history remote set --url <url>'",
            cli.prog
        ),
    )
}

fn has_remote(row: &ManifestRow) -> bool {
    read_remote_config(row.config.get("remote")).is_some()
}

/// The vault the remote half writes inbound content into: the repository's
/// filesystem root through the observe path. A sourceless repository has none.
fn root_of(cli: &Cli, ctx: &GitContext, verb: &str) -> Result<PathBuf> {
    match ctx.repo.root_path.as_deref() {
        Some(root) => Ok(PathBuf::from(root)),
        None => Err(CliError::usage_hint(
            format!(
                "history {verb} needs a repository with a filesystem source: inbound content is written into its root as external edits"
            ),
            format!(
                "attach one with '{} source add <dir> --repo <slug>'",
                cli.prog
            ),
        )),
    }
}

/// The remote half's own refusals (a plain error of the adapter) that the
/// CLI renders as usage errors when their text matches `patterns`; the engine
/// errors (`git_remote_diverged`, `git_merge_conflict`) render as the engine
/// errors they are (exit 1); anything else propagates.
fn remote_error(e: omgbase_sync::Error, patterns: &[&str]) -> CliError {
    match e {
        omgbase_sync::Error::Store(StoreError::Other(msg))
            if patterns.iter().any(|p| msg.contains(p)) =>
        {
            CliError::usage(msg)
        }
        other => other.into(),
    }
}

fn remote(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let sub = args.first().map(String::as_str);
    let rest: &[String] = if args.is_empty() { &[] } else { &args[1..] };
    let Some(sub) = sub.filter(|s| REMOTE_SUBCOMMANDS.contains(s)) else {
        return Err(CliError::usage_hint(
            format!(
                "history remote takes one of {}{}",
                REMOTE_SUBCOMMANDS.join("|"),
                sub.map_or_else(String::new, |s| format!(
                    " (got {})",
                    js_json(&Json::String(s.to_owned()))
                ))
            ),
            format!("run '{} history --help'", cli.prog),
        ));
    };
    match sub {
        "set" => remote_set(cli, rest),
        "unset" => remote_unset(cli, rest),
        "status" => remote_status(cli, rest),
        "resolve" => remote_resolve(cli, rest),
        _ => remote_reconcile(cli, rest),
    }
}

fn remote_set(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(
        args,
        &[
            Opt::value("url"),
            Opt::value("name"),
            Opt::value("branch"),
            Opt::value("push"),
            Opt::value("fetch"),
        ],
    )?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let Some(url) = a.value("url") else {
        return Err(CliError::usage("history remote set requires --url <url>"));
    };
    if let Some(p) = a.value("push")
        && !PUSH_POLICIES.contains(&p)
    {
        return Err(CliError::usage(format!(
            "--push must be one of {} (got {})",
            PUSH_POLICIES.join("|"),
            js_json(&Json::String(p.to_owned()))
        )));
    }
    if let Some(f) = a.value("fetch")
        && !FETCH_POLICIES.contains(&f)
    {
        return Err(CliError::usage(format!(
            "--fetch must be one of {} (got {})",
            FETCH_POLICIES.join("|"),
            js_json(&Json::String(f.to_owned()))
        )));
    }
    let options = RemoteOptions {
        url: url.to_owned(),
        name: a.value("name").map(str::to_owned),
        branch: a.value("branch").map(str::to_owned),
        push: a.value("push").map(str::to_owned),
        fetch: a.value("fetch").map(str::to_owned),
    };
    let ctx = git_context(cli, "remote set")?;
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    let config = with_writer_lock(&ctx.ws.omgbase_dir, lock, || {
        ctx.provider
            .remote_set(
                store.conn(),
                &ctx.repo.repo_id,
                &provider_config_of(&ctx.row),
                &options,
                &now,
            )
            .map_err(omgbase_sync::Error::from)
    })
    // The binding's own refusals (credentials in the URL, a bad name, branch or policy) are usage errors.
    .map_err(|e| {
        remote_error(
            e,
            &[
                "credentials",
                "not a remote name",
                "not a branch name",
                "--push",
                "--fetch",
                "--url",
            ],
        )
    })?;
    let r = config.remote.expect("set writes a binding");
    let doc = json!({ "remote": r.to_json() });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(&format!(
        "  remote {} → {} (branch {}, push {}, fetch {})",
        r.name,
        r.url,
        r.branch,
        r.push.as_str(),
        r.fetch.as_str()
    )));
    Ok(EXIT_OK)
}

fn remote_unset(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ctx = git_context(cli, "remote unset")?;
    let had = read_remote_config(ctx.row.config.get("remote")).map(|r| r.name);
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    with_writer_lock(&ctx.ws.omgbase_dir, lock, || {
        ctx.provider
            .remote_unset(
                store.conn(),
                &ctx.repo.repo_id,
                &provider_config_of(&ctx.row),
                &now,
            )
            .map_err(omgbase_sync::Error::from)
    })?;
    let doc = json!({ "remote": null });
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(&match had {
        None => "  no remote was bound".to_owned(),
        Some(name) => format!("  remote {name} unbound"),
    }));
    Ok(EXIT_OK)
}

fn render_remote_status(cli: &mut Cli, s: &RemoteStatus) -> Result<i32> {
    let doc = s.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let style = cli.style;
    let rows: Vec<Vec<String>> = vec![
        vec![style.dim("remote"), format!("{}/{}", s.remote, s.branch)],
        vec![style.dim("state"), s.state.as_str().to_owned()],
        vec![
            style.dim("local tip"),
            s.local_tip.clone().unwrap_or_else(|| "—".to_owned()),
        ],
        vec![
            style.dim("remote tip"),
            s.remote_tip.clone().unwrap_or_else(|| "—".to_owned()),
        ],
        vec![
            style.dim("pushed through"),
            s.pushed_through
                .map_or_else(|| "—".to_owned(), |n| format!("seq {n}")),
        ],
    ];
    for line in columns(&rows, &[Align::Left, Align::Left]) {
        cli.io.out(&format!("  {line}"));
    }
    Ok(EXIT_OK)
}

fn remote_status(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ctx = git_context(cli, "remote status")?;
    if !has_remote(&ctx.row) {
        return Err(no_remote(cli));
    }
    let s = ctx.provider.remote_status(
        cli.store()?.conn(),
        &ctx.repo.repo_id,
        &provider_config_of(&ctx.row),
    )?;
    render_remote_status(cli, &s)
}

fn push(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ctx = git_context(cli, "push")?;
    let Some(remote) = read_remote_config(ctx.row.config.get("remote")) else {
        return Err(no_remote(cli));
    };
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store()?;
    let r = with_writer_lock(&ctx.ws.omgbase_dir, lock, || {
        ctx.provider
            .push(
                store.conn(),
                &ctx.repo.repo_id,
                &provider_config_of(&ctx.row),
                &now,
            )
            .map_err(omgbase_sync::Error::from)
    })?;
    let doc = r.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let ids = if r.ids.as_deref() == Some("rejected") {
        " (the ids ref was rejected: the remote's identity record is another engine's)"
    } else {
        ""
    };
    let line = if r.pushed {
        format!(
            "  pushed {} to {}/{}{}{ids}",
            r.tip.as_deref().unwrap_or("none"),
            remote.name,
            remote.branch,
            through(r.pushed_through)
        )
    } else {
        format!(
            "  nothing to push ({}/{} at {}){ids}",
            remote.name,
            remote.branch,
            r.tip.as_deref().unwrap_or("none")
        )
    };
    cli.io.err(&cli.style.dim(&line));
    Ok(EXIT_OK)
}

fn render_fetch(
    cli: &mut Cli,
    remote_name: &str,
    remote_branch: &str,
    f: &FetchResult,
) -> Result<i32> {
    if f.state == FetchState::Diverged {
        // Detect, stop, alert (`spec/store` §5.12 "Divergence"): the verb itself
        // fails so the operator sees it; the alert line follows.
        let old = f.old_remote_tip.clone().flatten();
        return Err(CliError::engine_data(
            "git_remote_diverged",
            rewritten_message(
                remote_name,
                remote_branch,
                f.remote_tip.as_deref(),
                old.as_deref(),
            ),
            json!({
                "remote": remote_name,
                "branch": remote_branch,
                "local_tip": f.tip,
                "remote_tip": f.remote_tip,
                "old_remote_tip": old,
            }),
        ));
    }
    let doc = f.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let prog = cli.prog.clone();
    let line = match f.state {
        FetchState::Nothing => format!(
            "  nothing to fetch from {remote_name}/{remote_branch}{}",
            f.remote_tip
                .as_deref()
                .map_or_else(String::new, |t| format!(" (at {t})"))
        ),
        FetchState::FastForward => format!(
            "  fast-forwarded to {}: {} written into the vault",
            f.tip.as_deref().unwrap_or("none"),
            plural_s(f.applied.len(), "file")
        ),
        FetchState::Merged => format!(
            "  merged {remote_name}/{remote_branch} at {}: {} written into the vault, merge commit {}",
            f.remote_tip.as_deref().unwrap_or("none"),
            plural_s(f.applied.len(), "file"),
            f.tip.as_deref().unwrap_or("none")
        ),
        FetchState::Conflict | FetchState::Diverged => format!(
            "  {}: {} — the remote's versions are beside yours; settle each with {prog} history remote resolve <path> --ours|--theirs",
            plural_s(f.conflicts.len(), "conflict"),
            f.conflicts.join(", ")
        ),
    };
    cli.io.err(&cli.style.dim(&line));
    Ok(EXIT_OK)
}

fn fetch(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[])?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let ctx = git_context(cli, "fetch")?;
    let Some(remote) = read_remote_config(ctx.row.config.get("remote")) else {
        return Err(no_remote(cli));
    };
    let root = root_of(cli, &ctx, "fetch")?;
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store_mut()?;
    let f = with_writer_lock(&ctx.ws.omgbase_dir, lock, || {
        let config = Config::default();
        let mut vault = FsVaultSink::new(store, &ctx.repo.repo_id, &RealFileSystem, &root, &config);
        ctx.provider
            .fetch(
                &ctx.repo.repo_id,
                &provider_config_of(&ctx.row),
                &mut vault,
                &now,
            )
            .map_err(omgbase_sync::Error::from)
    })?;
    render_fetch(cli, &remote.name, &remote.branch, &f)
}

fn remote_resolve(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(args, &[Opt::flag("ours"), Opt::flag("theirs")])?;
    let Some(path) = a.pos(0) else {
        return Err(CliError::usage("history remote resolve requires a <path>"));
    };
    if a.flag("ours") == a.flag("theirs") {
        return Err(CliError::usage(
            "history remote resolve takes exactly one of --ours or --theirs",
        ));
    }
    let choice = if a.flag("ours") {
        ResolveChoice::Ours
    } else {
        ResolveChoice::Theirs
    };
    let storage = path.trim_start_matches('/').to_owned();
    let ctx = git_context(cli, "remote resolve")?;
    let root = root_of(cli, &ctx, "remote resolve")?;
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store_mut()?;
    let r: ResolveResult = with_writer_lock(&ctx.ws.omgbase_dir, lock, || {
        let config = Config::default();
        let mut vault = FsVaultSink::new(store, &ctx.repo.repo_id, &RealFileSystem, &root, &config);
        ctx.provider
            .resolve(
                &ctx.repo.repo_id,
                &provider_config_of(&ctx.row),
                &mut vault,
                &storage,
                choice,
                &now,
            )
            .map_err(omgbase_sync::Error::from)
    })
    .map_err(|e| {
        remote_error(
            e,
            &["no merge conflict is pending", "is not a pending conflict"],
        )
    })?;
    let doc = r.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(&format!(
        "  resolved {} (--{}); {} remaining{}",
        r.path,
        r.choice.as_str(),
        plural_s(r.remaining.len(), "conflict"),
        r.merged
            .as_deref()
            .map_or_else(String::new, |m| format!("; merge commit {m}"))
    )));
    Ok(EXIT_OK)
}

fn render_reconcile(cli: &mut Cli, r: &ReconcileResult) -> Result<i32> {
    let doc = r.to_json();
    if let Some(code) = machine_out(cli, &doc, None, None) {
        return code;
    }
    let prog = cli.prog.clone();
    let conflicts = if r.conflicts.is_empty() {
        String::new()
    } else {
        format!(
            "; {}: {} (settle each with {prog} history remote resolve <path> --ours|--theirs)",
            plural_s(r.conflicts.len(), "conflict"),
            r.conflicts.join(", ")
        )
    };
    let applied = format!(
        "{} written into the vault",
        plural_s(r.applied.len(), "file")
    );
    let tip = r.tip.as_deref().unwrap_or("none");
    let line = match r.mode {
        ReconcileMode::Rebase => format!(
            "  rebased {} onto the remote's head, tip {tip}; the previous tip is kept on refs/omgbase/backup; {applied}{conflicts}",
            plural_s(r.rewritten, "commit")
        ),
        ReconcileMode::Merge if r.rewritten == 1 => format!(
            "  merged the remote's head: merge commit {tip}; the previous tip is kept on refs/omgbase/backup; {applied}"
        ),
        ReconcileMode::Merge => format!("  merge pending: {applied}{conflicts}"),
        ReconcileMode::Adopt => format!(
            "  adopted the remote's head {tip}; the previous tip is kept on refs/omgbase/backup; {applied}{conflicts}"
        ),
        ReconcileMode::Fork => format!(
            "  pushed the engine's branch as {}; merge it with git, then run {prog} history remote reconcile --adopt",
            r.fork.as_deref().unwrap_or("")
        ),
    };
    cli.io.err(&cli.style.dim(&line));
    Ok(EXIT_OK)
}

fn remote_reconcile(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let a = parse_args(
        args,
        &[
            Opt::flag("rebase"),
            Opt::flag("merge"),
            Opt::flag("adopt"),
            Opt::flag("fork"),
        ],
    )?;
    if let Some(p) = a.pos(0) {
        return Err(CliError::usage(format!("unexpected argument '{p}'")));
    }
    let modes: Vec<&str> = RECONCILE_MODES
        .iter()
        .copied()
        .filter(|m| a.flag(m))
        .collect();
    let [mode] = modes.as_slice() else {
        return Err(CliError::usage(format!(
            "history remote reconcile takes exactly one of {}",
            RECONCILE_MODES
                .iter()
                .map(|m| format!("--{m}"))
                .collect::<Vec<_>>()
                .join(" | ")
        )));
    };
    let mode = ReconcileMode::parse(mode).expect("one of the four");
    let ctx = git_context(cli, "remote reconcile")?;
    let root = root_of(cli, &ctx, "remote reconcile")?;
    let now = cli.now();
    let lock = cli.seams.lock_options();
    let store = cli.store_mut()?;
    let r: ReconcileResult = with_writer_lock(&ctx.ws.omgbase_dir, lock, || {
        let config = Config::default();
        let mut vault = FsVaultSink::new(store, &ctx.repo.repo_id, &RealFileSystem, &root, &config);
        ctx.provider
            .reconcile(
                &ctx.repo.repo_id,
                &provider_config_of(&ctx.row),
                &mut vault,
                mode,
                &now,
            )
            .map_err(omgbase_sync::Error::from)
    })
    .map_err(|e| remote_error(e, &["is not diverged", "no remote is bound"]))?;
    render_reconcile(cli, &r)
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
