//! The document verbs (`spec/cli` §6 `new`, `mv`, `meta`): thin clients of
//! the catalog's `docs_create`, `docs_move` and `docs_set_meta`
//! (`spec/surface` §4, 1.3), rendered as document operations (§4): the
//! confirmation on stderr, the document id on stdout; the global `--dry-run`
//! rides as the tool's `dry_run` and prints the per-file diffs (§3.6);
//! `--json` prints the tool's result. `rm --doc` lives with the block `rm`
//! in [`super::mutate`].

use serde_json::{Map, Value as Json, json};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};

use super::mutate::{extract_content_opts, read_content, render_diffs, require_root, set_actor};
use super::{machine_out, str_of};

const ACTOR: Opt = Opt::value("actor");

/// Run one document tool with the actor and the global `--dry-run` threaded.
fn call_doc_tool(
    cli: &mut Cli,
    tool: &str,
    mut args: Map<String, Json>,
    actor: Option<&str>,
) -> Result<Json> {
    require_root(cli)?;
    set_actor(cli, actor)?;
    if cli.flags.dry_run {
        args.insert("dry_run".to_owned(), json!(true));
    }
    let res = cli.call(tool, Json::Object(args))?;
    cli.capture(&res);
    Ok(res)
}

/// §4 document-op confirmation: the `--json` document in a machine mode, the
/// diffs on a dry run, else `  ok <verb> <path>` on stderr and the id on stdout.
fn report(cli: &mut Cli, verb: &str, res: &Json) -> Result<i32> {
    if let Some(code) = machine_out(cli, res, None, None) {
        return code;
    }
    if cli.flags.dry_run {
        render_diffs(cli, res.get("diffs"));
        return Ok(EXIT_OK);
    }
    cli.io.err(&cli.style.dim(&format!(
        "  {} {verb} {}",
        cli.style.ok(cli.style.glyphs().ok),
        cli.style.accent(&str_of(res, "path"))
    )));
    cli.io.out(&str_of(res, "docId"));
    Ok(EXIT_OK)
}

// ---- new ------------------------------------------------------------------------------

/// `new <path> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]` —
/// `docs_create` from complete file bytes.
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
    let mut m = Map::new();
    m.insert("path".to_owned(), json!(path));
    m.insert("markdown".to_owned(), json!(bytes));
    let res = call_doc_tool(cli, "docs_create", m, a.value("actor"))?;
    report(cli, "created", &res)
}

// ---- mv -------------------------------------------------------------------------------

/// `mv <doc> <new-path> [--actor <s>] [--dry-run]` — `docs_move`: identity
/// and history preserved; inbound links are not rewritten and the human
/// rendering says so on stderr (§9 Fixed).
pub fn mv(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "mv");
    }
    let a = parse_args(args, &[ACTOR])?;
    let (Some(doc), Some(to)) = (a.pos(0), a.pos(1)) else {
        return Err(CliError::usage("mv requires <doc> and <new-path>"));
    };
    let mut m = Map::new();
    m.insert("doc".to_owned(), json!(doc));
    m.insert("to_path".to_owned(), json!(to));
    let res = call_doc_tool(cli, "docs_move", m, a.value("actor"))?;
    let code = report(cli, "moved to", &res)?;
    let dangling: Vec<&Json> = res
        .get("dangling")
        .and_then(Json::as_array)
        .map(|d| d.iter().collect())
        .unwrap_or_default();
    if cli.machine() || dangling.is_empty() {
        return Ok(code);
    }
    let where_ = dangling
        .iter()
        .map(|l| {
            let path = str_of(l, "path");
            match l.get("block").and_then(Json::as_str) {
                Some(b) => format!("{path} {b}"),
                None => format!("{path} (frontmatter)"),
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let n = dangling.len();
    let style = cli.style;
    cli.io.err(&style.warn(&format!(
        "  {} {n} inbound link{} still name{} the old path: {where_}",
        style.warn(style.glyphs().warn),
        if n == 1 { "" } else { "s" },
        if n == 1 { "s" } else { "" },
    )));
    // The path the move left behind: as the dangling links name it (the
    // canonical spelling with a leading `/`), else the ref as typed.
    let from = dangling
        .iter()
        .find_map(|l| l.get("target").and_then(Json::as_str))
        .unwrap_or(doc)
        .trim_start_matches('/')
        .to_owned();
    cli.io.err(&style.dim(&format!(
        "  fix: {} retarget /{from} /{} --apply",
        cli.prog,
        str_of(&res, "path")
    )));
    Ok(code)
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
    m.insert("doc".to_owned(), json!(doc));
    if !set.is_empty() {
        m.insert("set".to_owned(), Json::Object(set));
    }
    if !opts.unset.is_empty() {
        m.insert("unset".to_owned(), json!(opts.unset));
    }
    let res = call_doc_tool(cli, "docs_set_meta", m, a.value("actor"))?;
    report(cli, "patched", &res)
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
}
