//! The block mutators (`spec/cli` §6): `apply` (the primitive), `insert`,
//! `update` (a `b_` target is a block update with CAS; anything else the
//! whole-document update), `edit`, `move`, `rm` (blocks, or `--doc`), `done`,
//! `append`, `split`, `merge`. Each is a thin client: it parses argv, reads
//! its content source (`-m` / `-f` / `-` / stdin), resolves its refs to block
//! ids, and hands the catalog tool the same arguments the MCP server would
//! receive; the result is rendered once here — the commit confirmation, the
//! `--dry-run` diffs (§3.6), or the `--json` document.

use std::process::{Command, Stdio};

use omgbase_surface::history::unified_diff;
use omgbase_surface::read::{ResolvedRef, resolve_ref};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, expand_dash, parse_args, read_stdin};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};

use super::{machine_out, str_of};

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

/// A ref that must name a live block: its id, else `block_missing: not a block: <ref>`.
pub fn block_id(cli: &mut Cli, r: &str) -> Result<String> {
    let repo = cli.repo()?;
    match resolve_ref(cli.store()?.conn(), &repo.repo_id, r)? {
        Some(ResolvedRef::Block { block_id, .. }) => Ok(block_id),
        _ => Err(CliError::engine(
            "block_missing",
            format!("not a block: {r}"),
        )),
    }
}

/// A block argument for a ref-accepting tool: remotely (§2.3) the ref as
/// given — the `blocks_*` / `tasks_complete` / `sections_append` tools
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
        _ => Err(CliError::engine(
            "block_missing",
            format!("not a block: {r}"),
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

/// The `ApplyResult` of a tool result: the sugar tools decorate it (`id`/`ids`
/// on `blocks_update`, `hits`/`pairs`/`applied` on `links_retarget`); the CLI
/// prints the bare result the reference's library returns.
pub fn apply_result_of(v: Json) -> Json {
    // Rebuilt rather than `remove`d: under `preserve_order` a removal swaps
    // the last entry into the hole, and the key order is the document.
    match v {
        Json::Object(m) => Json::Object(
            m.into_iter()
                .filter(|(k, _)| !matches!(k.as_str(), "id" | "ids" | "hits" | "pairs" | "applied"))
                .collect(),
        ),
        other => other,
    }
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

/// Render an `ApplyResult` (§4): the `--json` document in a machine mode, the
/// diffs on a dry run, else the commit confirmation and the ids.
pub fn render_apply(cli: &mut Cli, result: Json) -> Result<i32> {
    cli.capture(&result);
    if let Some(code) = machine_out(cli, &result, None, None) {
        return code;
    }
    if cli.flags.dry_run {
        render_diffs(cli, result.get("diffs"));
        return Ok(EXIT_OK);
    }
    let n = result
        .get("revisions")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    cli.io.err(&cli.style.dim(&format!(
        "  {} committed · {n} document{} touched",
        cli.style.ok(cli.style.glyphs().ok),
        if n == 1 { "" } else { "s" }
    )));
    for id in result_ids(&result) {
        cli.io.out(&id);
    }
    Ok(EXIT_OK)
}

/// `results[*].ids` flattened, duplicates kept.
fn result_ids(result: &Json) -> Vec<String> {
    result
        .get("results")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("ids").and_then(Json::as_array))
        .flatten()
        .filter_map(Json::as_str)
        .map(str::to_owned)
        .collect()
}

/// Run one changeset-producing tool with the actor, `dry_run` threaded from
/// the global flag, and render its `ApplyResult`. A sourceless repo is the
/// tool's `repo_not_found` (`repo has no filesystem source; mutation
/// disabled`, `sync::sourceless`), locally and remotely alike. Remotely
/// (§2.3) the tool's result is rendered as it came — the reference's
/// `runOpsRemote` prints the decorated document (`id`/`ids` on
/// `blocks_update`) verbatim in `--json`, where the local path prints the
/// bare `ApplyResult`.
pub fn run_tool(
    cli: &mut Cli,
    tool: &str,
    mut args: Map<String, Json>,
    actor: Option<&str>,
) -> Result<i32> {
    set_actor(cli, actor)?;
    if cli.flags.dry_run {
        args.insert("dry_run".to_owned(), json!(true));
    }
    let result = cli.call(tool, Json::Object(args))?;
    if cli.remote_mode() {
        return render_apply(cli, result);
    }
    render_apply(cli, apply_result_of(result))
}

const ACTOR: Opt = Opt::value("actor");

// ---- apply ----------------------------------------------------------------------------

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
    let Some(ops) = parsed.get("ops").and_then(Json::as_array) else {
        return Err(CliError::usage("changeset must have an `ops` array"));
    };
    if ops.is_empty() {
        cli.io.err(&cli.style.dim("  nothing to do"));
        return Ok(EXIT_OK);
    }
    let mut m = Map::new();
    m.insert("ops".to_owned(), Json::Array(ops.clone()));
    if let Some(r) = a.value("reason") {
        m.insert("reason".to_owned(), json!(r));
    }
    run_tool(cli, "apply", m, a.value("actor"))
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
    m.insert("at".to_owned(), at);
    if let Some(e) = a.value("expect") {
        m.insert("expect".to_owned(), json!({ "parent_children_hash": e }));
    }
    run_tool(cli, "blocks_insert", m, a.value("actor"))
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
    m.insert("block".to_owned(), json!(block));
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
    run_tool(cli, "blocks_update", m, a.value("actor"))
}

fn update_doc(cli: &mut Cli, args: &[String]) -> Result<i32> {
    let content = extract_content_opts(args)?;
    let a = parse_args(
        &content.rest,
        &[ACTOR, Opt::value("reason"), Opt::flag("plan")],
    )?;
    let Some(doc) = a.pos(0) else {
        return Err(CliError::usage("update requires a <doc> (id or path)"));
    };
    let doc = doc.to_owned();
    let bytes = read_content(&content)?;
    let dry_run = a.flag("plan") || cli.flags.dry_run;
    // §2.3: remotely `docs_update` reconciles and commits server-side and
    // returns the same `{ opset, plan, result }`; the working-tree check is
    // the engine's.
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
    let mut m = Map::new();
    m.insert("doc".to_owned(), json!(doc));
    m.insert("content".to_owned(), json!(bytes));
    if let Some(r) = a.value("reason") {
        m.insert("reason".to_owned(), json!(r));
    }
    if dry_run {
        m.insert("dry_run".to_owned(), json!(true));
    }
    let res = cli.call("docs_update", Json::Object(m))?;
    let opset = res.get("opset").cloned().unwrap_or(Json::Null);
    let result = res.get("result").cloned().unwrap_or(Json::Null);
    // `--json` is `{ opset, result }`; the tool's rendered `plan` is the human tier.
    let mut doc_json = Map::new();
    doc_json.insert("opset".to_owned(), opset.clone());
    doc_json.insert("result".to_owned(), result.clone());
    let doc_json = Json::Object(doc_json);
    cli.capture(&doc_json);
    if cli.machine() {
        cli.io.out(&js_json(&doc_json));
        return Ok(EXIT_OK);
    }
    let path = opset
        .get("target")
        .map(|t| str_of(t, "path"))
        .unwrap_or_default();
    if dry_run || result.is_null() {
        let converges = opset
            .get("converges")
            .and_then(Json::as_bool)
            .unwrap_or(true);
        cli.io.err(&cli.style.dim(&format!(
            "  plan for {}{}",
            cli.style.accent(&path),
            if converges {
                ""
            } else {
                " — DOES NOT CONVERGE (will not apply)"
            }
        )));
        cli.io.out(&str_of(&res, "plan"));
        return Ok(EXIT_OK);
    }
    let summary = opset.get("summary").cloned().unwrap_or(Json::Null);
    let count = |k: &str| summary.get(k).and_then(Json::as_i64).unwrap_or(0);
    cli.io.err(&cli.style.dim(&format!(
        "  {} updated {} · {} preserved, {} updated, {} moved, {} created, {} removed",
        cli.style.ok(cli.style.glyphs().ok),
        cli.style.accent(&path),
        count("preserved"),
        count("updated"),
        count("moved"),
        count("created"),
        count("removed"),
    )));
    // Every id once, in order of first appearance (§9 Fixed).
    let mut seen: Vec<String> = Vec::new();
    for id in result_ids(&result) {
        if !seen.contains(&id) {
            cli.io.out(&id);
            seen.push(id);
        }
    }
    Ok(EXIT_OK)
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
    let (doc_id, block) = block_ref(cli, &r)?;
    let node = cli.call(
        "nodes_get",
        json!({ "id": block, "doc": doc_id, "resolution": "raw" }),
    )?;
    let before = str_of(&node, "raw");
    // Pin the CAS BEFORE the editor opens.
    let pre_hash = node
        .get("content_hash")
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
    let mut m = Map::new();
    m.insert("block".to_owned(), json!(block));
    m.insert("markdown".to_owned(), json!(after));
    if let Some(h) = pre_hash {
        m.insert("expect".to_owned(), json!({ "content_hash": h }));
    }
    run_tool(cli, "blocks_update", m, a.value("actor"))
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
    m.insert("at".to_owned(), at);
    if let Some(e) = a.value("expect") {
        m.insert("expect".to_owned(), json!({ "parent_children_hash": e }));
    }
    run_tool(cli, "blocks_move", m, a.value("actor"))
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
    run_tool(cli, "blocks_remove", m, a.value("actor"))
}

/// `rm --doc` — `docs_delete`, rendered as a document operation (§4).
fn rm_doc(cli: &mut Cli, doc: &str, actor: Option<&str>) -> Result<i32> {
    set_actor(cli, actor)?;
    let mut m = Map::new();
    m.insert("doc".to_owned(), json!(doc));
    if cli.flags.dry_run {
        m.insert("dry_run".to_owned(), json!(true));
    }
    let res = cli.call("docs_delete", Json::Object(m))?;
    cli.capture(&res);
    if let Some(code) = machine_out(cli, &res, None, None) {
        return code;
    }
    if cli.flags.dry_run {
        render_diffs(cli, res.get("diffs"));
        return Ok(EXIT_OK);
    }
    cli.io.err(&cli.style.dim(&format!(
        "  {} deleted {}",
        cli.style.ok(cli.style.glyphs().ok),
        cli.style.accent(&str_of(&res, "path"))
    )));
    cli.io.out(&str_of(&res, "docId"));
    Ok(EXIT_OK)
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
    // §2.3: remotely `tasks_complete` resolves the refs; the task-type check
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
    m.insert("blocks".to_owned(), json!(blocks));
    if a.flag("undo") {
        m.insert("checked".to_owned(), json!(false));
    }
    run_tool(cli, "tasks_complete", m, a.value("actor"))
}

/// §9 Fixed: `done` addresses task blocks only — any other live type is
/// `type_mismatch` before an op is built.
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
        None => Err(CliError::engine(
            "block_missing",
            format!("not a block: {r}"),
        )),
        Some(t) if t != "task" => Err(CliError::engine_data(
            "type_mismatch",
            format!("not a task: {r} is a {t}"),
            json!({ "block": block, "type": t }),
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
    let Some(heading) = a.pos(0) else {
        return Err(CliError::usage("append requires a <heading> block"));
    };
    let heading = heading.to_owned();
    let markdown = read_content(&content)?;
    let heading_id = block_arg(cli, &heading)?;
    let mut m = Map::new();
    m.insert("heading".to_owned(), json!(heading_id));
    m.insert("markdown".to_owned(), json!(markdown));
    run_tool(cli, "sections_append", m, a.value("actor"))
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
    m.insert("block".to_owned(), json!(block));
    m.insert("at".to_owned(), json!(offsets));
    run_tool(cli, "blocks_split", m, a.value("actor"))
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
    run_tool(cli, "blocks_merge", m, a.value("actor"))
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
    fn strips_tool_decorations() {
        let r = apply_result_of(
            json!({ "id": "b_1", "ids": ["b_1"], "results": [], "revisions": [], "committed": true }),
        );
        assert_eq!(
            js_json(&r),
            r#"{"results":[],"revisions":[],"committed":true}"#
        );
        assert_eq!(unified_diff_lines("a", "a"), vec![String::new()]);
    }
}
