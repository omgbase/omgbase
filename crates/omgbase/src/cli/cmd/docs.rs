//! The document verbs (`spec/cli` §6 `new`, `mv`, `meta`, `rm --doc`; cli
//! 4.0): each builds its one document effect with the shared builders
//! (`omgbase_store::sugar` — the table the `docs_*` tools use) and applies it
//! locally through `apply` under the `spec/mutate` §6 reason (the reference's
//! library path: the planner's own checks, `path_taken { path }`), remotely
//! through the mirroring `docs_create` / `docs_move` / `docs_set_meta` /
//! `docs_delete` tool (`spec/surface` §4, each answering with the Receipt).
//! Rendered as document operations (§4): the confirmation `  ok <verb>
//! <path>` on stderr, the document id on stdout; `--json` prints `{ _id,
//! _path, committed }` (`mv` adds `dangling`/`retargeted`; spec/cli 5.0: the
//! row's engine attributes, `_`-prefixed) — the verb's own
//! shape over the Receipt, as the reference renders it. The global
//! `--dry-run` is a **plan** (§3.6): the per-file diffs of the effect's
//! preview, nothing minted, nothing committed.

use omgbase_store::docs_ops::{canonical, retargeted_json};
use omgbase_store::links::{InboundLink, inbound_links_to};
use omgbase_store::{DocStore, FsDocStore, Retargeted, find_doc_by_ref, is_id_ref, sugar};
use omgbase_surface::reference_path;
use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::mutate::{
    effects_json, extract_content_opts, read_content, render_plan, render_summary, set_actor,
};
use super::{doc_locator, machine_out, str_of};

const ACTOR: Opt = Opt::value("actor");
const NO_RETARGET: Opt = Opt::flag("no-retarget");

/// Run one document operation: locally the builder's effects through
/// `apply` under its reason (the reference's `applySugar`), remotely the
/// mirroring tool with `args` — or, against an engine that does not list it
/// (the minimal profile), `apply` over the same effects; the global
/// `--dry-run` is the plan of the effects on both sides. Returns the Receipt (the tool's result remotely),
/// or `None` after a rendered plan.
fn run_doc(
    cli: &mut Cli,
    tool: &str,
    args: Map<String, Json>,
    actor: Option<&str>,
    built: &sugar::Sugar,
) -> Result<Option<Json>> {
    set_actor(cli, actor)?;
    let effects = effects_json(&built.effects);
    if cli.flags.dry_run {
        let plan = cli.preview("apply", json!({ "effects": effects }), effects)?;
        render_plan(cli, plan)?;
        return Ok(None);
    }
    if cli.remote_mode() {
        // The mirroring tool when the engine lists it, else `apply` over the
        // builder's effects (§2.3, cli 4.2).
        return Ok(Some(cli.remote_sugar(
            tool,
            Json::Object(args),
            &[],
            |_| Ok(effects),
        )?));
    }
    let (receipt, _) = cli.call_with_plan(
        "apply",
        json!({ "effects": effects, "reason": built.reason }),
    )?;
    Ok(Some(receipt))
}

/// A document a verb addresses: its id and storage-form path. Locally the
/// store's row (a miss is the surface's `doc_missing` naming the locator);
/// remotely a `d_` ref is the id already and a path is read back through
/// `docs_read` — the Receipt of a move or a delete need not carry it.
pub(super) fn doc_identity(cli: &mut Cli, r: &str) -> Result<(String, String)> {
    if cli.remote_mode() {
        let read = if is_id_ref(r, "d") {
            cli.call("docs_read", json!({ "_id": r }))?
        } else {
            cli.call("docs_read", json!({ "_path": r }))?
        };
        return Ok((str_of(&read, "_id"), canonical(&str_of(&read, "_path"))));
    }
    let repo = cli.repo()?;
    match find_doc_by_ref(cli.store()?.conn(), &repo.repo_id, r)? {
        Some(info) => Ok((info.doc_id, info.path)),
        None => {
            let mut locator = Map::new();
            doc_locator(&mut locator, r);
            Err(CliError::engine_data(
                "doc_missing",
                format!("no document with id or path {}", Json::String(r.to_owned())),
                Json::Object(locator),
            ))
        }
    }
}

/// §4 document-op confirmation over `{ _id, _path, committed: true }` (+ `mv`'s
/// extras): the `--json` document in a machine mode, else `  ok <verb>
/// <path>` on stderr, the Receipt's `summary` lines under it (cli 4.3), and
/// the id on stdout.
fn report(cli: &mut Cli, verb: &str, res: &Json, receipt: &Json) -> Result<i32> {
    cli.capture(res);
    if let Some(code) = machine_out(cli, res, None, None) {
        return code;
    }
    cli.io.err(&cli.style.dim(&format!(
        "  {} {verb} {}",
        cli.style.ok(cli.style.glyphs().ok),
        cli.style.accent(&str_of(res, "_path"))
    )));
    render_summary(cli, receipt);
    cli.io.out(&str_of(res, "_id"));
    Ok(EXIT_OK)
}

/// The pre-check the `docs_create` / `docs_move` tools run, locally (the
/// reference's `requireAbsentPath`): a live document at `rel` is
/// `path_taken` with the verb's message, a file on disk `path_taken` "file
/// already exists on disk at <rel>" — the legacy messages, no payload (the
/// planner's own copy, which names the path in `data`, never fires behind it).
fn require_absent(cli: &mut Cli, rel: &str, taken_message: String) -> Result<()> {
    let repo = cli.repo()?;
    if cli.store()?.live_doc_at(&repo.repo_id, rel)? {
        return Err(CliError::engine("path_taken", taken_message));
    }
    if let Some(root) = &repo.root_path
        && FsDocStore::new(root).exists(rel)
    {
        return Err(CliError::engine(
            "path_taken",
            format!("file already exists on disk at {rel}"),
        ));
    }
    Ok(())
}

/// `{ _id, _path, committed: true }`, the path rooted.
fn doc_op(id: &str, path: &str) -> Json {
    json!({ "_id": id, "_path": reference_path(path), "committed": true })
}

// ---- new ------------------------------------------------------------------------------

/// `new <path> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]` —
/// `docs_create` from complete file bytes; the created document is the
/// Receipt's `new_ids["$new.0"]`.
pub fn new(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "new");
    }
    let content = extract_content_opts(args)?;
    let a = parse_args(&content.rest, &[ACTOR])?;
    let Some(path) = a.pos(0) else {
        return Err(CliError::usage("new requires a <path>"));
    };
    let bytes = read_content(&content)?;
    let built = sugar::create_document(path, &bytes, None);
    let rel = canonical(path);
    let mut m = Map::new();
    m.insert("path".to_owned(), json!(path));
    m.insert("markdown".to_owned(), json!(bytes));
    if !cli.remote_mode() && !cli.flags.dry_run {
        require_absent(cli, &rel, format!("document already exists at {rel}"))?;
    }
    let Some(res) = run_doc(cli, "docs_create", m, a.value("actor"), &built)? else {
        return Ok(EXIT_OK);
    };
    // The created document is the Receipt's `$new.0` (its `revisions[0]`).
    let id = res["new_ids"]["$new.0"]
        .as_str()
        .or_else(|| res["revisions"][0]["_id"].as_str())
        .unwrap_or_default()
        .to_owned();
    report(cli, "created", &doc_op(&id, &rel), &res)
}

// ---- mv -------------------------------------------------------------------------------

/// `mv <doc> <new-path> [--no-retarget] [--actor <s>] [--dry-run]` —
/// `docs_move`: identity and history preserved; the inbound links are
/// rewritten to the new path by default (spec/mutate 1.3) and the human
/// rendering says how many; `--no-retarget` leaves them as written, and
/// whatever still dangles is reported on stderr with the fix for its kind
/// (spec/cli §6 `mv`).
pub fn mv(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "mv");
    }
    let a = parse_args(args, &[ACTOR, NO_RETARGET])?;
    let (Some(doc), Some(to)) = (a.pos(0), a.pos(1)) else {
        return Err(CliError::usage("mv requires <doc> and <new-path>"));
    };
    let retarget = !a.flag("no-retarget");
    let to_rel = canonical(to);
    let mut m = Map::new();
    doc_locator(&mut m, doc);
    m.insert("to_path".to_owned(), json!(to));
    if !retarget {
        m.insert("retarget_inbound".to_owned(), json!(false));
    }
    if cli.remote_mode() && cli.flags.dry_run {
        // The same effect the server builds, over the locator (the server
        // resolves it).
        let mut target = Map::new();
        target.insert("kind".to_owned(), json!("document"));
        doc_locator(&mut target, doc);
        let effects =
            json!([{ "op": "move", "target": target, "to": to_rel, "retarget_inbound": retarget }]);
        let plan = cli.preview("docs_move", Json::Object(m), effects)?;
        return render_plan(cli, plan);
    }
    // The document first (its id is what the confirmation prints; the
    // Receipt of a move lists the rewritten sources, not the moved document).
    let (id, from) = doc_identity(cli, doc)?;
    let built = sugar::move_document(&id, &from, &to_rel, retarget);
    // Locally: the pre-check the `docs_move` tool runs (the legacy
    // `path_taken` wording, the path as payload), then who links here BY
    // PATH as written — read before the path changes (pure, so equal to what
    // the planner lowers for the same `move` effect).
    let mut links: Option<(Vec<InboundLink>, Option<Retargeted>)> = None;
    if !cli.remote_mode() {
        if !cli.flags.dry_run {
            require_absent(
                cli,
                &to_rel,
                format!("a document already exists at {to_rel}"),
            )?;
        }
        let repo = cli.repo()?.repo_id;
        let store = cli.store()?;
        let inbound = inbound_links_to(store.conn(), &repo, &id, &from)?;
        links = Some(if retarget && !inbound.is_empty() {
            let p = store.plan_inbound_retarget(&id, &from, &to_rel, &inbound)?;
            (
                p.dangling,
                Some(Retargeted {
                    blocks: p.blocks,
                    docs: p.docs,
                }),
            )
        } else {
            (inbound, None)
        });
    }
    let Some(res) = run_doc(cli, "docs_move", m, a.value("actor"), &built)? else {
        return Ok(EXIT_OK);
    };
    let mut out = doc_op(&id, &to_rel);
    match links {
        // Each dangling link is a link row under the `links` target's names
        // (spec/surface §1.2, 5.0: `_doc_id`, `_path`, `_block_id`, `_anchor`,
        // `_field`) with its source `_path` rooted.
        Some((dangling, retargeted)) => {
            out["dangling"] = Json::Array(
                dangling
                    .iter()
                    .map(|l| {
                        let mut v = l.to_json();
                        if let Some(p) = v.get("_path").and_then(Json::as_str).map(reference_path) {
                            v["_path"] = json!(p);
                        }
                        v
                    })
                    .collect(),
            );
            out["retargeted"] = retargeted_json(retargeted.as_ref());
        }
        None => {
            out["dangling"] = res.get("dangling").cloned().unwrap_or_else(|| json!([]));
            out["retargeted"] = res.get("retargeted").cloned().unwrap_or(Json::Null);
        }
    }
    let code = report(cli, "moved to", &out, &res)?;
    if cli.machine() {
        return Ok(code);
    }
    let style = cli.style;
    if let Some(r) = out.get("retargeted").filter(|r| !r.is_null()) {
        let count = |k: &str| r.get(k).and_then(Json::as_array).map_or(0, Vec::len);
        let (b, d) = (count("blocks"), count("docs"));
        if b > 0 {
            cli.io.err(&style.dim(&format!(
                "  {} retargeted {b} inbound link{} in {d} document{}",
                style.ok(style.glyphs().ok),
                if b == 1 { "" } else { "s" },
                if d == 1 { "" } else { "s" },
            )));
        }
    }
    let dangling: Vec<&Json> = out
        .get("dangling")
        .and_then(Json::as_array)
        .map(|d| d.iter().collect())
        .unwrap_or_default();
    if dangling.is_empty() {
        return Ok(code);
    }
    let where_ = dangling
        .iter()
        .map(|l| {
            let path = str_of(l, "_path");
            match l.get("_block_id").and_then(Json::as_str) {
                Some(b) => format!("{path} {b}"),
                None => format!("{path} (frontmatter)"),
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let n = dangling.len();
    cli.io.err(&style.warn(&format!(
        "  {} {n} inbound link{} still name{} the old path: {where_}",
        style.warn(style.glyphs().warn),
        if n == 1 { "" } else { "s" },
        if n == 1 { "s" } else { "" },
    )));
    let new_path = str_of(&out, "_path");
    // Authored links left as written (`--no-retarget`): the retarget that
    // rewrites them — from the path the move left behind, rooted.
    if dangling
        .iter()
        .any(|l| l.get("_block_id").is_some_and(Json::is_string))
    {
        cli.io.err(&style.dim(&format!(
            "  fix: {} retarget {} {new_path} --apply",
            cli.prog,
            reference_path(&from)
        )));
    }
    // Frontmatter relations are never rewritten by a move: one `meta` per
    // (source, field).
    let mut seen: Vec<(String, String)> = Vec::new();
    for l in &dangling {
        if l.get("_block_id").is_some_and(Json::is_string) {
            continue;
        }
        let Some(field) = l.get("_field").and_then(Json::as_str) else {
            continue;
        };
        let key = (str_of(l, "_path"), field.to_owned());
        if seen.contains(&key) {
            continue;
        }
        cli.io.err(&style.dim(&format!(
            "  fix: {} meta {} --set {field}={new_path}",
            cli.prog, key.0
        )));
        seen.push(key);
    }
    Ok(code)
}

// ---- rm --doc -------------------------------------------------------------------------

/// `rm --doc <doc>` — `docs_delete`, rendered as a document operation (§4)
/// `deleted <path>`; the Receipt of a delete carries no revision, so the
/// document is resolved first.
pub fn rm_doc(cli: &mut Cli, doc: &str, actor: Option<&str>) -> Result<i32> {
    let mut m = Map::new();
    doc_locator(&mut m, doc);
    if cli.remote_mode() && cli.flags.dry_run {
        let mut target = Map::new();
        target.insert("kind".to_owned(), json!("document"));
        doc_locator(&mut target, doc);
        let plan = cli.preview(
            "docs_delete",
            Json::Object(m),
            json!([{ "op": "remove", "target": target }]),
        )?;
        return render_plan(cli, plan);
    }
    let (id, path) = doc_identity(cli, doc)?;
    let built = sugar::delete_document(&id, &path);
    let Some(res) = run_doc(cli, "docs_delete", m, actor, &built)? else {
        return Ok(EXIT_OK);
    };
    report(cli, "deleted", &doc_op(&id, &path), &res)
}

// ---- meta -----------------------------------------------------------------------------

/// The repeatable `--set`, `--set-json` and `--unset` (and their `=` forms),
/// pulled out before the option parser (which keeps one value per option);
/// everything from a literal `--` on is left for the parser.
#[derive(Debug)]
struct MetaOpts {
    set: Vec<String>,
    set_json: Vec<String>,
    unset: Vec<String>,
    rest: Vec<String>,
}

fn extract_meta_opts(args: &[String]) -> Result<MetaOpts> {
    let mut out = MetaOpts {
        set: Vec::new(),
        set_json: Vec::new(),
        unset: Vec::new(),
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
        let (name, inline) = match a.strip_prefix("--") {
            Some(body) => match body.split_once('=') {
                Some((n, v)) => (n, Some(v.to_owned())),
                None => (body, None),
            },
            None => {
                out.rest.push(a.to_owned());
                continue;
            }
        };
        let bucket = match name {
            "set" => &mut out.set,
            "set-json" => &mut out.set_json,
            "unset" => &mut out.unset,
            _ => {
                out.rest.push(a.to_owned());
                continue;
            }
        };
        let v = match inline {
            Some(v) => v,
            None => match args.get(i) {
                Some(v) => {
                    i += 1;
                    v.clone()
                }
                None => {
                    return Err(CliError::usage(format!(
                        "option '--{name}' requires a value"
                    )));
                }
            },
        };
        bucket.push(v);
    }
    Ok(out)
}

/// `--set k=v`: the value as the YAML core schema resolves it (`1702` a
/// number, `true` a boolean, `~` null, anything else a string).
fn yaml_scalar(v: &str) -> Json {
    omgbase_properties::parse_document(v)
        .map_or_else(|| Json::String(v.to_owned()), |y| y.to_json())
}

/// `meta <doc> [--set k=v]… [--set-json k=<json>]… [--unset k]… [--actor <s>] [--dry-run]`
/// — `docs_set_meta`: the frontmatter patched, the body untouched.
pub fn meta(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "meta");
    }
    let opts = extract_meta_opts(args)?;
    let a = parse_args(&opts.rest, &[ACTOR])?;
    let Some(doc) = a.pos(0) else {
        return Err(CliError::usage("meta requires a <doc>"));
    };
    let mut set = Map::new();
    for kv in &opts.set {
        let Some((k, v)) = kv.split_once('=') else {
            return Err(CliError::usage(format!("--set expects k=v, got '{kv}'")));
        };
        set.insert(k.to_owned(), yaml_scalar(v));
    }
    for kv in &opts.set_json {
        let Some((k, v)) = kv.split_once('=') else {
            return Err(CliError::usage(format!(
                "--set-json expects k=json, got '{kv}'"
            )));
        };
        let parsed: Json = serde_json::from_str(v)
            .map_err(|e| CliError::usage(format!("--set-json expects k=json, got '{kv}' ({e})")))?;
        set.insert(k.to_owned(), parsed);
    }
    if set.is_empty() && opts.unset.is_empty() {
        return Err(CliError::usage("meta requires --set or --unset"));
    }
    let mut m = Map::new();
    doc_locator(&mut m, doc);
    if !set.is_empty() {
        m.insert("set".to_owned(), Json::Object(set.clone()));
    }
    if !opts.unset.is_empty() {
        m.insert("unset".to_owned(), json!(opts.unset));
    }
    if cli.remote_mode() && cli.flags.dry_run {
        // The same effects the server builds, over the locator.
        let mut target = Map::new();
        target.insert("kind".to_owned(), json!("document"));
        doc_locator(&mut target, doc);
        let target = Json::Object(target);
        let mut effects: Vec<Json> = Vec::new();
        for (k, v) in &set {
            if !opts.unset.contains(k) {
                effects.push(json!({ "op": "set", "target": target, "field": format!("_frontmatter.{k}"), "value": v }));
            }
        }
        for k in &opts.unset {
            effects.push(
                json!({ "op": "unset", "target": target, "field": format!("_frontmatter.{k}") }),
            );
        }
        let plan = cli.preview("docs_set_meta", Json::Object(m), Json::Array(effects))?;
        return render_plan(cli, plan);
    }
    let (id, path) = doc_identity(cli, doc)?;
    let built = sugar::set_meta(&id, &path, Some(&set), &opts.unset);
    let Some(res) = run_doc(cli, "docs_set_meta", m, a.value("actor"), &built)? else {
        return Ok(EXIT_OK);
    };
    report(cli, "patched", &doc_op(&id, &path), &res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn meta_options_repeat() {
        let o = extract_meta_opts(&v(&[
            "d.md",
            "--set",
            "a=1",
            "--set=b=x",
            "--set-json",
            "c=[1]",
            "--unset",
            "d",
            "--actor",
            "human:spec",
        ]))
        .unwrap();
        assert_eq!(o.set, v(&["a=1", "b=x"]));
        assert_eq!(o.set_json, v(&["c=[1]"]));
        assert_eq!(o.unset, v(&["d"]));
        assert_eq!(o.rest, v(&["d.md", "--actor", "human:spec"]));
        let e = extract_meta_opts(&v(&["d.md", "--set"])).unwrap_err();
        assert_eq!(e.message(), "option '--set' requires a value");
    }

    #[test]
    fn set_values_are_yaml_scalars() {
        assert_eq!(yaml_scalar("1702"), json!(1702));
        assert_eq!(yaml_scalar("true"), json!(true));
        assert_eq!(yaml_scalar("canon"), json!("canon"));
        assert_eq!(yaml_scalar("~"), Json::Null);
        assert_eq!(yaml_scalar("0.5"), json!(0.5));
    }

    #[test]
    fn doc_op_roots_the_path() {
        assert_eq!(
            doc_op("d_1", "notes/a.md"),
            json!({ "_id": "d_1", "_path": "/notes/a.md", "committed": true })
        );
    }
}
