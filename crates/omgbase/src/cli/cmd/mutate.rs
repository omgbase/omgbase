//! The block mutators (`spec/cli` §6, cli 4.0): `apply` (the primitive — a
//! list of effects `{ effects }`, ADR-021, planned and executed in one
//! transaction), `execute` (a frozen plan), `insert`, `update` (a `b_` target
//! is a block update with CAS; anything else the whole-document update),
//! `edit`, `move`, `rm` (blocks, or `--doc`), `done`, `append`, `split`,
//! `merge`. Each is a thin client: it parses argv, reads its content source
//! (`-m` / `-f` / `-` / stdin), resolves its refs to block ids, and hands the
//! catalog tool the same arguments the MCP server would receive; the result
//! — the Receipt (`spec/surface` §4, 4.0) — is rendered once here: the commit
//! confirmation with the ids the plan's preview names (§4), or the `--json`
//! document. The global `--dry-run` is a **plan** (§3.6): locally the tool's
//! preview through the surface's seam, remotely the `plan` tool over the
//! effects the verb builds with the shared builders (`omgbase_store::sugar`)
//! from its refs as given — nothing written, no id minted.

use std::process::{Command, Stdio};

use omgbase_store::mutate_kernel::At;
use omgbase_store::mutate_kernel::effects::{EffectExpect, Target as EffectTarget};
use omgbase_store::{PublicEffect, is_id_ref, sugar};
use omgbase_surface::history::unified_diff;
use omgbase_surface::read::{ResolvedRef, resolve_ref};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, expand_dash, parse_args, read_stdin};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::{doc_locator, machine_out, str_of};

// ---- content sources (§2.2, §6) ------------------------------------------------------

/// `-m`/`-f` pulled out of argv before the option parser sees them, so a
/// value starting with `-` (`-m '- [ ] task'`) is taken verbatim.
#[derive(Debug)]
pub struct Content {
    pub message: Option<String>,
    pub file: Option<String>,
    pub rest: Vec<String>,
}

/// Extract `-m/--message` and `-f/--file` (and their `=` forms); everything
/// from a literal `--` on is left for the command's parser.
pub fn extract_content_opts(args: &[String]) -> Result<Content> {
    let mut out = Content {
        message: None,
        file: None,
        rest: Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        i += 1;
        if a == "--" {
            out.rest.push(a.to_owned());
            out.rest.extend(args[i..].iter().cloned());
            break;
        }
        match a {
            "-m" | "--message" | "-f" | "--file" => {
                let Some(v) = args.get(i) else {
                    return Err(CliError::usage(format!("{a} requires a value")));
                };
                i += 1;
                if a.starts_with("-m") || a == "--message" {
                    out.message = Some(v.clone());
                } else {
                    out.file = Some(v.clone());
                }
            }
            _ => {
                if let Some(v) = a
                    .strip_prefix("-m=")
                    .or_else(|| a.strip_prefix("--message="))
                {
                    out.message = Some(v.to_owned());
                } else if let Some(v) = a.strip_prefix("-f=").or_else(|| a.strip_prefix("--file="))
                {
                    out.file = Some(v.to_owned());
                } else {
                    out.rest.push(a.to_owned());
                }
            }
        }
    }
    Ok(out)
}

/// The content: `-m` verbatim; `-f <file>` (or `-f -` for stdin); else stdin.
pub fn read_content(c: &Content) -> Result<String> {
    if let Some(m) = &c.message {
        return Ok(m.clone());
    }
    match c.file.as_deref() {
        Some("-") => Ok(read_stdin()),
        Some(f) => Ok(std::fs::read_to_string(f)?),
        None => Ok(read_stdin()),
    }
}

// ---- shared plumbing (§3.6, §3.7, §4) -------------------------------------------------

/// `human:<os username>` (§3.7), the actor of every CLI write without `--actor`.
pub fn default_actor() -> String {
    let name = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(passwd_name)
        .unwrap_or_else(|| "unknown".to_owned());
    format!("human:{name}")
}

/// The login name of the effective user from the passwd database.
fn passwd_name() -> Option<String> {
    // SAFETY: `getpwuid` returns a pointer to static storage (or null); the
    // entry's `pw_name` is a NUL-terminated string valid until the next call.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_name.is_null() {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr((*pw).pw_name)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

/// Stamp the writes that follow with `--actor`, else the default. Remotely
/// (§2.3) the write tools take no actor — the engine stamps its own
/// (`agent:mcp`), so `--actor` has no effect, as in the reference.
pub fn set_actor(cli: &mut Cli, actor: Option<&str>) -> Result<()> {
    if cli.remote_mode() {
        return Ok(());
    }
    let actor = actor.map_or_else(default_actor, str::to_owned);
    cli.surface(false)?.set_actor(&actor);
    Ok(())
}

/// A ref that must name a live block: its id, else `block_missing: no block with id "<ref>"`
/// (its `data` spells the row attribute: `{ _id }`, spec/surface §4, 5.0).
pub fn block_id(cli: &mut Cli, r: &str) -> Result<String> {
    let repo = cli.repo()?;
    match resolve_ref(cli.store()?.conn(), &repo.repo_id, r)? {
        Some(ResolvedRef::Block { block_id, .. }) => Ok(block_id),
        _ => Err(CliError::engine_data(
            "block_missing",
            format!("no block with id {}", Json::String(r.to_owned())),
            json!({ "_id": r }),
        )),
    }
}

/// A block argument for a ref-accepting tool: remotely (§2.3) the ref as
/// given — the `blocks_*` / `blocks_check` / `blocks_append` tools
/// resolve refs and pin CAS server-side; locally its resolved block id.
pub fn block_arg(cli: &mut Cli, r: &str) -> Result<String> {
    if cli.remote_mode() {
        return Ok(r.to_owned());
    }
    block_id(cli, r)
}

/// A block ref resolved to (doc id, block id).
fn block_ref(cli: &mut Cli, r: &str) -> Result<(String, String)> {
    let repo = cli.repo()?;
    match resolve_ref(cli.store()?.conn(), &repo.repo_id, r)? {
        Some(ResolvedRef::Block { doc_id, block_id }) => Ok((doc_id, block_id)),
        _ => Err(CliError::engine_data(
            "block_missing",
            format!("no block with id {}", Json::String(r.to_owned())),
            json!({ "_id": r }),
        )),
    }
}

/// `--at`: `end` (default) | `start` | `before <id>` | `after <id>`, as the
/// tools' `at` argument.
pub fn parse_at(at: Option<&str>) -> Result<Json> {
    let at = at.map(str::trim).unwrap_or("");
    if at.is_empty() || at == "end" {
        return Ok(json!("end"));
    }
    if at == "start" {
        return Ok(json!("start"));
    }
    for (word, key) in [("before", "before"), ("after", "after")] {
        if let Some(rest) = at.strip_prefix(word) {
            let anchor = rest.trim_start();
            if rest.starts_with(char::is_whitespace) && !anchor.is_empty() {
                return Ok(json!({ key: anchor }));
            }
        }
    }
    Err(CliError::usage(format!(
        "bad --at '{at}' (use end|start|before <id>|after <id>)"
    )))
}

/// The tools' `at` argument as the effect placement (for a remote `plan`).
pub fn at_of(at: &Json) -> At {
    match at {
        Json::String(s) if s == "start" => At::Start,
        Json::Object(o) if o.get("before").is_some() => At::Before(str_of(at, "before")),
        Json::Object(o) if o.get("after").is_some() => At::After(str_of(at, "after")),
        _ => At::End,
    }
}

/// The block ref an `at` anchor names (none for start/end) — a ref the
/// remote fallback must be able to send as an id.
pub fn anchor_of(at: &Json) -> Vec<String> {
    match at {
        Json::Object(o) => o
            .get("before")
            .or_else(|| o.get("after"))
            .and_then(Json::as_str)
            .map(|s| vec![s.to_owned()])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// A ref as an effect target for a remote `plan` (§3.6; spec/mutate §11, 4.0:
/// the address is the row's engine attribute): a `b_` id is the block
/// (`_id`), a `d_` id the document (`_id`), anything else a document path
/// (`_path`) — the engine resolves (the reference's `targetOf`).
pub fn target_of(r: &str) -> EffectTarget {
    if is_id_ref(r, "b") {
        return EffectTarget::Block { id: r.to_owned() };
    }
    if is_id_ref(r, "d") {
        return EffectTarget::Document {
            id: Some(r.to_owned()),
            path: None,
        };
    }
    EffectTarget::Document {
        id: None,
        path: Some(r.to_owned()),
    }
}

/// The builders' effects as the `plan` tool's `effects` argument.
pub fn effects_json(effects: &[PublicEffect]) -> Json {
    Json::Array(effects.iter().map(PublicEffect::to_json).collect())
}

/// `--expect <content_hash>` as an effect guard.
pub fn content_guard(hash: Option<&str>) -> Option<EffectExpect> {
    hash.map(|h| EffectExpect {
        content_hash: Some(h.to_owned()),
        parent_children_hash: None,
        revision: None,
    })
}

/// `--expect <parent_children_hash>` as an effect guard.
pub fn parent_guard(hash: Option<&str>) -> Option<EffectExpect> {
    hash.map(|h| EffectExpect {
        content_hash: None,
        parent_children_hash: Some(h.to_owned()),
        revision: None,
    })
}

/// The lines of `unified_diff(before, after)` (§3.6; an empty diff is one empty line).
pub fn unified_diff_lines(before: &str, after: &str) -> Vec<String> {
    unified_diff(before, after)
        .split('\n')
        .map(str::to_owned)
        .collect()
}

/// §3.6: the dry-run note on stderr, then per changed file its path, the
/// unified diff of before → after and an empty line on stdout.
pub fn render_diffs(cli: &Cli, diffs: Option<&Json>) {
    let empty = Map::new();
    let diffs = diffs.and_then(Json::as_object).unwrap_or(&empty);
    cli.io.err(&cli.style.dim(&format!(
        "  dry run — {} file(s) would change, nothing committed",
        diffs.len()
    )));
    for (path, d) in diffs {
        cli.io.out(&cli.style.bold(path));
        for line in unified_diff_lines(&str_of(d, "before"), &str_of(d, "after")) {
            let styled = if line.starts_with('+') {
                cli.style.ok(&line)
            } else if line.starts_with('-') {
                cli.style.err(&line)
            } else {
                cli.style.dim(&line)
            };
            cli.io.out(&styled);
        }
        cli.io.out("");
    }
}

/// Run one sugar tool with the actor and render the outcome (§4): the
/// Receipt confirmation with the ids the plan's preview names, or the
/// `--json` document as the tool returned it. `refs` are the block refs the
/// verb received (a parent, an anchor, the blocks), for the remote fallback's
/// locator check. With the global `--dry-run`
/// the verb's preview is a plan (§3.6): locally the tool's own
/// ([`Cli::preview`]), remotely the `plan` tool over `effects` — the effects
/// the verb builds from its refs as given, computed only then. A sourceless
/// repo is the tool's `repo_not_found` (`repo has no filesystem source;
/// mutation disabled`, `sync::sourceless`), locally and remotely alike.
pub fn run_tool(
    cli: &mut Cli,
    tool: &str,
    args: Map<String, Json>,
    actor: Option<&str>,
    refs: Vec<String>,
    effects: impl FnOnce(&mut Cli) -> Result<Vec<PublicEffect>>,
) -> Result<i32> {
    set_actor(cli, actor)?;
    if cli.flags.dry_run {
        let effects = if cli.remote_mode() {
            effects_json(&effects(cli)?)
        } else {
            Json::Null
        };
        let plan = cli.preview(tool, Json::Object(args), effects)?;
        return render_plan(cli, plan);
    }
    if cli.remote_mode() {
        // §2.3 (cli 4.2): the tool when the engine lists it, else `apply`
        // over the same effects (`refs` are the verb's refs as given, refused
        // there when one is a locator) — the engine keeps its plan either way.
        let result = cli.remote_sugar(tool, Json::Object(args), &refs, |cli| {
            Ok(effects_json(&effects(cli)?))
        })?;
        return render_receipt(cli, result, None);
    }
    let (result, plan) = cli.call_with_plan(tool, Json::Object(args))?;
    render_receipt(cli, result, plan.as_ref())
}

const ACTOR: Opt = Opt::value("actor");

// ---- apply ----------------------------------------------------------------------------

/// `apply -f`: a changeset `{ effects: [...] }` (`spec/mutate` §11; planned
/// and executed in one transaction by the `apply` tool). A dry run prints the
/// Plan (`--json`) or its preview's diffs, a commit the Receipt (`--json`)
/// or the confirmation with the ids the plan names. The kernel changeset
/// `{ ops }` of 3.x is refused by name (§6 `apply`, 4.0).
pub fn apply(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "apply");
    }
    let a = parse_args(
        args,
        &[Opt::value_short("f", 'f'), Opt::value("reason"), ACTOR],
    )?;
    let raw = match a.value("f") {
        None | Some("-") => read_stdin(),
        Some(f) => std::fs::read_to_string(f)?,
    };
    let parsed: Json = serde_json::from_str(&raw)
        .map_err(|e| CliError::usage(format!("changeset is not JSON: {e}")))?;
    if parsed.get("ops").is_some() {
        return Err(CliError::usage(
            "`ops` is no longer an input — apply takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0)",
        ));
    }
    let Some(effects) = parsed.get("effects") else {
        return Err(CliError::usage("changeset must have an `effects` array"));
    };
    let Some(effects) = effects.as_array() else {
        return Err(CliError::usage("changeset `effects` must be an array"));
    };
    if effects.is_empty() {
        cli.io.err(&cli.style.dim("  nothing to do"));
        return Ok(EXIT_OK);
    }
    let mut m = Map::new();
    m.insert("effects".to_owned(), Json::Array(effects.clone()));
    if let Some(r) = a.value("reason") {
        m.insert("reason".to_owned(), json!(r));
    }
    set_actor(cli, a.value("actor"))?;
    if cli.flags.dry_run {
        let plan = cli.preview("apply", Json::Object(m), Json::Array(effects.clone()))?;
        return render_plan(cli, plan);
    }
    let (receipt, plan) = cli.call_with_plan("apply", Json::Object(m))?;
    render_receipt(cli, receipt, plan.as_ref())
}

/// A Plan, dry-run style: `--json` the Plan verbatim (what `execute` takes
/// back); human the §3.6 note and the per-file diffs of its preview.
pub fn render_plan(cli: &mut Cli, plan: Json) -> Result<i32> {
    cli.capture(&plan);
    if let Some(code) = machine_out(cli, &plan, None, None) {
        return code;
    }
    render_diffs(cli, plan.get("preview").and_then(|p| p.get("diffs")));
    Ok(EXIT_OK)
}

/// A Receipt (the tool's result verbatim — `links_retarget` adds its `hits`
/// and `pairs`): `--json` as it came; human the commit confirmation of §4 (one
/// revision per touched document) and, on stdout, the ids the write names —
/// the plan's `preview.results[].ids` with every `$new.n` realized from
/// `new_ids` when the plan is at hand with its preview (a local `apply`, any
/// `execute`), exactly the ids the `ops` form prints; else (a plan echoed
/// without `preview`, a remote `apply`) every id the plan minted, the
/// `new_ids` values in order — which includes the discarded mints of a
/// re-parse (`spec/mutate` §10), ids that name no row.
pub fn render_receipt(cli: &mut Cli, receipt: Json, plan: Option<&Json>) -> Result<i32> {
    let ids = receipt_ids(&receipt, plan);
    capture_receipt(cli, &receipt, &ids);
    if let Some(code) = machine_out(cli, &receipt, None, None) {
        return code;
    }
    let n = receipt
        .get("revisions")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    cli.io.err(&cli.style.dim(&format!(
        "  {} committed · {n} document{} touched",
        cli.style.ok(cli.style.glyphs().ok),
        if n == 1 { "" } else { "s" }
    )));
    render_summary(cli, &receipt);
    for id in ids {
        cli.io.out(&id);
    }
    Ok(EXIT_OK)
}

/// The Receipt's `summary` (`spec/cli` §4, cli 4.3): what was committed, in
/// words — one line per effect, indented under the confirmation, on stderr.
pub fn render_summary(cli: &mut Cli, receipt: &Json) {
    let lines = receipt
        .get("summary")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for line in lines {
        cli.io.err(&cli.style.dim(&format!("    {line}")));
    }
}

/// The shell's frame for a write (`spec/cli` §7): the Receipt with the ids
/// the write names as `ids` (the reference captures `{ ...receipt, ids }`).
fn capture_receipt(cli: &mut Cli, receipt: &Json, ids: &[String]) {
    let mut framed = receipt.clone();
    if let Some(o) = framed.as_object_mut() {
        o.insert("ids".to_owned(), json!(ids));
    }
    cli.capture(&framed);
}

/// See [`render_receipt`]: the preview's ids realized, else `new_ids` values.
fn receipt_ids(receipt: &Json, plan: Option<&Json>) -> Vec<String> {
    let new_ids = receipt.get("new_ids").and_then(Json::as_object);
    let Some(results) = plan
        .and_then(|p| p.get("preview"))
        .and_then(|p| p.get("results"))
        .and_then(Json::as_array)
    else {
        return new_ids
            .into_iter()
            .flat_map(|m| m.values())
            .filter_map(Json::as_str)
            .map(str::to_owned)
            .collect();
    };
    results
        .iter()
        .filter_map(|r| r.get("ids").and_then(Json::as_array))
        .flatten()
        .filter_map(Json::as_str)
        .map(|id| {
            new_ids
                .and_then(|m| m.get(id))
                .and_then(Json::as_str)
                .unwrap_or(id)
                .to_owned()
        })
        .collect()
}

// ---- execute --------------------------------------------------------------------------

/// `execute (-f <plan.json> | -)`: a frozen plan (the `--json` of `apply
/// --dry-run` with effects) handed to the `execute` tool, which admits it
/// (`version`, shape, `plan_id`), re-validates its preconditions
/// (`stale_plan`) and commits exactly what was planned. Rendered as a
/// Receipt. The plan IS the preview, so `--dry-run` is a usage error.
pub fn execute(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "execute");
    }
    let a = parse_args(
        args,
        &[Opt::value_short("f", 'f'), Opt::value("reason"), ACTOR],
    )?;
    if cli.flags.dry_run {
        return Err(CliError::usage(
            "execute has no dry run — the plan is the preview (re-plan with apply --dry-run)",
        ));
    }
    let source = a
        .value("f")
        .or_else(|| a.pos(0).filter(|p| *p == "-"))
        .ok_or_else(|| CliError::usage("execute requires -f <plan.json> (or - for stdin)"))?;
    let raw = match source {
        "-" => read_stdin(),
        f => std::fs::read_to_string(f)?,
    };
    let plan: Json = serde_json::from_str(&raw)
        .map_err(|e| CliError::usage(format!("plan is not JSON: {e}")))?;
    let mut m = Map::new();
    m.insert("plan".to_owned(), plan.clone());
    if let Some(r) = a.value("reason") {
        m.insert("reason".to_owned(), json!(r));
    }
    set_actor(cli, a.value("actor"))?;
    let result = cli.call("execute", Json::Object(m))?;
    render_receipt(cli, result, Some(&plan))
}

// ---- insert ---------------------------------------------------------------------------

pub fn insert(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "insert");
    }
    let content = extract_content_opts(args)?;
    let a = parse_args(
        &content.rest,
        &[Opt::value("at"), Opt::value("expect"), ACTOR],
    )?;
    let Some(to) = a.pos(0) else {
        return Err(CliError::usage(
            "insert requires a <to> parent (a container block id, or a doc id/path for the top level)",
        ));
    };
    let to = to.to_owned();
    let markdown = read_content(&content)?;
    let at = parse_at(a.value("at"))?;
    let parent = block_arg(cli, &to)?;
    let mut m = Map::new();
    m.insert("to".to_owned(), json!(parent));
    m.insert("markdown".to_owned(), json!(markdown));
    m.insert("at".to_owned(), at.clone());
    if let Some(e) = a.value("expect") {
        m.insert("expect".to_owned(), json!({ "parent_children_hash": e }));
    }
    let expect = parent_guard(a.value("expect"));
    let mut refs = vec![to];
    refs.extend(anchor_of(&at));
    run_tool(cli, "blocks_insert", m, a.value("actor"), refs, move |_| {
        Ok(sugar::insert(
            target_of(&parent),
            at_of(&at),
            &markdown,
            expect,
        ))
    })
}

// ---- update (block or document) -------------------------------------------------------

pub fn update(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "update");
    }
    // A `b_` token is the block path (§9 Fixed: never a document lookup);
    // anything else is the whole-document update.
    let peek = extract_content_opts(args)?;
    let target = peek.rest.iter().find(|a| !a.starts_with('-'));
    if target.is_some_and(|t| t.starts_with("b_")) {
        update_block(cli, args)
    } else {
        update_doc(cli, args)
    }
}

fn update_block(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let content = extract_content_opts(args)?;
    let a = parse_args(&content.rest, &[Opt::value("expect"), ACTOR])?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("update requires a <block>"));
    };
    let r = r.to_owned();
    let markdown = read_content(&content)?;
    let block = block_arg(cli, &r)?;
    let mut m = Map::new();
    m.insert("_id".to_owned(), json!(block));
    m.insert("markdown".to_owned(), json!(markdown));
    match a.value("expect") {
        Some(e) => {
            m.insert("expect".to_owned(), json!({ "content_hash": e }));
        }
        // §5.7: the tool pins the CAS from the live row when `expect` is
        // absent. The notice is the local path's: the reference's remote
        // branch returns before it (the server pins silently).
        None if cli.remote_mode() => {}
        None => {
            cli.io.err(
                &cli.style
                    .dim(&format!("  updating {r} (CAS pinned from current bytes)")),
            );
        }
    }
    let expect = content_guard(a.value("expect"));
    run_tool(
        cli,
        "blocks_update",
        m,
        a.value("actor"),
        vec![r],
        move |_| Ok(sugar::update_block(&block, Some(&markdown), None, expect)),
    )
}

fn update_doc(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let content = extract_content_opts(args)?;
    let a = parse_args(&content.rest, &[ACTOR, Opt::value("reason")])?;
    let Some(doc) = a.pos(0) else {
        return Err(CliError::usage("update requires a <doc> (id or path)"));
    };
    let doc = doc.to_owned();
    let bytes = read_content(&content)?;
    // §2.3: remotely the engine reconciles and commits server-side; the
    // working-tree check is the engine's.
    if !cli.remote_mode() {
        let repo = cli.repo()?;
        if repo.root_path.is_none() {
            return Err(CliError::usage(format!(
                "repo '{}' has no filesystem source; 'update' needs a working tree",
                repo.slug
            )));
        }
    }
    set_actor(cli, a.value("actor"))?;
    // cli 4.0: the whole-document update is `set { document, field: "content" }`
    // — `--dry-run` is the `plan` (its `preview.identity` is the opset's
    // identity decision), a commit the `docs_update` sugar's Receipt.
    if cli.remote_mode() {
        // The engine resolves the locator: the `plan` tool over the effect on
        // a dry run; else the `docs_update` tool, which commits the `set
        // content` server-side and returns the Receipt (the confirmation
        // lists the ids it minted).
        let mut m = Map::new();
        doc_locator(&mut m, &doc);
        if cli.flags.dry_run {
            let mut target = m;
            target.insert("kind".to_owned(), json!("document"));
            let effect = json!({
                "op": "set",
                "target": Json::Object(target),
                "field": "content",
                "value": bytes,
            });
            let plan = cli.call("plan", json!({ "effects": [effect], "diffs": true }))?;
            return render_update_plan(cli, plan);
        }
        let mut target = m.clone();
        target.insert("kind".to_owned(), json!("document"));
        m.insert("content".to_owned(), json!(bytes.clone()));
        if let Some(r) = a.value("reason") {
            m.insert("reason".to_owned(), json!(r));
        }
        // The `docs_update` tool when the engine lists it, else `apply` over
        // the one `set content` effect (§2.3, cli 4.2).
        let receipt = cli.remote_sugar("docs_update", Json::Object(m), &[], |_| {
            Ok(json!([{
                "op": "set",
                "target": Json::Object(target),
                "field": "content",
                "value": bytes,
            }]))
        })?;
        return render_update_receipt(cli, receipt, None);
    }
    // Locally the document is resolved first (the reference's `requireDoc`:
    // a miss is `doc_missing` "no document with id or path …" naming the
    // locator — the verbs' wording, not the tools' "_id or _path") and the
    // plan is at hand (`applyEffectsDetailed`), so the confirmation lists
    // every id the plan's results name, once each.
    let (id, _) = super::docs::doc_identity(cli, &doc)?;
    let effect = json!({
        "op": "set",
        "target": { "kind": "document", "_id": id },
        "field": "content",
        "value": bytes,
    });
    if cli.flags.dry_run {
        let plan = cli.call("plan", json!({ "effects": [effect], "diffs": true }))?;
        return render_update_plan(cli, plan);
    }
    let mut m = Map::new();
    m.insert("effects".to_owned(), json!([effect]));
    if let Some(r) = a.value("reason") {
        m.insert("reason".to_owned(), json!(r));
    }
    let (receipt, plan) = cli.call_with_plan("apply", Json::Object(m))?;
    render_update_receipt(cli, receipt, plan.as_ref())
}

/// `update <doc>`'s commit: the Receipt (`--json` verbatim), the §4
/// confirmation, and every id the write names ONCE each (a block appears in
/// several ops' results — an update then a retile of the same block).
fn render_update_receipt(cli: &mut Cli, receipt: Json, plan: Option<&Json>) -> Result<i32> {
    let mut ids: Vec<String> = Vec::new();
    for id in receipt_ids(&receipt, plan) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    capture_receipt(cli, &receipt, &ids);
    if let Some(code) = machine_out(cli, &receipt, None, None) {
        return code;
    }
    let n = receipt
        .get("revisions")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    cli.io.err(&cli.style.dim(&format!(
        "  {} committed · {n} document{} touched",
        cli.style.ok(cli.style.glyphs().ok),
        if n == 1 { "" } else { "s" }
    )));
    render_summary(cli, &receipt);
    for id in ids {
        cli.io.out(&id);
    }
    Ok(EXIT_OK)
}

/// `update <doc> --dry-run`: `--json` the Plan verbatim; human `  plan for
/// <path>` on stderr and, on stdout, the reconciliation lines rebuilt from
/// `preview.identity` — one per planned op (`VERB subject disposition
/// ~confidence [reason]`), a blank line, the summary counts.
fn render_update_plan(cli: &mut Cli, plan: Json) -> Result<i32> {
    cli.capture(&plan);
    if let Some(code) = machine_out(cli, &plan, None, None) {
        return code;
    }
    let path = update_plan_path(&plan);
    cli.io.err(
        &cli.style
            .dim(&format!("  plan for {}", cli.style.accent(&path))),
    );
    let identity = plan
        .get("preview")
        .and_then(|p| p.get("identity"))
        .and_then(Json::as_object)
        .and_then(|m| m.values().next());
    if let Some(identity) = identity {
        cli.io.out(&render_identity_plan(identity));
    }
    Ok(EXIT_OK)
}

/// The document an `update` plan addresses, rooted: the preview's revision
/// (`_path`) when the plan touches it, else the effect's resolved target's
/// `_path` (a content already current loads nothing; spec/mutate §11, 4.0).
fn update_plan_path(plan: &Json) -> String {
    if let Some(p) = plan
        .get("preview")
        .and_then(|p| p.get("revisions"))
        .and_then(Json::as_array)
        .and_then(|r| r.first())
        .and_then(|r| r.get("_path"))
        .and_then(Json::as_str)
    {
        return p.to_owned();
    }
    let path = plan
        .get("effects")
        .and_then(Json::as_array)
        .and_then(|e| e.first())
        .and_then(|e| e.get("target"))
        .and_then(|t| t.get("_path"))
        .and_then(Json::as_str)
        .unwrap_or_default();
    if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    }
}

/// The verb column of a plan line, by disposition.
fn disposition_verb(d: &str) -> &'static str {
    match d {
        "same" => "KEEP  ",
        "edited" | "edited_moved" => "UPDATE",
        "moved" => "MOVE  ",
        "inserted" => "INSERT",
        "deleted" => "REMOVE",
        "split_from" => "SPLIT ",
        "merged_into" => "MERGE ",
        "copied_from" => "COPY  ",
        "resurrected" => "RESURR",
        "bulk_rewrite" => "REWRITE",
        _ => "RETILE",
    }
}

/// The one-line-per-op plan text over a `preview.identity[<doc>]` entry.
fn render_identity_plan(identity: &Json) -> String {
    let mut lines = Vec::new();
    for op in identity
        .get("ops")
        .and_then(Json::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let disposition = op.get("disposition").and_then(Json::as_str).unwrap_or("");
        let subject = op
            .get("blocks")
            .and_then(Json::as_array)
            .and_then(|b| b.first())
            .and_then(Json::as_str)
            .unwrap_or("(new)");
        let conf = op
            .get("confidence")
            .and_then(Json::as_f64)
            .map_or(String::new(), |c| format!(" ~{c:.2}"));
        let why = op
            .get("reason")
            .and_then(Json::as_str)
            .map_or(String::new(), |r| format!(" [{r}]"));
        lines.push(format!(
            "{} {:<9} {disposition}{conf}{why}",
            disposition_verb(disposition),
            subject
        ));
    }
    let summary = identity.get("summary").cloned().unwrap_or(Json::Null);
    let count = |k: &str| summary.get(k).and_then(Json::as_i64).unwrap_or(0);
    lines.push(String::new());
    lines.push(format!(
        "preserved: {}  updated: {}  moved: {}  created: {}  removed: {}  split: {}  merged: {}  ambiguous: {}",
        count("preserved"),
        count("updated"),
        count("moved"),
        count("created"),
        count("removed"),
        count("split"),
        count("merged"),
        count("ambiguous"),
    ));
    lines.join("\n")
}

// ---- edit -----------------------------------------------------------------------------

pub fn edit(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "edit");
    }
    let a = parse_args(args, &[ACTOR])?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("edit requires a <block>"));
    };
    let r = r.to_owned();
    let (_, block) = block_ref(cli, &r)?;
    let node = cli.call("blocks_read", json!({ "_id": block, "resolution": "raw" }))?;
    let before = str_of(&node, "_raw");
    // Pin the CAS BEFORE the editor opens.
    let pre_hash = node
        .get("_hash")
        .and_then(Json::as_str)
        .filter(|h| !h.is_empty())
        .map(str::to_owned);

    let omg_editor = std::env::var("OMG_EDITOR").ok().filter(|e| !e.is_empty());
    let editor = omg_editor
        .clone()
        .or_else(|| std::env::var("VISUAL").ok().filter(|e| !e.is_empty()))
        .or_else(|| std::env::var("EDITOR").ok().filter(|e| !e.is_empty()));
    let Some(editor) = editor else {
        return Err(CliError::engine(
            "target_missing",
            "no $EDITOR set (or $VISUAL/$OMG_EDITOR)",
        ));
    };
    if !cli.io.stdout_tty() && omg_editor.is_none() {
        return Err(CliError::engine(
            "target_missing",
            "edit needs a TTY; set OMG_EDITOR to a non-interactive editor for scripts",
        ));
    }

    let dir = std::env::temp_dir().join(format!(
        "omg-edit-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("block.md");
    let outcome = (|| -> Result<Option<String>> {
        std::fs::write(&file, &before)?;
        let mut words = editor.split_whitespace();
        let cmd = words.next().unwrap_or_default();
        let status = Command::new(cmd)
            .args(words)
            .arg(&file)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                let code = s
                    .code()
                    .map_or_else(|| "abnormally".to_owned(), |c| c.to_string());
                return Err(CliError::engine(
                    "target_missing",
                    format!("editor exited {code}"),
                ));
            }
            Err(_) => {
                return Err(CliError::engine(
                    "target_missing",
                    "editor exited abnormally",
                ));
            }
        }
        let after = std::fs::read_to_string(&file)?;
        Ok((after != before).then_some(after))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    let Some(after) = outcome? else {
        cli.io.err(&cli.style.dim("  no changes"));
        return Ok(EXIT_OK);
    };
    // `set markdown` with the PRE-READ hash as `expect.content_hash` (the
    // `blocks_update` builder; cli 4.0): a mid-edit change by someone else is
    // a clean `stale_expectation`, never a lost write.
    let mut m = Map::new();
    m.insert("_id".to_owned(), json!(block));
    m.insert("markdown".to_owned(), json!(after));
    if let Some(h) = &pre_hash {
        m.insert("expect".to_owned(), json!({ "content_hash": h }));
    }
    let expect = content_guard(pre_hash.as_deref());
    run_tool(
        cli,
        "blocks_update",
        m,
        a.value("actor"),
        vec![r],
        move |_| Ok(sugar::update_block(&block, Some(&after), None, expect)),
    )
}

// ---- move -----------------------------------------------------------------------------

pub fn r#move(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "move");
    }
    let a = parse_args(
        args,
        &[
            Opt::value("to"),
            Opt::value("at"),
            Opt::value("expect"),
            ACTOR,
        ],
    )?;
    let Some(to) = a.value("to").filter(|t| !t.is_empty()) else {
        return Err(CliError::usage("move requires --to <parent>"));
    };
    let to = to.to_owned();
    let refs = expand_dash(&a.positionals);
    if refs.is_empty() {
        return Err(CliError::usage(
            "move requires one or more blocks (or - for stdin)",
        ));
    }
    let at = parse_at(a.value("at"))?;
    let blocks = resolve_blocks(cli, &refs)?;
    let parent = block_arg(cli, &to)?;
    let mut m = Map::new();
    m.insert("blocks".to_owned(), json!(blocks));
    m.insert("to".to_owned(), json!(parent));
    m.insert("at".to_owned(), at.clone());
    if let Some(e) = a.value("expect") {
        m.insert("expect".to_owned(), json!({ "parent_children_hash": e }));
    }
    let expect = parent_guard(a.value("expect"));
    let mut all_refs = refs;
    all_refs.push(to);
    all_refs.extend(anchor_of(&at));
    run_tool(
        cli,
        "blocks_move",
        m,
        a.value("actor"),
        all_refs,
        move |_| {
            Ok(sugar::move_blocks(
                blocks,
                target_of(&parent),
                at_of(&at),
                expect,
            ))
        },
    )
}

/// Every ref as the tool's `blocks[]` argument (see [`block_arg`]).
fn resolve_blocks(cli: &mut Cli, refs: &[String]) -> Result<Vec<String>> {
    refs.iter().map(|r| block_arg(cli, r)).collect()
}

// ---- rm -------------------------------------------------------------------------------

pub fn rm(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "rm");
    }
    let a = parse_args(args, &[Opt::value("doc"), ACTOR])?;
    if let Some(doc) = a.value("doc") {
        return rm_doc(cli, doc, a.value("actor"));
    }
    let refs = expand_dash(&a.positionals);
    if refs.is_empty() {
        return Err(CliError::usage(
            "rm requires one or more blocks (or - for stdin), or --doc",
        ));
    }
    let blocks = resolve_blocks(cli, &refs)?;
    let mut m = Map::new();
    m.insert("blocks".to_owned(), json!(blocks));
    run_tool(cli, "blocks_remove", m, a.value("actor"), refs, move |_| {
        Ok(sugar::remove_blocks(blocks))
    })
}

/// `rm --doc` — `docs_delete`, rendered as a document operation (§4).
fn rm_doc(cli: &mut Cli, doc: &str, actor: Option<&str>) -> Result<i32> {
    super::docs::rm_doc(cli, doc, actor)
}

// ---- done -----------------------------------------------------------------------------

pub fn done(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "done");
    }
    let a = parse_args(args, &[Opt::flag("undo"), ACTOR])?;
    let refs = expand_dash(&a.positionals);
    if refs.is_empty() {
        return Err(CliError::usage(
            "done requires one or more task blocks (or - for stdin)",
        ));
    }
    // §2.3: remotely `blocks_check` resolves the refs; the task-type check
    // below is the local path's (the reference's remote branch skips it).
    let mut blocks = Vec::with_capacity(refs.len());
    for r in &refs {
        if cli.remote_mode() {
            blocks.push(r.clone());
            continue;
        }
        let id = block_id(cli, r)?;
        blocks.push(task_block(cli, r, id)?);
    }
    let mut m = Map::new();
    m.insert("_ids".to_owned(), json!(blocks));
    let checked = !a.flag("undo");
    if !checked {
        m.insert("checked".to_owned(), json!(false));
    }
    run_tool(cli, "blocks_check", m, a.value("actor"), refs, move |_| {
        Ok(sugar::check_blocks(&blocks, checked))
    })
}

/// §9 Fixed: `done` addresses task blocks only — any other live type is
/// `type_mismatch` before an op is built (its `data` names the block's `_id`
/// and `_type`, spec/surface §4, 5.0).
fn task_block(cli: &mut Cli, r: &str, block: String) -> Result<String> {
    let kind: Option<String> = cli
        .store()?
        .conn()
        .query_row(
            "SELECT type FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
            params![block],
            |row| row.get(0),
        )
        .optional()?;
    match kind {
        None => Err(CliError::engine_data(
            "block_missing",
            format!("no block with id {}", Json::String(r.to_owned())),
            json!({ "_id": r }),
        )),
        Some(t) if t != "task" => Err(CliError::engine_data(
            "type_mismatch",
            format!("not a task: {r} is a {t}"),
            json!({ "_id": block, "_type": t }),
        )),
        Some(_) => Ok(block),
    }
}

// ---- append ---------------------------------------------------------------------------

pub fn append(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "append");
    }
    let content = extract_content_opts(args)?;
    let a = parse_args(&content.rest, &[ACTOR])?;
    let Some(target) = a.pos(0) else {
        return Err(CliError::usage("append requires a <block>"));
    };
    let target = target.to_owned();
    let markdown = read_content(&content)?;
    // `blocks_append` decides by the block's kind (a heading's section, a
    // container's children, a leaf → `block_not_container`), spec/surface §4.
    let block = block_arg(cli, &target)?;
    let mut m = Map::new();
    m.insert("_id".to_owned(), json!(block));
    m.insert("text".to_owned(), json!(markdown));
    // A remote dry run (or a remote engine without the sugar tool) reads
    // the kind first: a heading → its section, else the block as a
    // container — through `blocks_read` when the engine lists it, else a
    // `query` over `blocks` (the minimal profile).
    run_tool(
        cli,
        "blocks_append",
        m,
        a.value("actor"),
        vec![target],
        move |cli| {
            let kind = if cli.remote_mode() && !cli.remote_has_tool("blocks_read")? {
                let q = format!(
                    "select t: _type from blocks where _id == {}",
                    Json::String(block.clone())
                );
                let res = cli.call("query", json!({ "query": q }))?;
                str_of(&res["hits"][0], "t")
            } else {
                let read = cli.call(
                    "blocks_read",
                    json!({ "_id": block, "resolution": "skeleton" }),
                )?;
                str_of(&read, "_type")
            };
            let into = if kind == "heading" {
                EffectTarget::Section { heading_id: block }
            } else {
                EffectTarget::Block { id: block }
            };
            Ok(sugar::insert(into, At::End, &markdown, None))
        },
    )
}

// ---- split / merge --------------------------------------------------------------------

pub fn split(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "split");
    }
    let a = parse_args(args, &[Opt::value("at"), ACTOR])?;
    let Some(r) = a.pos(0) else {
        return Err(CliError::usage("split requires a <block>"));
    };
    let r = r.to_owned();
    let Some(at) = a.value("at").filter(|v| !v.is_empty()) else {
        return Err(CliError::usage("split requires --at n[,n…]"));
    };
    // §9 Fixed: offsets are integers; anything else is a usage error here.
    let offsets = at
        .split(',')
        .map(|s| s.trim().parse::<i64>().ok())
        .collect::<Option<Vec<i64>>>()
        .ok_or_else(|| {
            CliError::usage(format!(
                "bad --at '{at}' (offsets must be integers: n[,n…])"
            ))
        })?;
    let block = block_arg(cli, &r)?;
    let mut m = Map::new();
    m.insert("_id".to_owned(), json!(block));
    m.insert("at".to_owned(), json!(offsets));
    run_tool(
        cli,
        "blocks_split",
        m,
        a.value("actor"),
        vec![r],
        move |_| {
            Ok(sugar::split_block(
                &block,
                offsets
                    .iter()
                    .map(|n| usize::try_from(*n).unwrap_or(usize::MAX))
                    .collect(),
            ))
        },
    )
}

pub fn merge(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "merge");
    }
    let a = parse_args(args, &[Opt::value("sep"), ACTOR])?;
    let refs = expand_dash(&a.positionals);
    if refs.len() < 2 {
        return Err(CliError::usage("merge requires at least two blocks"));
    }
    let blocks = resolve_blocks(cli, &refs)?;
    let mut m = Map::new();
    m.insert("blocks".to_owned(), json!(blocks));
    if let Some(sep) = a.value("sep") {
        m.insert("separator".to_owned(), json!(sep));
    }
    let sep = a.value("sep").map(str::to_owned);
    run_tool(cli, "blocks_merge", m, a.value("actor"), refs, move |_| {
        Ok(sugar::merge_blocks(blocks, sep.as_deref()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn content_opts_take_dash_values_verbatim() {
        let c = extract_content_opts(&v(&["b_1", "-m", "- [ ] task", "--actor", "x"])).unwrap();
        assert_eq!(c.message.as_deref(), Some("- [ ] task"));
        assert_eq!(c.rest, v(&["b_1", "--actor", "x"]));
        let c = extract_content_opts(&v(&["-f=-", "--message=hi", "--", "-m"])).unwrap();
        assert_eq!(c.file.as_deref(), Some("-"));
        assert_eq!(c.message.as_deref(), Some("hi"));
        assert_eq!(c.rest, v(&["--", "-m"]));
        let e = extract_content_opts(&v(&["-m"])).unwrap_err();
        assert_eq!(e.message(), "-m requires a value");
    }

    #[test]
    fn at_specs() {
        assert_eq!(parse_at(None).unwrap(), json!("end"));
        assert_eq!(parse_at(Some(" start ")).unwrap(), json!("start"));
        assert_eq!(
            parse_at(Some("after b_311")).unwrap(),
            json!({ "after": "b_311" })
        );
        assert_eq!(
            parse_at(Some("before  b_1")).unwrap(),
            json!({ "before": "b_1" })
        );
        let e = parse_at(Some("middle")).unwrap_err();
        assert_eq!(
            e.message(),
            "bad --at 'middle' (use end|start|before <id>|after <id>)"
        );
        assert!(parse_at(Some("before")).is_err());
    }

    #[test]
    fn receipt_ids_prefer_the_previews_live_ids() {
        let r = json!({ "plan_id": "x", "commit": "c_1", "revisions": [], "new_ids": { "$new.0": "b_9", "$new.1": "b_10" }, "committed": true });
        // The plan at hand: the preview names the live id (`$new.1`), the
        // wrapper mint `$new.0` stays out, as the `ops` form prints.
        let plan = json!({ "preview": { "results": [{ "ids": ["$new.1"] }, { "ids": ["b_3"] }] } });
        assert_eq!(
            receipt_ids(&r, Some(&plan)),
            vec!["b_10".to_owned(), "b_3".to_owned()]
        );
        // No plan (a remote apply) or a plan echoed without its preview: every mint.
        assert_eq!(
            receipt_ids(&r, None),
            vec!["b_9".to_owned(), "b_10".to_owned()]
        );
        assert_eq!(
            receipt_ids(&r, Some(&json!({ "version": 1 }))),
            vec!["b_9".to_owned(), "b_10".to_owned()]
        );
        assert!(receipt_ids(&json!({ "results": [] }), None).is_empty());
    }

    #[test]
    fn refs_become_effect_targets_and_placements() {
        assert_eq!(
            target_of("b_1").to_json(),
            json!({ "kind": "block", "_id": "b_1" })
        );
        assert_eq!(
            target_of("d_1").to_json(),
            json!({ "kind": "document", "_id": "d_1" })
        );
        assert_eq!(
            target_of("notes/a.md").to_json(),
            json!({ "kind": "document", "_path": "notes/a.md" })
        );
        assert_eq!(at_of(&json!("end")), At::End);
        assert_eq!(at_of(&json!("start")), At::Start);
        assert_eq!(at_of(&json!({ "after": "b_2" })), At::After("b_2".into()));
        assert_eq!(
            effects_json(&sugar::remove_blocks(vec!["b_1".into()])),
            json!([{ "op": "remove", "targets": [{ "kind": "block", "_id": "b_1" }] }])
        );
        assert_eq!(unified_diff_lines("a", "a"), vec![String::new()]);
    }
}
