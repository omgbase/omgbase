//! The command registry (`spec/cli` §2.4, §5): every verb with its aliases
//! and one-line summary, in the reference's catalog order (the order also
//! breaks `did you mean` ties). A verb is a function `(cli, args) -> exit
//! code`; the verb groups live in `cmd/`, one module each, and a later wave
//! swaps a [`super::cmd::pending`] stub for the real verb here.

use super::cmd;
use super::context::Cli;
use super::output::{CliError, Result};

pub type RunFn = fn(&mut Cli, &[String]) -> Result<i32>;

pub struct Command {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub summary: &'static str,
    pub run: RunFn,
}

const fn cmd(
    name: &'static str,
    aliases: &'static [&'static str],
    summary: &'static str,
    run: RunFn,
) -> Command {
    Command {
        name,
        aliases,
        summary,
        run,
    }
}

/// The catalog, in the reference's order.
pub static COMMANDS: &[Command] = &[
    cmd(
        "init",
        &[],
        "Create a workspace (run `source add` to ingest files)",
        cmd::bootstrap::init,
    ),
    cmd(
        "repos",
        &[],
        "List repos in this workspace",
        cmd::bootstrap::repos,
    ),
    cmd(
        "status",
        &[],
        "Where am I: repo, sync, watcher, queue",
        cmd::status::status,
    ),
    cmd("ls", &[], "List live documents", cmd::ls::ls),
    cmd(
        "outline",
        &["ol"],
        "Document outline (frozen wire format)",
        cmd::outline::outline,
    ),
    cmd(
        "cat",
        &[],
        "Content bytes of a node (default raw)",
        cmd::cat::cat,
    ),
    cmd("show", &[], "Metadata card for a node", cmd::show::show),
    cmd(
        "find",
        &[],
        "Ranked hybrid search for the id of a thing",
        cmd::find::find,
    ),
    cmd(
        "query",
        &["q"],
        "Composable query (OQX: from/where/select + collection ops)",
        cmd::query::query,
    ),
    cmd("log", &[], "Commit digests (change feed)", cmd::log::log),
    cmd("hist", &[], "A block's change biography", cmd::hist::hist),
    cmd("diff", &[], "Unified diff of a document", cmd::diff::diff),
    cmd(
        "links",
        &[],
        "Open edges touching a node",
        cmd::links::links,
    ),
    cmd(
        "apply",
        &[],
        "Apply a raw changeset (the primitive)",
        cmd::mutate::apply,
    ),
    cmd(
        "insert",
        &[],
        "Insert blocks under a parent",
        cmd::mutate::insert,
    ),
    cmd(
        "update",
        &[],
        "Replace a block, or reconcile a whole document (identity-preserving)",
        cmd::mutate::update,
    ),
    cmd(
        "edit",
        &[],
        "Edit a block in $EDITOR (CAS pinned)",
        cmd::mutate::edit,
    ),
    cmd(
        "move",
        &[],
        "Move blocks under a new parent",
        cmd::mutate::r#move,
    ),
    cmd(
        "rm",
        &[],
        "Remove blocks (or --doc a document)",
        cmd::mutate::rm,
    ),
    cmd("done", &[], "Check/uncheck task blocks", cmd::mutate::done),
    cmd(
        "append",
        &[],
        "Append into a heading's section",
        cmd::mutate::append,
    ),
    cmd(
        "retarget",
        &[],
        "Rewrite a link target (plan-by-default)",
        cmd::retarget::retarget,
    ),
    cmd(
        "node",
        &[],
        "Edit a node's editable properties (surgical)",
        cmd::node::node,
    ),
    cmd("split", &[], "Split a block at offsets", cmd::mutate::split),
    cmd("merge", &[], "Merge adjacent blocks", cmd::mutate::merge),
    cmd("new", &[], "Create a document", cmd::docs::new),
    cmd("mv", &[], "Rename a document", cmd::docs::mv),
    cmd(
        "meta",
        &[],
        "Patch a document's frontmatter",
        cmd::docs::meta,
    ),
    cmd(
        "run",
        &[],
        "Evaluate an ```omg fence (OQX, inert, read-only)",
        cmd::query::run,
    ),
    cmd(
        "shell",
        &[],
        "Persistent session with typed bindings (@1/@_/@name)",
        cmd::shell::shell,
    ),
    cmd(
        "source",
        &[],
        "Where a repo's bytes come from (add/list/attach/detach/rm)",
        cmd::source::source,
    ),
    cmd(
        "sync",
        &[],
        "Reconcile a repo with its filesystem source (--watch to stay live; --server for remote)",
        cmd::sync::sync,
    ),
    cmd(
        "mcp",
        &[],
        "Serve the MCP tool surface on stdio",
        cmd::mcp::mcp,
    ),
    cmd(
        "rebuild-index",
        &[],
        "Rebuild derived tables",
        cmd::admin::rebuild_index,
    ),
    cmd("gc", &[], "Mark-and-sweep (flag-gated)", cmd::admin::gc),
    cmd(
        "doctor",
        &[],
        "Invariant sweep (CI-able)",
        cmd::admin::doctor,
    ),
    cmd(
        "config",
        &[],
        "Read/write repo settings",
        cmd::admin::config,
    ),
    cmd(
        "embed",
        &[],
        "Embedding queue: status, or drain to embed",
        cmd::admin::embed,
    ),
    cmd(
        "version",
        &[],
        "Which engine and which versions (binary, components, specs, schema, MCP, runtime, build)",
        cmd::version::version,
    ),
    cmd("help", &[], "Show this help", cmd::help::help),
];

/// Every name and alias, in catalog order (the `did you mean` candidates).
fn names() -> impl Iterator<Item = &'static str> {
    COMMANDS
        .iter()
        .flat_map(|c| std::iter::once(c.name).chain(c.aliases.iter().copied()))
}

/// The command for a name or alias.
pub fn resolve(name: &str) -> Option<&'static Command> {
    COMMANDS
        .iter()
        .find(|c| c.name == name || c.aliases.contains(&name))
}

/// §2.4: the usage error for an unrecognized command, with `did you mean`
/// when a name or alias is within *k* edits (*k* = 1 up to three
/// characters, else 2; the closest wins, ties by catalog order).
pub fn unknown_command_error(prog: &str, name: &str) -> CliError {
    let hint = format!("run '{prog} --help' for the command list");
    match did_you_mean(name) {
        Some(guess) => CliError::usage_hint(
            format!("unknown command '{name}'"),
            format!("did you mean '{guess}'? {hint}"),
        ),
        None => CliError::usage_hint(format!("unknown command '{name}'"), hint),
    }
}

fn did_you_mean(name: &str) -> Option<&'static str> {
    let max_edits = if name.chars().count() <= 3 { 1 } else { 2 };
    let lower = name.to_lowercase();
    let mut best: Option<(&'static str, usize)> = None;
    for candidate in names() {
        let d = edit_distance(&lower, candidate);
        if d <= max_edits && best.is_none_or(|(_, bd)| d < bd) {
            best = Some((candidate, d));
        }
    }
    best.map(|(n, _)| n)
}

/// Levenshtein distance over chars.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i];
        for j in 1..=b.len() {
            let sub = prev[j - 1] + usize::from(a[i - 1] != b[j - 1]);
            cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(sub));
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses() {
        assert_eq!(did_you_mean("statsu"), Some("status"));
        assert_eq!(did_you_mean("lz"), Some("ls"));
        assert_eq!(did_you_mean("x"), Some("q"));
        assert_eq!(did_you_mean("zzzzzz"), None);
        assert_eq!(did_you_mean("OL"), Some("ol"));
        assert!(resolve("q").is_some_and(|c| c.name == "query"));
        assert!(resolve("nope").is_none());
    }

    #[test]
    fn every_command_has_a_card() {
        for c in COMMANDS {
            if c.name != "help" {
                assert!(
                    super::super::help::card(c.name, "omg").is_some(),
                    "{}",
                    c.name
                );
            }
        }
    }
}
