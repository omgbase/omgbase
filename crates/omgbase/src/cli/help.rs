//! Help (`spec/cli` §5): the catalog and the per-command cards, byte for
//! byte the reference's. `{prog}` in a card is the invoked program name.

use super::commands::{COMMANDS, resolve};
use super::context::Cli;
use super::output::{EXIT_OK, Result};

/// The catalog's groups, in order (`help` is unlisted).
const GROUPS: &[(&str, &[&str])] = &[
    ("bootstrap", &["init", "source", "repos"]),
    (
        "orient & read",
        &["status", "ls", "outline", "cat", "show", "find"],
    ),
    ("query", &["query", "run"]),
    ("history & links", &["log", "hist", "diff", "links"]),
    (
        "mutate",
        &[
            "apply", "insert", "update", "edit", "move", "rm", "done", "append", "retarget",
            "split", "merge", "node",
        ],
    ),
    ("documents", &["new", "mv", "meta"]),
    ("session", &["shell"]),
    ("sync & serve", &["sync", "mcp"]),
    (
        "admin",
        &[
            "rebuild-index",
            "gc",
            "doctor",
            "config",
            "embed",
            "version",
        ],
    ),
];

/// The catalog (no command / `--help` / `help`).
pub fn render_catalog(cli: &Cli) -> Result<i32> {
    let (io, style, prog) = (cli.io, &cli.style, &cli.prog);
    io.out(&style.wordmark("Open Markdown Graph Base"));
    io.out(&style.rule());
    io.out("");
    io.out(&format!(
        "  {} {prog} {} <command> {}",
        style.dim("usage:"),
        style.dim("[--json|--jsonl|--ids] [-C dir] [--repo slug]"),
        style.dim("[args]")
    ));
    io.out("");
    for (title, names) in GROUPS {
        io.out(&format!("  {}", style.bold(title)));
        for name in names.iter() {
            let Some(c) = COMMANDS.iter().find(|c| c.name == *name) else {
                continue;
            };
            let mut names = vec![c.name];
            names.extend(c.aliases.iter().copied());
            let joined = names.join(", ");
            io.out(&format!(
                "    {}{}",
                style.accent(&format!("{joined:<22}")),
                style.dim(c.summary)
            ));
        }
        io.out("");
    }
    io.out(&format!(
        "  {} {prog} <command> --help {}",
        style.dim("run"),
        style.dim("for details")
    ));
    Ok(EXIT_OK)
}

/// One command's card.
pub struct HelpSpec {
    pub name: &'static str,
    pub summary: String,
    pub usage: Vec<String>,
    pub options: Vec<(String, String)>,
    pub notes: Vec<String>,
}

/// Render a card: `name — summary`, the usage line(s), aligned options with
/// `-h, --help` last, the notes after an empty line.
pub fn render_card(cli: &Cli, spec: &HelpSpec) -> Result<i32> {
    let (io, style, prog) = (cli.io, &cli.style, &cli.prog);
    io.out(&format!("  {} — {}", style.bold(spec.name), spec.summary));
    for (i, u) in spec.usage.iter().enumerate() {
        let label = if i == 0 { "usage:" } else { "      " };
        io.out(&format!("  {} {prog} {u}", style.dim(label)));
    }
    let mut options: Vec<(String, String)> = spec.options.clone();
    options.push(("-h, --help".to_owned(), "show this help".to_owned()));
    let width = options
        .iter()
        .map(|(f, _)| f.chars().count())
        .max()
        .unwrap_or(0);
    io.out(&format!("  {}", style.dim("options:")));
    for (flag, desc) in &options {
        io.out(&format!(
            "    {}  {desc}",
            style.accent(&format!("{flag:<width$}"))
        ));
    }
    if !spec.notes.is_empty() {
        io.out("");
        for n in &spec.notes {
            io.out(&format!("  {n}"));
        }
    }
    Ok(EXIT_OK)
}

/// The card of `name` (a command name, not an alias), or the catalog for `help`.
pub fn render_help_for(cli: &Cli, name: &str) -> Result<i32> {
    let Some(command) = resolve(name) else {
        return render_catalog(cli);
    };
    let canonical = command.name;
    match card(canonical, &cli.prog) {
        Some(spec) => {
            let code = render_card(cli, &spec)?;
            if canonical == "query" {
                for line in QUERY_EXAMPLES {
                    cli.io.out(line);
                }
            }
            Ok(code)
        }
        None => render_catalog(cli),
    }
}

/// `--help` as the first residual argument (prepended by the dispatcher when
/// the global flag was given) → the card.
pub fn wants_help(args: &[String]) -> bool {
    args.first().is_some_and(|a| a == "--help")
}

const QUERY_EXAMPLES: &[&str] = &[
    "  e.g. query 'from docs where nodes count { where kind == \"md:task\" } >= 2'",
    "       query 'select items: section.blocks collect { where type == \"list_item\" } from nodes where kind == \"md:section\"'",
    "       query 'select $path, open from docs where nodes collect { ^open: value where kind == \"md:task\" && !attrs.checked }'",
    "       query 'select owner_id, owner: ^nodes single { where kind == \"person\" && attrs.id == ^owner_id } from docs'   # ^docs/^nodes/^blocks/^edges: the repository (the root row) from inside a row; 0^docs from any depth",
    "       query 'docs count { where layer == \"canon\" }'   # scalar; also <target> exists/none/first/single { … } at the top level",
    "       query 'from docs where nodes none { where kind == \"md:task\" && !checked }'   # none = zero rows (≡ !exists; \"every\" = none over the complement)",
    "       query 'from docs where type == \"practitioner\" order by era desc limit 2 offset 1'   # limit/offset bound the set (after order/distinct, before the consumer)",
    "       query 'select fm: entries(frontmatter) collect { k: $key, v: $it } from docs where $path == \"/x.md\"'   # a record as a collection ($key/$it); also entries(attrs), entries(inline)",
    "       query 'select $path values from docs where layer == \"canon\"'   # `values`: bare values, no {id,path} hits (one item only)",
    "       query 'select $path, tags: tags collect { $it values where $it != \"draft\" } from docs'   # $it = the current item (here: each tag)",
    "       query 'docs collect { from nodes where kind == \"md:task\" }'   # `from E` re-projects the source (→ nodes)",
    "       query 'from docs where text(\"philosophers stone\") && layer == \"canon\"'   # full-text prune",
    "       query 'select s: semantic(\"the great work\") from blocks where semantic(\"the great work\") > 0.6'  # embedding score (needs a provider)",
    "       query 'from docs where type == \"practitioner\" order by era desc'   # order by <expr> [asc|desc]",
    "       query 'select t: text, d: $depth, s: $stop from blocks where $id == \"b_x\" follow block.children'   # recursive walk ($depth/$stop metadata)",
    "       query 'from nodes where name == \"Overview\" follow section.subsections { depth 3 }'   # follow [distinct] <rel> [{ where … frontier … depth n by … }]",
    "       query 'select p: $path, d: $depth, s: $stop from docs where $path == \"/index.md\" follow doc.out'   # citation graph (cyclic-safe: $stop=cycle)",
    "       query 'from blocks where type == \"list_item\" && $leaf follow block.children'   # $leaf/$depth/$stop filter the walk result post-walk",
    "       query 'select src: $src, to: $dst_path from edges where predicate == \"depends_on\"'   # the edges target: predicate/provenance/dst_kind + $src/$dst_path/$dst_uri",
];

fn s(x: &str) -> String {
    x.to_owned()
}

fn opts(rows: &[(&str, &str)]) -> Vec<(String, String)> {
    rows.iter().map(|(f, d)| (s(f), s(d))).collect()
}

const ACTOR: (&str, &str) = ("--actor <s>", "commit actor (default human:$USER)");

/// Every command's card, the reference's strings verbatim.
#[allow(clippy::too_many_lines)]
pub fn card(name: &'static str, prog: &str) -> Option<HelpSpec> {
    let spec = |summary: String,
                usage: Vec<String>,
                options: Vec<(String, String)>,
                notes: Vec<String>| HelpSpec {
        name,
        summary,
        usage,
        options,
        notes,
    };
    Some(match name {
        "init" => spec(
            format!(
                "Create an omgbase workspace (.omgbase/ + database) in <dir> (default cwd). Ingests nothing — run `{prog} source add .` next"
            ),
            vec![s(
                "init [<dir>] [--yes] [--embedder <cmd|url> | --no-embedder]",
            )],
            opts(&[
                (
                    "-y, --yes",
                    "accept the prompts (.gitignore entry, embedder offer) non-interactively",
                ),
                (
                    "--embedder <cmd|url>",
                    "set the embedding provider verbatim (optional; enables semantic search)",
                ),
                ("--no-embedder", "skip the embedder offer entirely"),
            ]),
            vec![],
        ),
        "source" => spec(
            s(
                "Where a repo's bytes come from (a filesystem directory today; git/S3/… via adapters later)",
            ),
            vec![s("source <add|list|attach|detach|rm> …")],
            opts(&[
                (
                    "add <dir> [--repo <slug>] [--name <n>] [-y]",
                    "point a repo at a directory: creates the repo (named after the dir unless --repo) + runs the initial sync (-y skips the consent prompt)",
                ),
                ("list", "list sources and which repos they feed"),
                (
                    "attach <name> [--repo <slug>]",
                    "attach an existing source to a repo",
                ),
                (
                    "detach <name> [--repo <slug>]",
                    "detach a source from a repo",
                ),
                ("rm <name>", "delete a source (and its attachments)"),
            ]),
            vec![],
        ),
        "repos" => spec(
            s(
                "List the repos in this workspace: slug, root path (from its fs source), doc/block counts",
            ),
            vec![s("repos [--ids|--json|--jsonl]")],
            opts(&[
                ("--ids", "slugs only, one per line"),
                (
                    "--json",
                    "the `repos` tool's result: `{ repos: [{ slug, hasSource }] }` (counts are `status --json`)",
                ),
            ]),
            vec![],
        ),
        "status" => spec(
            s(
                "Where am I: the active repo, doc/block/commit counts, sync convergence, watcher, embed queue",
            ),
            vec![s("status [--repo <slug>] [--json]")],
            opts(&[(
                "--json",
                "the repos_status result, plus `sync` (the sync_status result), `watcher` (live|none) and `embedQueue` (stale embeddable blocks)",
            )]),
            vec![],
        ),
        "ls" => spec(
            s(
                "List live documents: path, block count, last-commit time (always the complete listing)",
            ),
            vec![s("ls [<glob>] [--ids|--json|--jsonl]")],
            opts(&[
                (
                    "<glob>",
                    "path filter; `*` matches any run of characters (`notes/*.md`)",
                ),
                ("--ids", "paths only, one per line (pipe fuel)"),
            ]),
            vec![],
        ),
        "outline" => spec(
            s(
                "A document's outline with block ids inline (frozen wire format) — the orientation view",
            ),
            vec![s("outline <doc|path> [--depth <n>] [--skeleton]")],
            opts(&[
                ("--depth <n>", "limit heading depth"),
                ("--skeleton", "structure only, no text"),
            ]),
            vec![],
        ),
        "cat" => spec(
            s(
                "Content bytes of a node — exact raw bytes by default, pipe-clean (`show` is the metadata card)",
            ),
            vec![s(
                "cat <node…|-> [--resolution raw|text|outline|skeleton|full]",
            )],
            vec![
                (
                    s("<node…>"),
                    s(
                        "one or more refs: a block id (`b_…`), a doc id (`d_…`), a node id (`n_…`), or a doc path (`/notes/x.md`; the leading `/` is optional)",
                    ),
                ),
                (
                    s("-"),
                    format!(
                        "read refs from stdin, one per line (`{prog} q … --ids | {prog} cat -`)"
                    ),
                ),
                (
                    s("--resolution <r>"),
                    s(
                        "block refs only: raw (default: exact bytes) | text | outline | skeleton | full; a document is always its exact bytes (warns if given)",
                    ),
                ),
            ],
            vec![],
        ),
        "show" => spec(
            s(
                "Metadata card for a node: attrs, placement, open edges, last change (`cat` is the bytes)",
            ),
            vec![s("show <node…|-> [--include history]")],
            vec![
                (
                    s("<node…>"),
                    s(
                        "one or more refs: a block id (`b_…`), a doc id (`d_…`), a node id (`n_…`), or a doc path (`/notes/x.md`; the leading `/` is optional)",
                    ),
                ),
                (
                    s("-"),
                    format!(
                        "read refs from stdin, one per line (`{prog} q … --ids | {prog} show -`)"
                    ),
                ),
                (
                    s("--include <list>"),
                    s("comma-separated extras; `history` adds the block's last 5 changes"),
                ),
            ],
            vec![],
        ),
        "find" => spec(
            s(
                "Resolve a name/title/concept to ranked hits — full-text, fused with the embedding index when a provider is configured",
            ),
            vec![s("find <text> [-n <N>] [-1] [-v] [--no-semantic]")],
            vec![
                (s("-n <N>"), s("max hits (default 10)")),
                (
                    s("-1"),
                    format!(
                        "print only the top hit's id (`{prog} cat $({prog} find \"risks\" -1)`)"
                    ),
                ),
                (s("-v, --verbose"), s("print per-hit evidence")),
                (
                    s("--no-semantic"),
                    s("full-text only; skip the embedding provider even if one is configured"),
                ),
            ],
            vec![],
        ),
        "query" => spec(
            s(
                "Composable OQX query: from <docs|blocks|nodes|edges> where … select … [order by …] [follow …] (alias: q)",
            ),
            vec![
                s("query <source> [-n <N>] [--cursor <c>] [--ids|--json|--jsonl]"),
                s("query -f <file|-> [-n <N>] [--cursor <c>]"),
            ],
            vec![
                (
                    s("<source>"),
                    s("the OQX query text (quote it); `from` may be omitted inside blocks"),
                ),
                (
                    s("-f <file|->"),
                    s("read the query from a file, or stdin with `-`"),
                ),
                (s("-n <N>"), s("page size")),
                (s("--cursor <c>"), s("continue a truncated result")),
                (
                    s("--ids"),
                    format!("bare ids, one per line — pipe fuel (`… --ids | {prog} cat -`)"),
                ),
            ],
            vec![
                format!(
                    "semantic ranking: `order by semantic(\"phrase\") desc` or `where semantic(\"phrase\") > 0.6` (needs embedding.provider; see `{prog} embed --help`)."
                ),
                s(
                    "full syntax: the examples below, the MCP `query_syntax` tool, and docs/query-language.md.",
                ),
                s("examples:"),
            ],
        ),
        "run" => spec(
            s(
                "Evaluate the ```omg fence (an OQX query) at a locator — or the first fence in a document — and print its results",
            ),
            vec![s("run <locator|path> [--ids|--json|--jsonl]")],
            opts(&[(
                "<locator|path>",
                "a fence block's locator, or a document whose first ```omg fence is run",
            )]),
            vec![s(
                "Strictly read-and-print: fences stay inert in the corpus; nothing is projected or written.",
            )],
        ),
        "log" => spec(
            s("What changed: one digest per commit, newest first"),
            vec![s(
                "log [--since <24h|7d|ISO>] [--cursor <n>] [--origin api|observed] [-n <N>]",
            )],
            opts(&[
                (
                    "--since <t>",
                    "only commits after a relative age (24h, 7d) or an ISO timestamp",
                ),
                ("--cursor <n>", "continue from a commit sequence number"),
                (
                    "--origin <o>",
                    "api (agent/CLI writes) | observed (file edits picked up by sync)",
                ),
                ("-n <N>", "max commits"),
            ]),
            vec![],
        ),
        "hist" => spec(
            s("A block's change biography: every commit that touched it"),
            vec![s("hist <node> [-n <N>]")],
            opts(&[("-n <N>", "max changes")]),
            vec![],
        ),
        "diff" => spec(
            s("Unified diff of a document between two revisions (default: previous → current)"),
            vec![s("diff <doc> [--from <rev>] [--to <rev>] [--blocks]")],
            opts(&[
                (
                    "--from <rev>",
                    "older revision id (default: the one before --to)",
                ),
                ("--to <rev>", "newer revision id (default: current)"),
                (
                    "--blocks",
                    "block-grain: which blocks were added, removed or changed (the `diff` tool)",
                ),
            ]),
            vec![],
        ),
        "links" => spec(
            s("Open edges touching a node, grouped by predicate (both directions by default)"),
            vec![s("links <node> [--in|--out] [--pred <p,p>] [--blocks]")],
            opts(&[
                ("--in", "incoming edges only (backlinks)"),
                ("--out", "outgoing edges only"),
                ("--pred <p,p>", "keep only these predicates"),
                ("--blocks", "block-grain edges (default: doc-grain)"),
            ]),
            vec![],
        ),
        "apply" => spec(
            s(
                "Apply a raw changeset (`{ ops: [...] }`, the six-op kernel) — the primitive every other mutator expands to",
            ),
            vec![s(
                "apply [-f <changeset.json|->] [--reason <s>] [--actor <s>] [--dry-run]",
            )],
            opts(&[
                (
                    "-f <file|->",
                    "changeset JSON from a file or stdin (default: stdin)",
                ),
                ("--reason <s>", "commit reason recorded in history"),
                ACTOR,
                ("--dry-run", "validate + render the diff, commit nothing"),
            ]),
            vec![],
        ),
        "insert" => spec(
            s("Insert markdown as new block(s) under a parent block or heading"),
            vec![s(
                "insert <to> (-m <markdown> | -f <file> | -) [--at end|start|before <id>|after <id>] [--expect <parent_children_hash>] [--actor <s>] [--dry-run]",
            )],
            opts(&[
                (
                    "<to>",
                    "parent block id, or a heading block id to append into its section",
                ),
                ("-m <markdown>", "content inline"),
                ("-f <file>", "content from a file"),
                ("-", "content from stdin"),
                (
                    "--at <pos>",
                    "end (default) | start | before <id> | after <id>",
                ),
                (
                    "--expect <hash>",
                    "destination CAS: fail with stale_expectation unless the parent's direct child ids (joined by \",\", sha256 hex) still hash to this",
                ),
                ACTOR,
            ]),
            vec![],
        ),
        "update" => spec(
            s(
                "Replace a block's markdown (b_… target), or reconcile a whole document from complete new bytes (doc id/path)",
            ),
            vec![s(
                "update <block|doc> (-m <markdown> | -f <file> | -) [--plan] [--expect <hash>] [--reason <s>] [--actor <s>] [--dry-run]",
            )],
            opts(&[
                ("-m <markdown>", "content inline"),
                ("-f <file>", "content from a file"),
                ("-", "content from stdin"),
                (
                    "--plan",
                    "(doc) print the reconciliation opset — identity effects + summary — and commit nothing",
                ),
                (
                    "--expect <hash>",
                    "(block) fail with stale_expectation unless the block's hash still matches",
                ),
                ("--reason <s>", "commit reason recorded in history"),
                ACTOR,
            ]),
            vec![],
        ),
        "edit" => spec(
            s(
                "Open a block's markdown in $EDITOR and write it back with compare-and-swap pinned to what you saw",
            ),
            vec![s("edit <block> [--actor <s>] [--dry-run]")],
            opts(&[ACTOR]),
            vec![],
        ),
        "move" => spec(
            s("Move block(s) under a new parent, identity preserved"),
            vec![s(
                "move <blocks…|-> --to <parent> [--at end|start|before <id>|after <id>] [--expect <parent_children_hash>] [--actor <s>] [--dry-run]",
            )],
            opts(&[
                (
                    "<blocks…>",
                    "block ids; `-` reads them from stdin, one per line",
                ),
                ("--to <parent>", "destination parent block"),
                (
                    "--at <pos>",
                    "end (default) | start | before <id> | after <id>",
                ),
                (
                    "--expect <hash>",
                    "destination CAS: fail with stale_expectation unless the destination's direct child ids (joined by \",\", sha256 hex) still hash to this",
                ),
                ACTOR,
            ]),
            vec![],
        ),
        "rm" => spec(
            s(
                "Remove block(s) (the resurrection pool catches regret), or delete a whole document with --doc",
            ),
            vec![
                s("rm <blocks…|-> [--actor <s>] [--dry-run]"),
                s("rm --doc <doc> [--actor <s>] [--dry-run]"),
            ],
            opts(&[
                (
                    "<blocks…>",
                    "block ids; `-` reads them from stdin, one per line",
                ),
                (
                    "--doc <doc>",
                    "delete a whole document (id or path) — always explicit",
                ),
                ACTOR,
            ]),
            vec![],
        ),
        "done" => spec(
            s("Check (or uncheck) task blocks"),
            vec![s("done <blocks…|-> [--undo] [--actor <s>] [--dry-run]")],
            vec![
                (
                    s("<blocks…>"),
                    format!(
                        "task block ids; `-` reads them from stdin (`{prog} q … --ids | {prog} done -`)"
                    ),
                ),
                (s("--undo"), s("uncheck instead")),
                (s(ACTOR.0), s(ACTOR.1)),
            ],
            vec![],
        ),
        "append" => spec(
            s("Append markdown at the end of a heading's section"),
            vec![s(
                "append <heading> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]",
            )],
            opts(&[
                (
                    "<heading>",
                    "the heading block (id or locator) whose section receives the content",
                ),
                ("-m <markdown>", "content inline"),
                ("-f <file>", "content from a file"),
                ("-", "content from stdin"),
                ACTOR,
            ]),
            vec![],
        ),
        "retarget" => spec(
            s(
                "Rewrite every link that points at <from> to point at <to> — plan-by-default, --apply commits",
            ),
            vec![s(
                "retarget <from> <to> [--scope <glob>] [--apply] [--actor <s>] [--dry-run]",
            )],
            opts(&[
                (
                    "--scope <glob>",
                    "only rewrite links in documents matching the path glob",
                ),
                (
                    "--apply",
                    "commit the rewrite (default: print the plan only)",
                ),
                ACTOR,
            ]),
            vec![],
        ),
        "node" => spec(
            s(
                "Edit a projected node's editable properties surgically (a link's target, a task's checked, …)",
            ),
            vec![
                s("node set <nodeId> <prop> <value> [--actor <s>] [--dry-run]"),
                s("node props <nodeId>"),
            ],
            opts(&[
                (
                    "set",
                    "rewrite one property; the adapter maps it back onto the source block",
                ),
                (
                    "props",
                    "list which properties of this node's kind are editable",
                ),
                ACTOR,
            ]),
            vec![],
        ),
        "split" => spec(
            s("Split a block at character offset(s) into sibling blocks"),
            vec![s("split <block> --at <n[,n…]> [--actor <s>] [--dry-run]")],
            opts(&[
                (
                    "--at <n[,n…]>",
                    "character offset(s) within the block's markdown",
                ),
                ACTOR,
            ]),
            vec![],
        ),
        "merge" => spec(
            s("Merge adjacent blocks into the first (the first block's identity survives)"),
            vec![s("merge <blocks…|-> [--sep <s>] [--actor <s>] [--dry-run]")],
            opts(&[
                (
                    "<blocks…>",
                    "two or more adjacent block ids; `-` reads them from stdin",
                ),
                ("--sep <s>", "separator placed between the merged texts"),
                ACTOR,
            ]),
            vec![],
        ),
        "new" => spec(
            s("Create a document at <path> from complete file bytes (frontmatter included)"),
            vec![s(
                "new <path> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]",
            )],
            opts(&[
                ("-m <markdown>", "content inline"),
                ("-f <file>", "content from a file"),
                ("-", "content from stdin"),
                ACTOR,
            ]),
            vec![],
        ),
        "mv" => spec(
            s(
                "Rename/move a document to a new path; its identity and history are preserved and inbound links follow it",
            ),
            vec![s(
                "mv <doc> <new-path> [--no-retarget] [--actor <s>] [--dry-run]",
            )],
            opts(&[
                (
                    "--no-retarget",
                    "leave the inbound links as written (they dangle; fix later with retarget)",
                ),
                ACTOR,
            ]),
            vec![],
        ),
        "meta" => spec(
            s("Surgical frontmatter patch: set/unset keys without touching the body"),
            vec![s(
                "meta <doc> [--set k=v]… [--set-json k=<json>]… [--unset k]… [--actor <s>] [--dry-run]",
            )],
            opts(&[
                ("--set k=v", "set a string value (repeatable)"),
                (
                    "--set-json k=<json>",
                    "set a typed value from JSON (repeatable)",
                ),
                ("--unset k", "remove a key (repeatable)"),
                ACTOR,
            ]),
            vec![],
        ),
        "shell" => spec(
            s(
                "A persistent session: one open workspace across commands, and results become typed bindings (@1/@_/@name)",
            ),
            vec![s("shell [--prompt <str>] [--server <cmd|url>]")],
            opts(&[
                (
                    "--prompt <str>",
                    "emit <str> before reading each piped line so a driver (e.g. recital) can sync on it; also $OMG_SHELL_PROMPT (--prompt wins)",
                ),
                (
                    "--server <cmd|url>",
                    "run every line against a remote engine over MCP",
                ),
            ]),
            vec![s(
                "Interactive on a TTY (type `?` for binding help, `exit` to leave); a script runner when stdin is piped (one command per line).",
            )],
        ),
        "sync" => spec(
            s(
                "Reconcile a repo with its filesystem source (one-shot by default; the explicit form of the freshness sweep every read runs)",
            ),
            vec![
                s("sync [--watch]"),
                s("sync --server <cmd|url> [-H \"Name: value\"]… [--root <dir>] [--out]"),
            ],
            opts(&[
                ("--watch", "stay live and reconcile edits as they land"),
                (
                    "--server <cmd|url>",
                    "mirror a local directory into a remote engine over MCP: an http(s) url connects over Streamable HTTP; anything else is spawned as a stdio MCP server command",
                ),
                (
                    "-H \"Name: value\"",
                    "(--server url only) extra HTTP header, repeatable",
                ),
                (
                    "--root <dir>",
                    "(--server) the directory to mirror (default cwd)",
                ),
                (
                    "--out",
                    "(--server) also export engine-authored changes back to disk",
                ),
            ]),
            vec![],
        ),
        "mcp" => spec(
            s(
                "Serve the MCP tool surface on stdio for an MCP host (Claude Code, Cursor, …); the host owns the process lifetime",
            ),
            vec![s("mcp [-C <workspace-dir>] [--repo <slug>] [--no-watch]")],
            opts(&[
                (
                    "-C <dir>",
                    "the workspace to serve — a directory at or below one containing .omgbase/ (the host rarely starts you inside it)",
                ),
                (
                    "--repo <slug>",
                    "which repo, when the workspace has several",
                ),
                (
                    "--no-watch",
                    "don't run the in-process file watcher (it is auto-off when another live watcher holds the lease)",
                ),
            ]),
            vec![format!(
                "host config: {{\"command\": \"{prog}\", \"args\": [\"mcp\", \"-C\", \"/path/to/notes\"]}}"
            )],
        ),
        "rebuild-index" => spec(
            s(
                "Rebuild derived tables from the authoritative docs/blocks (safe any time; never touches content or history)",
            ),
            vec![s(
                "rebuild-index [--sections|--edges|--fts|--block-changes|--all]",
            )],
            opts(&[
                ("--sections", "section spans"),
                ("--edges", "the link graph"),
                ("--fts", "the full-text index"),
                ("--block-changes", "the per-block change log"),
                ("--all", "everything (default)"),
            ]),
            vec![],
        ),
        "gc" => spec(
            s(
                "Mark-and-sweep unreferenced blobs and tree nodes (refuses unless gc.enabled is set in repo settings)",
            ),
            vec![s("gc [--dry-run]")],
            opts(&[(
                "--dry-run",
                "report what would be swept, sweep nothing (allowed even when gc is disabled)",
            )]),
            vec![],
        ),
        "doctor" => spec(
            s(
                "Invariant sweep: convergence, FTS rows vs live leaf blocks, dangling revisions, SQLite integrity — exit 1 on any failure (CI-able)",
            ),
            vec![s("doctor [--json]")],
            opts(&[("--json", "`{ ok, checks: [{ name, ok, detail }] }`")]),
            vec![],
        ),
        "config" => spec(
            s(
                "Read/write settings — one schema at two layers: workspace defaults, overridable per repo",
            ),
            vec![
                s("config [list]"),
                s("config get <key>"),
                s("config set <key> <value>"),
            ],
            opts(&[
                (
                    "list",
                    "show the effective settings (default); at repo scope, overrides are marked",
                ),
                (
                    "get <key>",
                    "print one effective value (dotted path, e.g. embedding.provider)",
                ),
                (
                    "set <key> <value>",
                    "write a value at the selected layer (true/false/null/numbers are typed)",
                ),
                ("--repo <slug>", "target a repo's layer"),
                (
                    "--repo \"\"",
                    "target the workspace layer (what every repo inherits)",
                ),
            ]),
            vec![format!(
                "e.g. {prog} config set embedding.provider omgbase-embedder --repo \"\""
            )],
        ),
        "embed" => spec(
            s(
                "The embedding queue: report the provider + what is queued, or drain it to embed now",
            ),
            vec![s("embed [status]"), s("embed drain [--verbose] [--prune]")],
            opts(&[
                (
                    "status",
                    "(default) provider, model, and how many blocks/docs are embeddable but not yet embedded",
                ),
                (
                    "drain",
                    "embed the queued blocks now — status alone makes no progress",
                ),
                ("-v, --verbose", "(drain) per-batch progress"),
                (
                    "--prune",
                    "(drain) afterwards delete vectors left by other models (e.g. after switching models)",
                ),
            ]),
            vec![format!(
                "needs embedding.provider (`{prog} config set embedding.provider omgbase-embedder --repo \"\"`); without one, semantic search is simply off."
            )],
        ),
        "version" => spec(
            s(
                "Which engine and which versions: the binary, its components, the specs it implements, the schema, MCP protocol, runtime, build",
            ),
            vec![s("version [--json]")],
            opts(&[("--json", "the `version` tool result verbatim")]),
            vec![s(
                "with --server, the remote engine's answer (typescript or rust)",
            )],
        ),
        _ => return None,
    })
}
