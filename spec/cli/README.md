# The omgbase CLI specification

`omg` is the engine's second client: the same operation catalog the MCP
server serves (`spec/surface` §4), rendered as terminal verbs.
`docs/surface-map.md` is the bijection between the two; this directory pins
what a second implementation of the *verbs* must reproduce — the argv
grammar, the bytes on stdout and stderr, and the exit code — so that a Rust
`omgbase` binary behaves like the reference `omg` down to the byte in every
pinnable situation, and so that the situations that cannot be pinned (a
watcher's timing, a spawned editor's TTY, an embedder's availability) are
named rather than left to chance. It is owned by neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `omgbase` / `omg` (TypeScript, npm `omgbase`) | `packages/cli/src/{main,dispatch,context,commands,output,render,style,seams}.ts`, `packages/cli/src/cmd/*.ts`, `packages/cli/src/shell/*.ts` | **Reference.** |
| `omgbase` (Rust binary, crates.io) | `crates/omgbase/src/cli/{mod,argv,context,output,render,help,commands,seams}.rs`, `cli/cmd/*.rs`, `cli/shell/*.rs` | Conformance-first port: every verb rendered over `omgbase-surface`, `omgbase-sync`, `omgbase-store` (0.5.0, 2026-09-27; `crates/omgbase/tests/cli_spec.rs` runs every case, `tests/remote.rs` proves `--server` against the reference server both ways). |

The spec is two artifacts, versioned together by `VERSION`: this `README.md`
and `cases/*.json`. **When prose and fixtures disagree, the fixtures win**,
and the prose gets fixed. Rationale: `docs/cli.md` (the as-built design
document; where it and the fixtures disagree, §9 records the difference),
`docs/surface-map.md`.

## Versioning

`VERSION` is `<major>.<minor>`; the `omgbase` npm package and the `omgbase`
crate track it. A verb or flag added bumps the minor; a verb or flag removed,
or an output changed in meaning (a line that used to mean one thing now
means another, an exit code or error code changed, a JSON key renamed), bumps
the major. A change of *bytes* that keeps the meaning (a reworded hint) is a
minor with the fixtures regenerated. The library result shapes the CLI
prints verbatim belong to `spec/surface` (and `spec/mutate`, `spec/sync`);
this spec only says which of them a verb prints.

## The rule for changing the CLI

**Fixture first, TypeScript (reference) second, Rust third.** A verb, flag or
rendering change without a case under `cases/` is not done. §9 records the
reference oddities surfaced while specifying and the decisions taken.

## 1. What is pinned

The reference runs as a Node process; the spec pins the process boundary and
nothing inside it:

- **argv** — which arguments are accepted, where, and what a wrong one does;
- **stdout** — the exact bytes (every case compares them);
- **stderr** — the exact bytes when the case pins them: every error, and
  every diagnostic a case marks `pin_stderr` (confirmations, footers,
  warnings); otherwise unpinned;
- **exit code** — always;
- **the workspace after a write** — indirectly, through the read that
  follows it in a `steps` sequence.

Everything is pinned in the **plain** rendering tier (§3.3): `--no-color`
and `NO_COLOR=1`, stdout not a TTY. The `basic` and `rich` tiers (ANSI
colors, Unicode and Nerd Font glyphs, the gradient wordmark) are the same
text with styling applied and are not pinned; a port may render them as it
likes as long as its plain tier is exact.

## 2. The invocation model

### 2.1 Workspace discovery and repo selection

The **workspace** is the nearest directory at or above the current directory
(after `-C`) that contains a `.omgbase/` directory; its database is
`<workspace>/.omgbase/omgbase.db` (`spec/sync` §1). With no such directory,
every command that needs one fails:

```
error[repo_not_found]: no omgbase workspace found at or above <cwd>
  hint: run `omg init` to create one here, or `omg -C <dir> …` to run inside an existing workspace
```

(exit 1; `--json` prints `{"error":"repo_not_found","message":…,"hint":…,"retriable":false}`
— the same hint, as a field). `<cwd>` is the resolved absolute path (macOS's `/var`
is printed as `/private/var`). `mcp` tailors the hint (§6 `mcp`).

**Repo selection** is `spec/sync` §1: `--repo <slug>` names one (an unknown
slug is `repo_not_found` with `data: { candidates: [<every slug>] }`,
message `no repo with slug '<slug>'`); else a workspace with exactly one
repo selects it whatever the cwd; else the repos whose root contains the cwd
— one selects it, none is `repo_not_found` with the message
`no repo contains <cwd>; select one with --repo` and every slug as
`candidates` (an empty list in a workspace with no repo), several selects the
deepest root. The human error prints the payload pretty-printed under the
message (§3.5). `config` treats the selection specially (§6 `config`).

### 2.2 argv

The first token that does not start with `-` is the command; a command name
or alias is resolved against the catalog (§5). **Global flags are recognized
anywhere in argv** — before or after the command — and consumed before the
command sees its arguments:

| Flag | Meaning |
| --- | --- |
| `-C <dir>`, `--directory <dir>` | run as if from `<dir>` (resolved against the process cwd) |
| `--repo <slug>` | select the repo |
| `--server <cmd\|url>`, `-H <"Name: value">`, `--header …` | run against a remote engine over MCP (§2.3) |
| `--json`, `--jsonl`, `--ids` | the output mode (§3.2); the last one given wins |
| `--stale` | skip the freshness sweep (§3.7) |
| `--no-color` | the plain tier (§3.3) |
| `--dry-run` | validate, render diffs, commit nothing (§3.6) |
| `--help`, `-h` | the command's help card (§5), or the catalog with no command |
| `--version`, `-V` | the version, exit 0 |

Everything after a literal `--` is passed to the command untouched (the `--`
itself is passed too and dropped by the command's own parser). A global flag
whose value is missing is a usage error (§3.5: `usage: ` prefix, exit 2):
`-C requires a directory`, `--repo requires a slug`,
`--server requires a command or url` (also for an **empty** `--server ""`),
`-H requires a "Name: value" header`. An unrecognized flag **before** the
command is `usage: unknown flag <flag>` (exit 2); after the command it
belongs to the command. The rest of argv is still parsed, so a `--json`
anywhere selects the mode the error is rendered in.

**Per-command options** are parsed by the command with `node:util`'s
`parseArgs` semantics: `--name value`, `--name=value`, short `-n value`,
booleans without a value, positionals anywhere. An option the command does
not declare, a value-taking option without its value, or a boolean given
one, is a usage error (exit 2) with the hint
`run '<prog> <command> --help' for the options`:

```
usage: unknown option '--scope'
usage: option '--depth' requires a value
usage: option '--json' does not take a value
  hint: run 'omg outline --help' for the options
```

(the option is quoted as written — `--depth`, `-x`; an option with a short
alias by its long spelling). The content-bearing options `-m/--message` and `-f/--file` (and their `=`
forms) are extracted before `parseArgs` so a value beginning with `-`
(`-m '- [ ] task'`) is taken verbatim.

### 2.3 `--server`

`--server` runs a command against a remote engine over MCP; the set of
commands that accept it is `REMOTE_OK` = { `sync`, `query`, `outline`, `hist`,
`cat`, `ls`, `diff`, `find`, `log`, `new`, `mv`, `meta`, `rm`, `update`,
`retarget`, `apply`, `insert`, `move`, `split`, `merge`, `done`, `append`,
`node`, `shell` }. Any other command given `--server` (unless `--help`) is
the usage error, exit 2:

```
usage: --server is not supported for '<name>' — it needs local ref resolution or a working tree; run it against a local workspace
```

`-H` with a non-`http(s)` server is `usage: -H/--header only applies to an http(s) --server url`;
a header without a colon is `usage: invalid header "<h>" — expected "Name: value"`.
An **empty** `--server ""` is the missing-value usage error of §2.2 — the
flag was given, so the command never falls through to the local store.
The remote path itself (spawning or connecting, the tool calls, their
rendering) is **unpinned** here: it is the catalog of `spec/surface` §4 called
from a client, and it needs a second process.

### 2.4 Unknown command

An unrecognized command is a usage error, exit 2, on stderr:

```
usage: unknown command '<name>'
  hint: did you mean '<candidate>'? run '<prog> --help' for the command list
```

The `did you mean` clause is present when some command name or alias is
within *k* Levenshtein edits of the lower-cased name, *k* = 1 when the name
has three characters or fewer, else 2; the closest wins, ties by catalog
order (`statsu` → `status`, `lz` → `ls`, `x` → `q`; `zzzzzz` → no guess, the
hint is then `run 'omg --help' for the command list`). `<prog>` is the name
the binary was invoked as (`omg` or `omgbase`; a bare `node main.js` run says
`omg`). With `--json`/`--jsonl`/`--ids` the error is
`{"error":"usage","message":"unknown command '<name>'","hint":"…","retriable":false}`.

### 2.5 `--version` and help

`--version`/`-V` with no command prints the version and exits 0 before
anything else is looked at — before the seams are validated (§9) and
without a workspace. The version is the **CLI package's** (`omgbase` on
npm: `0.4.0` for this fixture set), not the engine library's — an
implementation prints its own release. No command, or `--help`
with no command, or the command `help`, prints the **catalog** (§5) on
stdout, exit 0. `<command> --help` / `-h`, or `-h <command>`, prints the
command's **card** (§5) on stdout, exit 0, without a workspace and without
the freshness sweep.

### 2.6 The conformance seams

Every verb honors the two environment variables of `spec/surface` §7.1, read
and installed at the entry point before any workspace opens, id is minted or
clock is read:

- `OMGBASE_SPEC_MINTER=sequential` — the fixture minter of `spec/store`
  §2.2 for the process (`d_0, d_1, …`, each prefix from 0, counters fresh at
  process start; a mint that would collide with an id already in the store
  redraws, `spec/store` 13.5). Any other non-empty value is
  `usage: OMGBASE_SPEC_MINTER="<v>": the only value is "sequential" (spec/surface §7.1)`
  with the hint `unset it, or set OMGBASE_SPEC_MINTER=sequential for a conformance run`,
  exit 2 — even for an unknown command (the seams are validated first).
- `OMGBASE_SPEC_CLOCK=<RFC 3339>` — "now" for the process, so every commit
  a verb stamps, every `ts` it reports and every relative time it renders
  (`0s ago`, `--since 24h`) is fixed. Not an instant →
  `usage: OMGBASE_SPEC_CLOCK="<v>": not an RFC 3339 instant (spec/surface §7.1)`,
  hint `e.g. OMGBASE_SPEC_CLOCK=2026-09-27T00:00:00.000Z`, exit 2.

`mcp` additionally announces them on stderr (§6 `mcp`). They are for
conformance runs only; an engine may refuse them outside a test build but
must honor them when it accepts them.

## 3. The output contract

### 3.1 Streams

stdout is data; stderr is everything else: diagnostics (`committed · 1
document touched`, `updating b_309 (CAS pinned from current bytes)`),
progress, the truncation footer, empty-result notes (`no hits`,
`no documents`, `no changes`, `no matches`, `no links`, `no history`,
`no repos attached`, `no sources registered`, `<slug> has no filesystem
source — nothing to sync`), and errors. Every line ends in `\n`; a command
that prints a string not ending in `\n` gets one appended. There are no
exceptions: an empty result leaves stdout empty in every verb.

### 3.2 Modes

Four modes, chosen by the global flags; `human` is the default.

- **human** — the renderings of §4 and §6.
- **`--json`** — the result of the MCP tool the verb maps to (§6 names
  it; `docs/surface-map.md`), verbatim, as one `JSON.stringify` document
  (no spaces, key order as produced) followed by `\n`. Where a verb has no
  tool (`init`, `source`, `gc`, `rebuild-index`, `doctor`, `config`,
  `embed`) §6 gives the CLI shape.
- **`--jsonl`** — when the result has a list (hits, rows, digests, changes,
  entries, repos, sources), one JSON object per line; otherwise the `--json`
  document.
- **`--ids`** — when the result has an id list (hit ids, paths, commit
  ids, slugs, source names, the far nodes of `links`), one per line;
  otherwise the `--json` document.

One rule for every verb: a machine mode never falls back to the human
rendering. So `status --ids`, `outline --jsonl`, `sync --ids`,
`doctor --ids`, `diff --jsonl`, `links --jsonl`, `hist --ids` (a change
carries no id) all print the `--json` document; `cat`/`show` with several
refs stream one object per ref under `--jsonl`.

### 3.3 The plain tier

The reference styles its human output through a three-tier ladder (rich /
basic / plain). Plain is selected by `--no-color`, by `NO_COLOR` set to
anything, by a non-TTY stdout, or by `TERM=dumb`; every case runs plain.
In plain, styling is the identity and the glyphs are ASCII:

| glyph | plain | used by |
| --- | --- | --- |
| ok | `ok` | confirmations, `doctor`, `status` |
| err | `x` | `doctor`, `sync` deletions |
| warn | `!` | `sync` conflicts, `status` |
| live / dead | `*` / `o` | `status` watcher |
| diamond | `*` | `repos`, `source add`, `config` override marker, `status` commits |
| arrow | `>` | the wordmark, `links`, `status` edges |
| doc / block / heading | `[D]` / `[B]` / `#` | `status`, `show` |
| task open / done | `[ ]` / `[x]` | `show` |
| rule | `-` ×40 | the header rule |

The **wordmark** line is `  omgbase  >  <subject>` and the **rule** is two
spaces and forty `-`; together they head `status`, `outline`, `show` (a
document), `sync`, `init` and the catalog. (The outline's own `§`, the task
glyphs `☐`/`☑` inside the outline wire format, `×` in `links`, `⇸`/`→`/`←`
in `source`, `·` and `—` in diagnostics are text, not glyphs: they print the
same in every tier.)

### 3.4 Truncation

A truncated list result prints, on stderr, after the data, exit 0:

```
… truncated; continue with --cursor <cursor>
```

`<cursor>` is the result's cursor verbatim (`query`: the opaque page cursor;
`log`: the commit sequence number; `outline`: the literal word `budget`).
The footer prints in every mode but `--json`, whose document carries
`truncated`/`cursor` itself: human, `--jsonl` and `--ids`, for every verb
(`query --ids`, `log --ids`, `outline --jsonl`, …).

### 3.5 Errors

Every error goes to stderr. A **usage error** (a CLI-level mistake: missing
argument, unknown command, bad `--at`, `--server` misuse) is

```
usage: <message>
  hint: <hint>            (when the error carries one)
```

exit 2; with a machine mode it is
`{"error":"usage","message":…,"hint":…,"retriable":false}` (`hint` omitted
when absent). Every other error — the engine's typed errors (`spec/mutate`
§8 codes, `doc_missing`, `block_missing`, `repo_not_found`,
`semantic_unavailable`, `embedder_failed`, …) and anything else thrown — is

```
error[<code>]: <message>
  hint: <hint>            (when the error carries one)
  <data, JSON.stringify(data, null, 2), every line indented two spaces>   (when data is present and not null)
```

exit 1; with a machine mode
`{"error":<code>,"message":…,"data":<data>,"hint":<hint>,"retriable":false}`
(`data` and `hint` omitted when absent; `retriable` is always `false` at the
top level — a conflict's own `retriable: true` rides inside `data`).
`<code>` is what the MCP catalog reports for the same failure
(`spec/surface` §4's envelope; the reference renders both through one
mapping): a typed error keeps its code; an OQX error and an invalid
`--cursor` are `filter_invalid` (with `data { reason, hint }`); a diff
against an unknown revision is `target_missing` (`data { doc, rev }`); and
anything else — a write on a repo without a working tree
(`mutation requires a rootPath or an explicit docStore`), an unexpected
exception — is the catalog's catch-all `repo_not_found`. An empty payload
(`data: {}`) prints nothing: the message line stands alone.
A conflict (`stale_expectation`) prints its whole current-truth payload so the
retry can be built from it:

```
error[stale_expectation]: content hash mismatch
  {
    "op_index": 0,
    "block": "b_309",
    "expected_content_hash": "00",
    "current": {
      "content_hash": "…",
      "markdown": "…"
    },
    "retriable": true
  }
```

### 3.6 `--dry-run`

`--dry-run` is global. For every block-level mutator (`apply`, `insert`,
`update` on a block, `move`, `rm` on blocks, `done`, `append`, `split`,
`merge`, `node set`, `edit`, `retarget --apply`) it runs the changeset with
`dry_run`, prints `  dry run — <n> file(s) would change, nothing committed`
on stderr, then on stdout, per changed file in result order: the path, the
unified diff of before → after (`spec/surface` §3's Myers diff, `@@` hunks
with three lines of context, no `---`/`+++` header), then an empty line.
`--json` prints the `ApplyResult` with `diffs` and `committed: false`. A
dry run **does** consume minted ids (`spec/surface` §9) — the ids in its
result are the ones the real run would have taken next.

For a whole-document `update`, `--dry-run` (or `--plan`) prints the plan
(§6 `update`). The document verbs `new`, `mv`, `rm --doc` and `meta` run
their operation with `dryRun`: it validates exactly as the real run would
(`doc_missing`, `path_taken`, …) and returns `committed: false` with the
per-file `diffs` it would make — a create is `""` → the bytes, a delete the
bytes → `""`, a rename two entries (the old path emptied, the new path
filled), a `meta` patch the one file before → after — rendered with the same
note, path, unified diff and empty line as above; `--json` prints the
operation's result with `diffs`. Nothing is written or committed. A
`new --dry-run`'s `docId` is the id the real run would mint next (the dry
run consumes it, as a block dry run consumes block ids).

### 3.7 Freshness and locks

Before a command runs (`spec/sync` §4.3), unless `--help`, `--stale`,
`--server`, a live watch lease, or the command is in `SKIP_FRESHNESS` =
{ `sync`, `mcp`, `init`, `source`, `help`, `version`, `shell` } or in
`NO_WORKSPACE_OK` = { `init`, `help`, `version` }, the CLI opens the
workspace, selects the repo (a failing selection is swallowed here — the
command reports its own `repo_not_found` if it needs the repo) and, when the
repo has a root, runs one **freshness sweep** over it. Consequences a case
sees: an out-of-band file edit is visible to the very next command
(`cat`, `outline`, `q`, …) without `sync`; `--stale` answers from the
database and `--stale status --json` reports the drift instead
(`disk.changed`/`deleted`/`untracked`); and **every sweep records a
checkpoint** — an empty one too — so `sync --json`'s `checkpointId` (`cp_n`)
counts the sweeping commands run since the bootstrap (`cp_0`). `shell` skips
the pre-sweep but each line it runs sweeps on its own.

Every write runs under the writer lock of `spec/sync` §7
(`<workspace>/.omgbase/writer.lock`); a watcher holds the watch lease
(`watch.lock`) and `status` reports it (`watcher: live`/`none`). Neither is
observable in a fixture beyond `status`'s `none`.

The commit **actor** of every CLI write defaults to `human:<os username>`
(`--actor` overrides it) — unpinnable, so every fixture passes
`--actor human:spec`.

## 4. Shared renderers

- **id + locator pairing**: `<id>  <locator>` — two spaces, the id first
  (`query` hits, `find` hits, the shell's inspect listing).
- **columns** (`ls`, the query table, `repos`, `source list`): cells padded
  to the widest cell of their column, joined by two spaces, the last column
  unpadded, trailing whitespace removed from every line; a column may be
  right-aligned (`ls`'s counts and times).
- **the query hit table** (`query`, `run`): with no projection, one
  `<id>  <path>` line per hit; with a projection, a header row (`id`,
  `path` — dropped when the projection itself carries `$path` —, then the
  projected keys in first-seen order across the hits), then one row per hit.
  Cells: strings verbatim up to their first newline (a cut is marked `…`),
  numbers and booleans as JavaScript prints them, `null`/absent → empty,
  lists and records as compact JSON; every cell but `id`/`path` is clipped
  to 60 visible characters, the 60th being `…`.
- **the outline wire format** (`outline`): `spec/surface` §2's text
  verbatim, one line per block.
- **commit confirmation** (block mutators): stderr
  `  ok committed · <n> document<s> touched` (`document` for one), stdout
  the ids of `results[*].ids` in order, one per line (duplicates included).
- **document-op confirmation** (`new`/`mv`/`rm --doc`/`meta`): stderr
  `  ok <verb> <path>` (`created` / `moved to` / `deleted` / `patched`),
  stdout the document id.
- **relative time** (`ls`): `<n>s ago` under a minute, then `<n>m ago`,
  `<n>h ago`, `<n>d ago`, computed from "now" (`0s ago` under the pinned
  clock); `—` when the document has no commit.

## 5. Help

The **catalog** (no command / `--help` / `help`), on stdout:

```
  omgbase  >  Open Markdown Graph Base
  ----------------------------------------

  usage: omg [--json|--jsonl|--ids] [-C dir] [--repo slug] <command> [args]

  <group title>
    <name[, alias]> padded to 22   <summary>
    …
  (an empty line after every group)
  run omg <command> --help for details
```

Groups, in order: `bootstrap` (init, source, repos), `orient & read` (status,
ls, outline, cat, show, find), `query` (query, run), `history & links` (log,
hist, diff, links), `mutate` (apply, insert, update, edit, move, rm, done,
append, retarget, split, merge, node), `documents` (new, mv, meta), `session`
(shell), `sync & serve` (sync, mcp), `admin` (rebuild-index, gc, doctor,
config, embed). `help` is unlisted. The exact bytes are
`invoke::help-bare`.

The **card** (`<command> --help`), on stdout:

```
  <name> — <summary>
  usage: omg <usage>
         omg <second usage form>          (when several)
  options:
    <flag padded to the widest>  <description>
    …
    -h, --help  show this help              (always last)

  <notes, one per line>                     (when any; preceded by one empty line)
```

`omg` is the invoked name. Every card's bytes are pinned by
`invoke::help-card-*`; the `query` card is followed by its example lines.
`source` and `node` with no subcommand print their card; `config help`,
`embed help`, `node help` and `source help` print theirs. The help words are
the `--help` flag spelled differently: they are routed before any workspace
is opened or swept, so every card prints from any directory.

## 6. The verbs

Alphabetical. For each: the usage line, the options, what it renders (the
MCP tool / library operation of `docs/surface-map.md`), the human rendering,
the `--json` shape, and the errors. "Exact bytes" points at the cases.

### `append`

`append <heading> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]`
— `sections_append`: the block(s) parsed from the markdown are inserted at
the end of the heading's section (before the next heading of equal or higher
level). `<heading>` is a heading block id (a path or heading *text* is
`block_missing: not a block: <ref>`, §9). Content: `-m`, `-f <file>`, `-f -`
or a bare `-` for stdin, else stdin. Commit confirmation (§4);
`--json` the `ApplyResult`. Missing heading → `usage: append requires a <heading> block`.

### `apply`

`apply [-f <changeset.json|->] [--reason <s>] [--actor <s>] [--dry-run]` —
the primitive: a changeset `{ "ops": [...] }` (`spec/mutate` §4) from `-f
<file>`, `-f -` or stdin, applied as one changeset with
`origin.actor`/`reason`. Placeholders `$n.ids[i]` resolve across ops.
Confirmation (§4); `--json` the `ApplyResult` (a `remove` result carries
`removed`). An empty `ops` prints `  nothing to do` on stderr, exit 0. Not a
changeset → `usage: changeset must have an \`ops\` array`. Kernel errors
(`block_missing`, `stale_expectation`, `not_contiguous`, …) render per §3.5
with the op's payload (`op_index`, …).

### `cat`

`cat <node…|-> [--resolution raw|text|outline|skeleton|full]` — `read_ref`.
Each ref (a block id, doc id, node id or repo-relative path; `-` reads refs
from stdin one per line, a `-` with empty stdin is
`usage: cat requires a <node> (or - to read refs from stdin)`) prints, in
order: a document → its exact bytes (`docs_read`); a block → its raw
markdown, or at `--resolution text|outline|skeleton|full` the `nodes_get`
field `raw ?? text ?? label`. `--resolution` other than `raw` on a document
ref warns on stderr
`  --resolution <r> ignored for <ref>: a document is always its exact bytes (resolutions apply to block refs)`
and prints the bytes. `--json`: one ref → the object, several → an array;
`--jsonl` one object per line (`--ids`: the same document — a read has no
id list); a block's object is `nodes_get` at the resolution
(`{ id, type, raw, content_hash }` at raw), a document's is the `docs_read`
result `{ path, docId, rev, properties: { frontmatter, inline, computed },
content }`. Unknown ref → `doc_missing: no node <ref>` (a `b_` id too, §9).

### `config`

`config [list]` · `config get <key>` · `config set <key> <value>` — the
settings of `spec/sync` §3 at two layers. The layer is the selected repo's
(§2.1); `--repo ""` is the workspace layer; with no resolvable repo (a
workspace with none, or an ambiguous cwd) the layer is the workspace's —
the workspace is what you mean when you are not clearly inside a repo. An
explicit `--repo <unknown>` is still `repo_not_found`.
`list` (default): repo scope prints the **effective** settings,
`  <mark> <key> = <JSON value>` per top-level key with `*` marking a key the
repo's own layer sets (else a space), under the stderr header
`  <slug> (effective; * = overrides workspace default)`; workspace scope
prints `  <key> = <JSON>` under `  workspace defaults`. `--json` prints the
settings object. `get <key>`: the effective value at a dotted path — a
string verbatim, anything else as JSON, an absent key as an empty line
(exit 0). `set <key> <value>`: writes into the layer, coercing `true`,
`false`, `null` and numbers (`/^-?\d+(\.\d+)?$/`), else a string; stderr
`  set <key> (<slug|workspace>)`. Errors: `usage: config get <key>`,
`usage: config set <key> <value>`,
`usage: unknown config subcommand '<sub>' (get|set|list)` with the hint
`run 'omg config --help'`; `--repo <unknown>` is `repo_not_found`.

### `diff`

`diff <doc> [--from <rev>] [--to <rev>] [--blocks]` — `diff_unified`.
`--to` defaults to the document's current revision, `--from` to the one
before it (or the current one again when there is only one → an empty
diff, stderr `  no changes`). Human: the unified diff's lines
(`spec/surface` §3, no header); `--json` the tool's result
`{ doc, path, from, to, diff }` (the reference and the tool share one
function); `--jsonl`/`--ids` the same document. `--blocks` is the
block-grain `diff` tool over the same resolved pair: human one line per
entry, `+ <id>  <first line of after>` (added), `- <id>  <first line of
before>` (removed), `~ <id>  <first line of after>` (changed), none → stderr
`  no changes`; `--json` the entry array
`[{ kind, blockId, before?, after? }]`, `--jsonl` one per line, `--ids` the
block ids. Unknown doc → `doc_missing: no document <ref>`; unknown revision
→ `target_missing: no revision "<rev>" for document <id>` with
`data { doc, rev }`.

### `doctor`

`doctor [--json]` — four checks on the selected repo: `convergence`
(`unconverged === 0`), `fts rows == live leaf blocks` (the rows the index
holds — counted from FTS5's `blocks_fts_docsize` shadow table, since a
`count(*)` on an external-content table answers from `blocks` — against the
live leaf blocks of `spec/search` §1.1: live rows no live row names as
`parent_block`; detail `fts=<n> leaves=<n>`), `no dangling current_rev`,
`sqlite integrity`. Human: `  ok <name>` per passing check,
`  x <name>  (<detail>)` per failing one; exit 1 when any fails. `--json`
(and every non-human mode) `{ ok, checks: [{ name, ok, detail }] }`. The
FTS check holds after a deletion (observed or `rm --doc`) and after
`rebuild-index --fts`.

### `done`

`done <blocks…|-> [--undo] [--actor <s>] [--dry-run]` — `tasks_complete`
(`--undo`: an `update` with `attrs.checked = false`, CAS pinned from the
live row). Every block must be a live `task` block, checked before any op
is built: another type →
`type_mismatch: not a task: <ref> is a <type>` with `data { block, type }`,
nothing committed. Confirmation (§4).

### `edit`

`edit <block> [--actor <s>] [--dry-run]` — read the block's raw markdown,
run the editor on a temp file holding it, then `update` with the hash read
**before** the editor opened as CAS. The editor is `$OMG_EDITOR`, else
`$VISUAL`, else `$EDITOR`, whitespace-split, the file appended as the last
argument; none set → `target_missing: no $EDITOR set (or $VISUAL/$OMG_EDITOR)`;
`$VISUAL`/`$EDITOR` without a TTY on stdout →
`target_missing: edit needs a TTY; set OMG_EDITOR to a non-interactive editor for scripts`
(only `OMG_EDITOR` drives a scripted edit, §9); a non-zero editor exit →
`target_missing: editor exited <n>`. An unchanged file → stderr
`  no changes`, exit 0, nothing committed. A changed file → the commit
confirmation (§4); a concurrent change → `stale_expectation`. Not a block →
`block_missing: not a block: <ref>`. The editor's own TTY interaction is
unpinnable; the fixtures use shell scripts as editors.

### `embed`

`embed [status]` · `embed drain [--verbose] [--prune]` — the embedding
queue. With no `embedding.provider` in the effective settings: stderr
`  no embedding provider configured — set one with \`omg config set embedding.provider <command|url>\` (e.g. omgbase-embedder)`,
exit 0, for both `status` and `drain`; `--json` `{"provider":null,"queued":0}`.
With a provider that cannot start, every semantic path (`embed`, `find`
without `--no-semantic`, `query` with `semantic()`) fails
`embedder_failed` with `data: { provider, reason }` — the `reason` is the
operating system's spawn error text and is **unpinned**. With a working
provider the status figures and the drain depend on the model — unpinned;
`spec/search` pins what is embedded.

### `find`

`find <text> [-n <N>] [-1] [-v] [--no-semantic]` — `resolve` (`spec/search`
§4); the positionals join with a space; `-n` (default 10) is the limit;
hybrid ranking when a provider is configured, FTS-only with `--no-semantic`
or without one. Human: `<id>  <locator>  <preview>` per hit; `-v` adds
`    <evidence as JSON>` on **stderr** under each; none → stderr
`  no matches`. `-1` prints the top hit's id alone (nothing when there is
none). `--ids` the ids; `--json` the hit array; `--jsonl` one hit per line.
No text → `usage: find requires <text>`.

### `gc`

`gc [--dry-run]` — mark-and-sweep (`spec/store` §7). Refuses unless
`gc.enabled` is true in the effective settings:
`error[target_missing]: gc is disabled; set gc.enabled=true (or use --dry-run)`
(§9: the code). `--dry-run` (the command's own or the global flag) is
allowed regardless. Human (stderr) `  swept <b> blobs, <t> tree nodes`;
`--json` `{ blobsSwept, treeNodesSwept }`.

### `help`

See §5.

### `hist`

`hist <node> [-n <N>]` — `history_node` for a block (a document ref, or an
unknown id, is `block_missing: hist needs a block id; got <ref>`). Human,
newest first: `#<seq> <kind>[ (<confidence to 2 decimals>)] <origin> <ts>`;
none → stderr `  no history`. `--json` the change array; `--jsonl` one per
line; `--ids` the same array (a change carries no id).

### `init`

`init [<dir>] [--yes] [--embedder <cmd|url> | --no-embedder]` — creates
`<dir>/.omgbase/omgbase.db` (`<dir>` defaults to the cwd, is created if
missing, and must not already hold a database:
`error[path_taken]: workspace already initialized at <dir>`). Ingests
nothing. Then two offers: inside a git working tree, to add `.omgbase/` to
the closest `.gitignore` (outside one: stderr
`  not inside a git repo — no .gitignore needed for .omgbase/`); and, unless
`--no-embedder`, to set `embedding.provider` — `--embedder <v>` sets it
verbatim (stderr `  embedding.provider = <v> (workspace default)`), else the
offer fires only when `omgbase-embedder` is on `PATH` (TTY prompt, or
`--yes`). Human stdout: the wordmark `initialized`, the rule,
`  ok workspace  <dir>`; stderr then
`  next: omg source add . to point a repo at a directory of files` and, when
no provider ended up set and the offer was made, three lines of provider
guidance (unpinned — they depend on `PATH`). `--json` (every non-human mode)
`{"workspace":"<dir>"}`. The fixtures run outside git with `--no-embedder`;
the prompts, the `.gitignore` write and the `PATH` probe are unpinned.

### `insert`

`insert <to> (-m <markdown> | -f <file> | -) [--at end|start|before <id>|after <id>] [--expect <parent_children_hash>] [--actor <s>] [--dry-run]`
— an `insert` op under the parent block `<to>` at the position (`--at`
parses `end` (default), `start`, `before <id>`, `after <id>`; anything else
is `usage: bad --at '<v>' (use end|start|before <id>|after <id>)`);
`--expect` is the destination-parent CAS of `spec/mutate` §1.2 (a mismatch
is `stale_expectation: parent_children_hash mismatch` with the current hash).
A heading as `<to>` places the block directly after the heading (§9).
Confirmation (§4); `--json` the `ApplyResult`. Missing parent →
`usage: insert requires a <to> parent (block id, or a heading id for section append)`;
unknown → `block_missing: not a block: <ref>`.

### `links`

`links <node> [--in|--out] [--pred <p,p>] [--blocks]` — `docLinks` for the
node's document (a block ref reports its document). Human: `  out` then
`    <predicate> > <node> ×<count>` per outgoing group, `  in (backlinks)`
then `    <node> > <predicate> ×<count>` per incoming group; `--in`/`--out`
alone select a direction (both together mean both); `--pred` keeps the
listed predicates; groups are ordered by node id as text; none → stderr
`  no links`. `--blocks` is block-grain: one row per open edge, ordered by
(predicate, node, block), the source block beside the far node —
`    <predicate> > <node> (<block>)` out, `    <node> (<block>) > <predicate>`
in (`(frontmatter)` for a block-less relation), no count. `--ids` the far
node ids (out, then in); `--json` the
`{ out: [{ predicate, node, kind, count, samples? }], in: [...] }` object
(`--blocks`: `count` is 1, no `samples`, plus `block`); `--jsonl` the same
object (it is not a list). Unknown ref → `doc_missing: no node <ref>`.

### `log`

`log [--since <24h|7d|ISO>] [--cursor <n>] [--origin api|observed] [-n <N>]`
— `changes_since` from a commit sequence cursor. `--since` is resolved
**client-side** to a cursor: a relative age (`/^(\d+)([hdwm])$/`, hours,
days, weeks, 30-day months) or an absolute timestamp becomes an instant
(against the pinned clock), and the cursor is the highest `seq` whose `ts`
is strictly before it (so `--since` equal to every commit's `ts` returns
them all); anything else is
`usage: bad --since '<v>' (use a relative age like 24h or 7d, or an ISO timestamp)`,
exit 2. Human, oldest first: `#<seq> <origin padded to 8> <summary>`
(`observed: <path> — 31 inserted`, `api(<actor>): <path> — 12 edited, 1
inserted`); a commit that wrote no revision names what it did instead: an
observed or api deletion `observed: deleted <path>` /
`api(<actor>): deleted <path>` (the documents whose `deleted_commit` is the
commit, by path), a move `api(<actor>): moved <from> → <to>` (from the
commit's `reason`, `move <from> -> <to>`). None → stderr `  no changes`;
truncated → the footer with the next seq. `--json` the
`{ digests, cursor, truncated, head }` result; `--jsonl` one digest per
line plus the footer; `--ids` the commit ids plus the footer.

### `ls`

`ls [<glob>] [--ids|--json|--jsonl]` — `docs_list`, every page walked. The
glob is a path pattern with `*` matching any run of characters. Human: a
column table of `<path>`, `<n> blocks` (right-aligned), the relative time
(§4, right-aligned); none → stderr `  no documents`. `--ids` the paths;
`--json` the row array `[{ path, blocks, ts }]`; `--jsonl` one row per
line.

### `mcp`

`mcp [-C <workspace-dir>] [--repo <slug>] [--no-watch]` — the MCP server on
stdio (`spec/surface` §4, §7). Pinned: the card; the seam announcements on
stderr when the seams are set —
`[mcp] spec seam: sequential id minter (OMGBASE_SPEC_MINTER=sequential) — conformance run, not for production`
and `[mcp] spec seam: clock pinned to <canonical instant> (OMGBASE_SPEC_CLOCK) — conformance run, not for production`;
and, with no workspace, `repo_not_found` with the tailored hint
`` `omg mcp` serves one workspace: point it there with -C, e.g. {"command": "omg", "args": ["mcp", "-C", "/path/to/notes"]} in the MCP host config — or create one first with `omg init <dir>` and `omg -C <dir> source add .` ``.
`--server` is refused (§2.3). Serving itself is unpinned here (it is the
interop suite of `spec/surface` §7).

### `merge`

`merge <blocks…|-> [--sep <s>] [--actor <s>] [--dry-run]` — a `merge` op:
the blocks' texts joined into the first (with `--sep` between them, else the
kernel's default), the first block's identity surviving. Fewer than two →
`usage: merge requires at least two blocks`; non-adjacent →
`not_contiguous: merge blocks must be contiguous`. Confirmation (§4).

### `meta`

`meta <doc> [--set k=v]… [--set-json k=<json>]… [--unset k]… [--actor <s>] [--dry-run]`
— `docs_set_meta`: `--set` values parse as YAML scalars (`1702` → number,
`true` → boolean), `--set-json` as JSON, `--unset` removes; the body is
untouched; the frontmatter is re-serialized by the engine (a list becomes a
block sequence). Document-op confirmation (§4); `--json`
`{ docId, path, committed }`. Neither `--set` nor `--unset` →
`usage: meta requires --set or --unset`; a value without `=` →
`usage: --set expects k=v, got '<v>'` / `usage: --set-json expects k=json, got '<v>'`.
`--dry-run`: the patched file's diff (§3.6).

### `move`

`move <blocks…|-> --to <parent> [--at …] [--expect <parent_children_hash>] [--actor <s>] [--dry-run]`
— a `move` op (`--at`/`--expect` as `insert`). Confirmation lists the moved
ids. Missing `--to` → `usage: move requires --to <parent>`; no blocks →
`usage: move requires one or more blocks (or - for stdin)`.

### `mv`

`mv <doc> <new-path> [--actor <s>] [--dry-run]` — `docs_move`: the file is
renamed, identity and history preserved. Confirmation (§4) `moved to
<new-path>`; `--json` the `DocMoveResult`
`{ docId, path, committed, dangling: [...], retargeted }`. Inbound links
that named the old path are **not** rewritten; they are listed in
`dangling` and, in human mode, reported on stderr after the confirmation:
`  ! <n> inbound link(s) still name(s) the old path: <path> <block>, …`
(`<path> (frontmatter)` for a block-less relation) then
`  fix: omg retarget /<old path> /<new path> --apply`; nothing when none
dangle. Unknown → `doc_missing: no document <ref>`; taken →
`path_taken: a document already exists at <path>`. `--dry-run`: the rename
as two file diffs (§3.6), then the same dangling note.

### `new`

`new <path> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]` —
`docs_create` from complete file bytes (frontmatter included, `-m`
verbatim). Confirmation (§4) `created <path>`; `--json`
`{ docId, path, committed }`. Existing →
`path_taken: document already exists at <path>` (with the `{}` payload,
§9). `--dry-run`: the would-be file's diff (§3.6), nothing created.

### `node`

`node set <nodeId> <prop> <value> [--actor <s>] [--dry-run]` ·
`node props <nodeId>` — `node_set` / `editablePropsFor`. `props`: human
`  <kind> editable: <p, p>` (or stderr `  <kind> has no editable properties`),
`--json` `{ node, kind, editable }`; unknown node →
`block_missing: no node <id>`. `set`: the value is the remaining positionals
joined by a space; an inedible property →
`node_not_editable: no editor for <kind>.<prop>` with
`data { kind, prop, editable }`; unknown node →
`block_missing: node <id> not found` (`{}` payload). `--actor` is an
option with a value and is parsed as one (it never leaks into the property
value); the commit carries it. No subcommand → the card; `zap` →
`usage: unknown node subcommand 'zap' (set|props)`.

### `outline`

`outline <doc|path> [--depth <n>] [--skeleton]` (alias `ol`) —
`docs_outline`. Human: the wordmark with the document's path, the rule, then
the wire format lines; `--depth` limits heading depth, `--skeleton` is
`resolution: skeleton` (there is no `--section`: an unknown option, §2.2).
`--json` (and every machine mode: the result has neither a list nor ids)
the `OutlineResult` `{ text, truncated }`; a truncated outline prints the
footer with the word `budget` (every mode but `--json`). Unknown →
`doc_missing: no document <ref>`.

### `query` (alias `q`)

`query <source> [-n <N>] [--cursor <c>] [--ids|--json|--jsonl]` ·
`query -f <file|->` — `query` (`spec/surface` §1). The source is the
positionals joined by a space, or the file / stdin. Rendering by the
result's consumer: `count`/`exists`/`none` → the scalar (`13`, `false`,
`true`); a `values` projection → one value per line (strings verbatim,
others as JSON; `--jsonl` all as JSON); otherwise the hit table (§4); no
hits → stderr `  no hits`; truncated → the footer with the cursor. `--ids`
the hit ids; `--jsonl` one hit per line; `--json` the whole `OqxResult`
(`{ hits, truncated, cursor, consumer, count? | exists? | none? | values? }`).
An empty or missing source is
`usage: query requires a <source> (or -f file|-)`, exit 2. An OQX error
(lex, parse, eval) and an invalid `--cursor` are `filter_invalid` — the
OQX message, `data { reason: <message>, hint: "OQX" }`; `invalid cursor`,
`data { reason: "cursor was not issued by query", hint: … }` — as the
`query` tool reports them; an unknown root is silently empty (§9).
`semantic(...)` without a provider →
`error[semantic_unavailable]: semantic(...) needs an embedding provider`
with the hint `omg config set embedding.provider <command|url>`.

### `rebuild-index`

`rebuild-index [--sections|--edges|--fts|--block-changes|--all]` — rebuilds
one derived family or all (default); human: stderr
`  ok rebuilt <sections|edges|fts|block_changes|all>`, nothing on stdout;
every machine mode `{"rebuilt":"<target>"}` on stdout (the library call
returns nothing; the CLI names what it rebuilt).

### `repos`

`repos [--ids|--json|--jsonl]` — the `repos` tool. Human: a column table
of `  * <slug>`, the root (or `(no source)`), and the `repos_status` counts
`<n> docs`, `<n> blocks`; none → stderr `  no repos attached`. `--json` the
tool's result `{ repos: [{ slug, hasSource }] }` (the counts are
`status --json`); `--jsonl` one repo per line; `--ids` the slugs. Needs a
workspace, not a repo.

### `retarget`

`retarget <from> <to> [--scope <glob>] [--apply] [--actor <s>] [--dry-run]`
— `links_retarget`, **plan by default**: without `--apply` it prints, per
hit, the block id then the unified diff of the block's old and new raw
(`spec/surface` §3's diff, the one every preview prints), then an empty
line, under the stderr note
`  plan — <n> block(s) would change; re-run with --apply to commit`; no hits →
stderr `  no blocks reference <from>`. `--json` the plan
`{ from, to, hits: [{ block, path, oldRaw, newRaw }] }`. `--apply` commits
through the block confirmation (§4) and honors `--dry-run` like any block
mutator. Targets are compared as written: `/texts/x.md` for a Markdown
link, `salt` for a wikilink. `--scope` is a path glob over the documents
searched.

### `rm`

`rm <blocks…|-> [--actor <s>] [--dry-run]` · `rm --doc <doc> [--actor <s>] [--dry-run]`
— a `remove` op (confirmation lists the removed ids; `--json`'s result
carries `removed`), or with `--doc` `docs_delete` (document-op confirmation
`deleted <path>`; `--json` `{ docId, path, committed }`; the file leaves the
tree; `--dry-run` renders the file's removal, §3.6). Neither →
`usage: rm requires one or more blocks (or - for stdin), or --doc`.

### `run`

`run <locator|path> [--ids|--json|--jsonl]` — evaluates the first
```` ```omg ```` fence of a document (or the fence at a block id) as an OQX
source with `query`'s renderer (§6 `query`), read-only. Errors: no fence →
`target_missing: no \`\`\`omg fence in <ref>`; a block that is not a fence →
`opaque_block: block <id> is not an omg fence`; an empty fence →
`target_missing: the omg fence in <ref> is empty`; unknown →
`doc_missing: no node <ref>`.

### `shell`

See §7.

### `show`

`show <node…|-> [--include history]` — the metadata card. A document: the
wordmark with its path, the rule, `  properties` and
`    <key> = <value>` (strings verbatim, else JSON) for every merged property
including the computed `$title`, then `  out edges` / `  backlinks` as
`links` renders them (each section only when non-empty). A block:
`  <type glyph> <type>  <id>`, the rule,
`  placement  parent=<id|—> ordinal=<n> depth=<n>`, `  attrs` with
`    <k> = <v>` lines when any, `  text  <text>` when any, and with
`--include history` `  history` then `    #<seq> <kind> <origin> <ts>` for the
last five changes. Several refs print one card after another. `--json`: a
block's `nodes_get` at `full` (+ `history` when included); a document's the
`read_ref` result `{ kind: "document", path, docId, rev, properties:
{ frontmatter, inline, computed }, content }` (the card's merged properties
and edges are the human rendering only); one ref → the object, several →
an array; `--jsonl` one object per line; `--ids` the same as `--json`.

### `source`

`source <add|list|attach|detach|rm> …` — the source registry of `spec/sync`
§2. `add <dir> [--repo <slug>] [--name <n>] [-y]`: `<dir>` must exist
(`target_missing: no such directory: <abs>`); the repo is `--repo` or the
directory's basename, the source `--name` or `<slug>-fs` (an existing name is
`path_taken: a source named '<n>' already exists`); it creates the repo,
registers and attaches the source, runs the initial freshness sweep and
rebuilds the stat cache; stdout `  * <slug> ← <abs> <n> files`; `--json`
`{ repo, repoId, source, root, ingested }`. Without `-y` a TTY prompts (with
a live file count — unpinned); a non-TTY is the usage error
`usage: refusing without -y (would ingest files under <abs>)` with the hint
`there is no TTY to confirm on; pass -y to consent to the ingest`, exit 2,
nothing created. `list`: a column table of `  <name>`, `<adapter>`, `<root>`,
`→ <slugs>` or `(unattached)`; none → stderr `  no sources registered`;
`--json` `[{ name, adapter, config, repos }]`, `--ids` the names. `attach
<name>` / `detach <name>` (the selected repo): stdout
`  ok attached <name> → <slug>` / `  ok detached <name> ⇸ <slug>`; `--json`
`{ source, repo, attached }`. `rm <name>`: stdout `  ok deleted source <name>`;
`--json` `{ source, deleted: true }`. Unknown name →
`target_missing: no source named '<n>'`; unknown subcommand →
`usage: unknown source subcommand '<sub>'`. No subcommand → the card.

### `split`

`split <block> --at <n[,n…]> [--actor <s>] [--dry-run]` — a `split` op at
character offsets (comma-separated), CAS pinned from the live row; the
confirmation lists the original id then the new ones. Missing →
`usage: split requires --at n[,n…]`; an offset that is not an integer →
`usage: bad --at '<value>' (offsets must be integers: n[,n…])` (exit 2).

### `status`

`status [--repo <slug>] [--json]` — `repos_status` + `sync_status` + the
watch-lease probe. Human: the wordmark with the slug, `  <root>` (or
`  (no source — headless)`), the rule, then four lines of a two-column grid —
the left cell `  <glyph> <label>  <figure>` padded to 26 visible columns,
the right cell `<label padded to 8><value>`:

```
  [D] docs  18            watcher o none
  [B] blocks  314         synced  ok converged
  * commits  18           queue   empty
  > edges  64             commit# 18
```

`synced` is `ok converged`, or `! <reasons>` joined by `, ` from
`<n> behind`, `<n> deleted`, `<n> drifted`, `<n> untracked`,
`disk unverified` (a sourceless repo), or `unconverged`; `queue` is
`empty` or `<n> queued`. `--json` (every machine mode) the two tools'
results as they are on the wire:
`{ ...repos_status, sync: sync_status, watcher, embedQueue }` =
`{ repoId, slug, rootPath, docs, blocks, commits, openEdges, unconverged, disk: { changed, deleted, untracked, checked }, sync: { lastCommitSeq, lastCheckpoint, convergent, diskChecked, disk }, watcher: "live"|"none", embedQueue }`
(`rootPath` is `""` for a sourceless repo, as `repos_status` reports it).
`embedQueue` is the embedding queue depth of `spec/search` §2.3 — the
embeddable blocks (live leaves of ≥ 24 tokens, §2.1) whose current
`(content_hash, ctx_hash)` has no cached vector for the `embedding.model`
setting when one is named, else for any model — counted from the cache
without a provider (58 for the alchemy fixture with no vectors).

### `sync`

`sync [--watch]` · `sync --server <cmd|url> [-H …]… [--root <dir>] [--out]`
— one-shot: the freshness sweep (§3.7), human: the wordmark `sync`, the rule,
`  scanned   <n> files`, then `  ok ingested  <n>` with `      <path>` per
file, `  x deleted   <n>` with paths, `  ! conflicts <n>` with paths, or
`  already up to date` when nothing changed; `--json` (every non-human mode)
the `SweepResult` `{ checkpointId, ingested, suppressed, deleted, conflicted, scanned, candidates, changed }`.
A sourceless repo: stderr `  <slug> has no filesystem source — nothing to sync`
(an empty-result note, §3.1), `--json`
`{"scanned":0,"ingested":[],"deleted":[],"conflicted":[],"changed":false}`.
`--watch` (a long-running process: lease, adapter, checkpoints, signals) and
`--server` (the remote coordinator) are **unpinned** — their output depends
on timing and on a second process; only the card is fixed.

### `update`

`update <block|doc> (-m <markdown> | -f <file> | -) [--plan] [--expect <hash>] [--reason <s>] [--actor <s>] [--dry-run]`
— polymorphic on the target. A **`b_`-prefixed token** is the block path:
an `update` op replacing the block's markdown (a token that names no live
block is `block_missing: not a block: <ref>`, never a document lookup);
without `--expect` the
CAS is pinned from the live row and stderr says
`  updating <ref> (CAS pinned from current bytes)`; with it, a mismatch is
`stale_expectation: content hash mismatch` with the current hash and
markdown; confirmation (§4). **Anything else** — a document id or a path —
is the whole-document update of
`docs/update-opsets.md`: the bytes are reconciled against the current tree
and the derived opset committed. `--plan` or `--dry-run`: stderr
`  plan for <path>` (`— DOES NOT CONVERGE (will not apply)` appended when it
would not), stdout the rendered opset (`renderOpsetPlan`: one
`<OP> <target>     <disposition> [<reason>]` line per op, an empty line, the
`preserved: n  updated: n  …` summary line). A commit: stderr
`  ok updated <path> · <n> preserved, <n> updated, <n> moved, <n> created, <n> removed`,
stdout every id in `results[*].ids` once, in order of first appearance.
`--json`
`{ opset, result }`. A sourceless repo →
`usage: repo '<slug>' has no filesystem source; 'update' needs a working tree`
(exit 2, §9); unknown doc → `doc_missing: doc <ref> not found` with
`data { doc }`.

## 7. The shell

`shell [--prompt <str>] [--server <cmd|url>]` — a persistent session over one
open workspace. On a TTY it is a readline REPL (unpinned); with stdin
**piped** it is the **script runner** this spec pins: stdin is read to EOF,
split on `\n` (a `\r\n` too), and every line is executed in order; the
process exits 0 unless a line failed, in which case it exits with the
**last** non-zero code (1 or 2). A blank line or one whose first
non-blank character is `#` is skipped. `exit` and `quit` stop the run;
nothing after them executes.

**Tokenizing**: whitespace separates tokens; `'…'` is literal; `"…"` groups
with `\"`, `\\`, `\$`, `` \` `` as escapes (other backslashes kept); a
backslash outside quotes escapes the next character. An unterminated quote
is `usage: unterminated single quote` / `usage: unterminated double quote`
(exit 2 for that line).

**A command line** parses like a fresh argv (§2.2: global flags per line,
`--json`, `--stale`, `-C` all work) and runs through the same path as a
one-shot invocation — the same sweep, dispatch and error rendering — with
one difference: its typed result is captured *before* rendering and becomes
session state. `usage:` errors inside the shell carry no hint line except
the unknown-command one.

**References** (`@` tokens, substituted whole-token into the argv):

| token | value |
| --- | --- |
| `@N` (1-based) | row N of the **frame** — the last displayed collection |
| `@_` | the previous command's typed result |
| `@name` | a binding |
| `…[i]` then `….field` | one index (1-based) then one shallow field, in that order, no deeper |

A **collection** result replaces the frame and prints, on stderr,
`  <n> row(s) — address with @1..@<n>` (`1 row`, `2 rows`; nothing when
empty). Collections: `query`/`run` hits (row ref = `id`), `ls` rows (ref =
`path`), `find` hits (`id`), `links` (out then in; ref = `node`), an
`ApplyResult` (its `results[*].ids`, flattened; ref = the id), any array. A
card or scalar (`show`, `cat`, a count) sets `@_` and leaves the frame.
**Not captured** at all (they leave `@_` and the frame untouched): `log`,
`hist`, `outline`, `diff`, `status`, `repos`, `sync`, the admin verbs (§9).
`cat` captures the bytes (a string) for a document, the `nodes_get` object
for a block; `show` a document captures the card object.

Substitution coerces a row to its ref; a scalar to its string; an object
with `id`/`node`/`block`/`locator`/`path` to that; a bare collection is
refused: `usage: reference is a collection; select one with [i]` (or
`reference is a collection of <n>; select one with [i]` for an array).
Errors: `usage: no displayed collection to index with @N`,
`usage: @<N> out of range (<n> rows)`, `usage: no previous result (@_)`,
`usage: no binding @<name>`, `usage: [<i>] out of range (<n> items)`,
`usage: @<name> is not a collection to index with [i]`,
`usage: cannot read .<f> of a non-object`, `usage: no field .<f>`,
`usage: bad reference '<tok>' (use @N, @_, @name, optional [i] and .field)`.

**Builtins**:

- `@name = <command…>` — runs the command with stdout suppressed (stderr
  still shows), binds a snapshot of its typed result, sets `@_`, prints
  `  @<name> = <summary>` on stderr (`<n> rows`, a number, a quoted string
  clipped to 45 characters + `…`, an id, or `record`). A failing command
  binds nothing (its error is shown). `@name = <@ref>` snapshots the
  reference. The name must match `[A-Za-z][\w-]*` and carry no `[i]`/`.field`:
  `usage: bad binding name '@<n>' (use a letter-led identifier)`,
  `usage: cannot assign to @name[i] or @name.field — bind a whole result to @name`,
  `usage: @name = <command | @ref>` for an empty right side.
- `<@ref>` alone — **inspect**: a collection prints
  `[<i>] <ref>  <label>` per row on stdout (and becomes the frame, stderr
  `  <n> rows`); a string prints itself; a row prints its ref; a record
  prints its coerced ref or its JSON. The inspected value becomes `@_`.
- `unset <name>` — stderr `  unset @<name>` or `  no binding @<name>`.
- `bindings` — stdout `@<name>  <summary>` per binding, or stderr
  `  no bindings`.
- `?` — the session help (exact bytes: `shell::help-line`; the blank line
  between the reference and builtin groups is empty).

### 7.1 `--prompt`

`--prompt <str>` (else `$OMG_SHELL_PROMPT` when non-empty) switches the
piped runner into the **prompted** mode: `<str>` is written to stdout,
verbatim without a newline, before each line is read (so once at start, and
once after each command's output), and each line runs to completion before
the next is read; `exit` ends the run without a further prompt. Without a
prompt the batch runner reads everything first.

## 8. Fixtures

`cases/<suite>.json`:

```json
{ "suite": "<file stem>",
  "cases": [
    { "name": "…", "notes": "…", "workspace": "alchemy" | "none" | "empty",
      "env": { "VAR": "value" }, "files": { "<path>": "<content>" | null },
      "stdin": "…", "argv": ["…"], "pin_stderr": true,
      "expect": { "exit": 0, "stdout": "…", "stderr": "…" } },
    { "name": "…", "workspace": "…", "env": {…}, "files": {…},
      "steps": [ { "argv": [...], "stdin": "…", "env": {…}, "files": {…}, "pin_stderr": true,
                   "expect": {…} }, … ] }
  ] }
```

Suites: `invoke.json` (the invocation model, help, seams), `read.json`,
`query.json` (with `run`), `history.json` (`log`, `hist`, `diff`, `links`),
`mutate.json`, `docs.json`, `shell.json`, `sync.json`, `admin.json` (`init`,
`source`, `rebuild-index`, `gc`, `doctor`, `config`, `embed`).

**The workspace.** A case runs in a fresh directory `<tmp>` (the harness's
scratch path, canonicalized — macOS's temp dir is a symlink):

- `none` — `<tmp>` holds only `home/` and `tmp/`.
- `empty` — `<tmp>` is a workspace with no repo: `init --yes --no-embedder`
  (equivalently: create `<tmp>/.omgbase/omgbase.db` with the schema).
- `alchemy` — the alchemy corpus (`packages/core/corpus/oqx/fixtures/alchemy`,
  18 documents, the same files `spec/surface` §6 embeds) copied to
  `<tmp>/vault`, then `init --yes --no-embedder` and
  `source add vault --repo fixture -y` under the seams — equivalently, with
  an engine's library: `ensure_repo("fixture", <tmp>/vault)` (`spec/sync` §2:
  repo `rp_0`, source `fixture-fs` = `src_0`), one freshness sweep at the
  spec clock (the walk is depth-first with each directory's entries in
  bytewise order, `spec/sync` §4.2, so `d_0` is `index.md`, `d_17`
  `texts/mutus-liber.md`, `b_0`–`b_313` the blocks in document pre-order,
  `c_0`–`c_17` the commits, `cp_0` the checkpoint), then `rebuild_file_stats`.
  A harness may build this once and copy it per case, in which case it must
  re-record `file_stats` after the copy (a copy loses nanosecond mtimes and
  the first sweep would otherwise re-hash every file — the ids do not
  change, `candidates` does).

The reference harness builds the two templates with the reference's own
verbs; the Rust harness with its library; `spec/sync` and `spec/store` pin
that both produce the same rows and ids. `<tmp>` must not lie inside a git
working tree (`init`'s `.gitignore` offer would fire).

**Running a step.** The binary is spawned with cwd `<tmp>`, argv
`--no-color` followed by the case's `argv`, stdin the case's `stdin` (empty
when absent — so a verb that reads stdin sees EOF at once), and an
environment holding only: `PATH` (inherited), `NO_COLOR=1`,
`HOME=<tmp>/home`, `TMPDIR=<tmp>/tmp`, `OMGBASE_SPEC_MINTER=sequential`,
`OMGBASE_SPEC_CLOCK=2026-09-27T00:00:00.000Z`, then the case's `env` and the
step's `env` (later wins). `files` (the case's before the first step, a
step's before that step) are written under `<tmp>`, a `null` value deletes,
a `*.sh` file is made executable. The token `<workspace>` in argv, env
values, stdin and file contents is replaced by `<tmp>` before use; in
stdout and stderr every occurrence of `<tmp>` is replaced by `<workspace>`
after, and every occurrence of the binary's own version string (what
`--version` prints: the npm package version for `omg`, the crate version for
`omgbase`) by `<version>` — the two binaries are versioned apart, so the
fixtures pin the shape of `--version`, not the number. The first step of a sequence runs on the fresh workspace, every
following step on the workspace the previous one left.

**Comparing.** `expect.exit` and `expect.stdout` always, byte for byte;
`expect.stderr` only when present. A case records `stderr` when its exit is
non-zero (every error is pinned) or when it sets `pin_stderr` (a
confirmation, a footer, a warning, or an explicitly empty stderr); otherwise
stderr is unpinned and a runner shows it only on failure.

**Determinism.** Everything a case prints is a function of the workspace,
the seams and the inputs, with these deliberate exclusions: every write
passes `--actor human:spec` (the default is the OS username); no case sets
a working embedder; no case runs `sync --watch`, `mcp` beyond its help and
error, `--server` beyond its refusals, or an interactive editor/prompt.

**Generation.** `packages/cli/corpus/cli/spec.test.ts` (vitest, part of
`pnpm --filter omgbase test`; needs `pnpm build` first): `CLI_SPEC_UPDATE=1`
rewrites every `expect` from the reference — inputs, notes and order
untouched — and prints the `+`/`~`/`-` change report; the diff is reviewed
like code. **Allowlist (Rust).** `crates/omgbase/tests/cli_spec.rs`,
`crates/omgbase/tests/cli-spec-passing.txt` (one `suite::name` per line): a
listed case that fails fails `cargo test -p omgbase --test cli_spec`; an
unlisted one is reported as "not yet"; `CLI_SPEC_UPDATE=1` rewrites the
list from what passes. `$OMGBASE_RUST_BIN` points the runner at another
binary.

## 9. Reference oddities surfaced while specifying, and decisions

**Decisions taken on 2026-09-27, before the Rust port began** (Brendan: parity
everywhere, but not parity with accidents). Each bullet below is either
**Fixed** — the reference was brought to the rule the prose states and the
fixtures regenerated, still under `VERSION` 1.0, since no port had built
against the accident — or **Pinned** — kept as built, a fixture asserts it.
The Fixed set: an unknown per-command option, a missing global-flag value and
a stray pre-command flag are usage errors (exit 2, `usage:` prefix); an empty
or missing `query` source is a usage error; engine errors keep their own code
(`filter_invalid`, `target_missing`, `repo_not_found` — never `error[error]`);
`source add` refusing without `-y` on a non-TTY exits 2; `--version` prints
the CLI package's version; the JSON error keeps `hint`; an empty error payload
prints nothing; `new`/`mv`/`rm --doc`/`meta` honor `--dry-run` (validate,
render the diff, commit nothing); `node set` edits the property it names and
honors `--actor`; `done` on a non-task block is `type_mismatch`; `retarget`'s
plan is the unified diff of `spec/surface` §3; a whole-document `update`
prints each id once; `mv` reports dangling inbound links on stderr in human
mode too; an invalid `b_` token is `block_missing`; `split --at` with a
non-integer is a usage error; machine modes follow one rule — `--jsonl` on a
non-list result prints the `--json` document, `--ids` on a result without an
id list prints the `--json` document, and the truncation footer is printed in
every mode but `--json` (whose document carries `truncated`/`cursor`);
`--json` is the mapped tool's result shape for `cat` (doc →
`docs_read`), `show` (doc → `read_ref`), `diff` (→ `diff_unified`), `repos`
(→ `repos`), `retarget`'s plan (→ `links_retarget` dry run) and `status`
(`{ ...repos_status, sync: sync_status, watcher, embedQueue }`);
empty-result notes go to stderr; a commit whose revisions were all deleted or
moved renders `deleted <path>` / `moved <from> → <to>`; an unparsable
`--since` is a usage error; `outline --section` is removed (usage error);
`--server ""` is a usage error; `status.embedQueue` is the count of stale
embeddable blocks (`spec/search` §2.3); `links --blocks` renders block-grain
rows; the shell's `?` prints the builtin help; `config list` falls back to the
workspace layer; `config help`, `embed help` and a bare `node` need no
workspace; `doctor`'s FTS check compares index rows to live **leaf** blocks
(`spec/search` §1.1). Pinned: `gc`'s refusal, `edit` failures, a lease
conflict and a missing source as `target_missing`; `--version` before seam
validation; `insert` to a heading landing right after it (a heading is not a
container; `append` addresses the section); the `did you mean` distance
rule as coded; `edit` needing `OMG_EDITOR` when stdin is not a TTY; heading
text not being a ref (`ambiguous_heading` unreachable from the CLI); an
unknown OQX root being empty (the surface's context, not the CLI); an empty
sweep minting a checkpoint id (`spec/sync` §4.1); `gc` after `rm --doc`
sweeping nothing (gc ships dark).
Pinned as built; each is a coordinator decision (fix in both engines with a
fixture change and a version bump, or keep). None was fixed here.

**Exit codes and error codes**

- **Fixed — an unknown per-command option, a value-taking option without
  its value and a boolean given one are usage errors** (exit 2,
  `usage: unknown option '--scope'` / `option '--depth' requires a value` /
  `option '--json' does not take a value`, hint
  `run '<prog> <command> --help' for the options`). The reference catches
  Node's `parseArgs` failures once, in dispatch, and renders them as every
  other usage error — the wording is the CLI's, not Node's, so a port need
  not reproduce `ERR_PARSE_ARGS_UNKNOWN_OPTION`'s text
  (`invoke::unknown-option-is-an-engine-error` keeps its name and now shows
  exit 2; `invoke::unknown-option-json`). `docs/cli.md`'s
  `--scope`/`--min-confidence` on `log`, `--annotate` on `outline`,
  `--section` on `move` are removed from the doc: none exists.
- **Fixed — a global flag with a missing value and a stray flag before the
  command are `usage:` errors** like every other (`usage: -C requires a
  directory`, `usage: unknown flag -n`, exit 2, JSON form under a machine
  flag). The global parser records the first malformed flag and finishes
  parsing, so the mode is known when the error is rendered
  (`invoke::stray-flag-before-command`, `directory-flag-missing-value`,
  `repo-flag-missing-value`, `server-flag-missing-value`,
  `header-flag-missing-value`).
- **Fixed — `query` with an empty or missing source is a usage error**:
  `usage: query requires a <source> (or -f file|-)`, exit 2
  (`query::empty-source`, `query::no-source`).
- **Fixed — engine errors keep the code the MCP catalog gives them.** The
  CLI rendered any error without a `code` field as `error[error]`; it now
  renders every non-CLI error through the engine's one mapping
  (`errorBody` in `@omgbase/core`, which the MCP server's `fail` also
  calls): an OQX error and an invalid cursor are `filter_invalid`
  (`query::parse-error`, `parse-error-json`, `cursor-invalid`,
  `cursor-invalid-json`), `diff --to <unknown revision>` is
  `target_missing` with `data { doc, rev }`, and a write on a sourceless
  repo (`new`, `insert`: `mutation requires a rootPath or an explicit
  docStore`) is the catalog's catch-all `repo_not_found`
  (`sync::sourceless`); `update <doc>` on the same repo stays the `usage:`
  error, exit 2.
- **Pinned — `gc`'s refusal, `edit`'s missing editor / missing TTY / editor failure,
  `sync --watch`'s lease conflict and `source`'s missing directory or name
  all use the code `target_missing`.**
- **Fixed — `source add` without `-y` on a non-TTY is a usage error**:
  `usage: refusing without -y (would ingest files under <abs>)`, hint
  `there is no TTY to confirm on; pass -y to consent to the ingest`, exit 2
  (a script that forgot the flag must not see a success)
  (`admin::source-add-refuses-without-yes`).
- **Fixed — `--version` prints the CLI package's version** (`0.4.0`; the
  reference reads the nearest `package.json` named `omgbase` above the
  running module), not `@omgbase/core`'s `0.1.0`
  (`invoke::version`, `version-short`). Pinned: it is answered before the
  seams are validated (`invoke::version-wins-over-bad-clock`); `-V` is an
  alias, so is `--directory` for `-C`.
- **Fixed — the JSON error keeps the hint** as a `hint` field
  (`repo_not_found`'s two fixes: `invoke::no-workspace-json`;
  `semantic_unavailable`'s config command: `query::semantic-unavailable-json`).
- **Fixed — an empty error payload prints nothing**: a `data` of `{}` (a
  `MutationError` raised without a payload) no longer prints the two lines
  `  {` / `  }` under the message, and is omitted from the JSON error
  (`docs::new-duplicate`, `mv-missing`, `mutate::node-set-unknown-node`).

**`--dry-run` and writes**

- **Fixed — `new`, `mv`, `rm --doc` and `meta` honor `--dry-run`** (they
  used to accept the flag and commit). The document operations take
  `dryRun` in their context (`docsCreate`/`docsMove`/`docsDelete`/
  `docsSetMeta`), validate exactly as the real run, and return
  `committed: false` with the per-file `diffs` of §3.6; the CLI renders them
  with the block verbs' renderer. The MCP tools `docs_create`, `docs_move`,
  `docs_delete`, `docs_set_meta` accept `dry_run` for the same result (a
  `spec/surface` catalog addition; the default is unchanged).
  `docs::new-dry-run-commits` keeps its name and now shows the document
  *not* created; `new-dry-run-json`, `mv-dry-run`, `mv-dry-run-json`,
  `meta-dry-run`, `rm-doc-dry-run`.
- **Fixed — `node set <task> checked true` checks the task and honors
  `--actor`.** One bug behind both symptoms: the CLI dropped the tokens that
  *start* with `--` from the positionals but kept `--actor`'s value, so the
  property value reached the editor as `"true human:spec"` (→ `checked:
  false`, a no-op `edited` commit) while the parsed actor was discarded; the
  dry-run fixture passed no `--actor`, which is why it showed the right
  diff. The value is now every positional after `<prop>` as the option
  parser leaves them, joined by a space; the commit's actor is `--actor`
  (`mutate::node`, `mutate::node-set-dry-run`).
- **Fixed — `done` on a non-task block is `type_mismatch`**
  (`not a task: <ref> is a <type>`, `data { block, type }`), checked by the
  CLI before any op is built; the `tasks_complete` macro (`spec/mutate` §5)
  is unchanged (`mutate::done-on-paragraph`).
- **Fixed (mutate 1.2) — `insert` to a heading id destroyed the heading.**
  The as-built rendering looked like "the block lands right after the
  heading", but the heading's own line was gone from the file and its id
  now labelled the inserted block: the kernel had inserted into the leaf's
  empty `children` and re-rendered the leaf from them (`spec/mutate` §1.1,
  §10). A leaf parent is `type_mismatch` now, and the CLI prints the
  kernel's message with its hint (`mutate::insert-to-heading`); `append`
  addresses the section, `insert --at after <id>` the position.
- **Fixed — `retarget`'s plan is the unified diff**: per hit, the block id,
  then `unifiedDiff(oldRaw, newRaw)` (`spec/surface` §3, as `diff` and every
  dry run), then an empty line; the positional line diff (`- old` / `+ new`,
  lines compared at equal indices) is gone (`mutate::retarget`,
  `retarget-scope-hit`, `retarget-wikilink`).
- **Fixed — a whole-document `update` prints each id once**: the flattened
  `results[*].ids` de-duplicated in order of first appearance (a block an
  update and a retile both touched appeared twice; `docs::update-doc`).
- **Fixed — `mv` reports dangling inbound links on stderr in human mode
  too**: `! <n> inbound link(s) still name(s) the old path: <path> <block>, …`
  and `fix: omg retarget /<old> /<new> --apply`, after the confirmation
  (and after a dry run's diffs); `--json`'s `dangling` is as before. `mv`
  still does not rewrite them (`docs::mv`, `mv-dry-run`).
- **Fixed — a `b_`-prefixed `update` target is always the block path**:
  `update b_nope` is `block_missing: not a block: b_nope`; it no longer
  falls through to the document path (`doc_missing: doc b_nope not found`)
  (`mutate::update-missing-block`).
- **Fixed — `split --at` with a non-integer offset is a usage error**:
  `usage: bad --at '<value>' (offsets must be integers: n[,n…])`, exit 2;
  it no longer reaches the kernel as `NaN` (`mutate::split-bad-offset`).

**Renderings**

- **Fixed — one machine-mode rule for every verb** (§3.2, §3.4), applied
  by one renderer (`emitMachine` in the reference's `output.ts`): `--jsonl`
  streams the result's list when it has one, else prints the `--json`
  document; `--ids` prints the result's id list when it has one, else the
  `--json` document; the truncation footer prints in every mode but
  `--json`. No verb falls back to the human rendering. So `diff --jsonl`,
  `hist --ids`, `links --jsonl` print the document
  (`history::diff-single-revision-json`, `hist-ids-is-human`,
  `links-jsonl-is-human` — the two keep their names and now show the
  document); `log --ids` prints the footer (`history::log-ids`);
  `rebuild-index --json` prints `{"rebuilt":"<target>"}`
  (`admin::rebuild-index-json-is-silent`); `status`, `outline`, `sync`,
  `doctor`, `gc`, `init`, `source add/attach/detach/rm`, `node props` are
  unchanged (their results have no list) (`read::status-ids-is-json`,
  `outline-ids-is-json`, `sync::up-to-date-ids-is-json`).
- **Fixed — `--json` is the mapped tool's result**, produced by the same
  library function the MCP server calls so the shapes cannot drift: `cat`
  on a document → `docs_read` (`read::cat-doc-json`, `cat-many-json`,
  `cat-many-jsonl`, the shell's `cat @1 --json`); `show` on a document →
  `read_ref` (`{ kind: "document", ...docs_read }`; `read::show-doc-json`,
  `shell::previous-result`); `diff` → `diff_unified`'s
  `{ doc, path, from, to, diff }` (`docDiffUnified`; `diff --blocks` → the
  `diff` tool's entries); `repos` → the `repos` tool's
  `{ repos: [{ slug, hasSource }] }` (`reposList`; the human table keeps the
  root and counts it always showed; `read::repos-json`, `repos-jsonl`,
  `admin::empty-workspace-reads`); `status` →
  `{ ...repos_status, sync: sync_status, watcher, embedQueue }`
  (`read::status-json`, `status-ids-is-json`, `sync::*`). `retarget`'s plan
  is the writes half (`links_retarget` dry run). `source add`'s
  `{ repo, repoId, source, root, ingested }` has no tool and stays.
- **Fixed — every empty-result note goes to stderr** (§3.1): `repos`
  (`  no repos attached`), `source list` (`  no sources registered`) and
  `sync` on a sourceless repo (`  <slug> has no filesystem source — nothing
  to sync`) join the others (`admin::empty-workspace-reads`,
  `source-add-refuses-without-yes`, `sync::sourceless`).
- **Fixed — a commit that wrote no revision names what it did**:
  `observed: deleted texts/mutus-liber.md` after an observed deletion,
  `api(human:spec): moved texts/mutus-liber.md → texts/silent-book.md`
  after `mv` (a deletion is the documents whose `deleted_commit` is the
  commit; a move is read from the commit's `reason`, `move <from> -> <to>`).
  `changesSince`'s summary is in `@omgbase/core`, so the `changes_since`
  tool says the same (its `summary` is unpinned by `spec/surface`)
  (`sync::out-of-band-delete`, `docs::mv`).
- **Fixed — an unparsable `--since` is a usage error**:
  `usage: bad --since '<v>' (use a relative age like 24h or 7d, or an ISO timestamp)`,
  exit 2 (`history::log-since-garbage`).
- **Fixed — `outline --section` is removed**: an unknown option, so the
  usage error above (`read::outline-section-is-ignored`; the card
  `invoke::help-card-outline` no longer lists it).
- **Fixed — `--server ""` is a usage error** (`usage: --server requires a
  command or url`, exit 2): the flag was given, so the command must not fall
  through to the local store (`invoke::server-empty-runs-locally`).
- **Pinned — `did you mean` guesses `q` for `x`** — the code comment says a lone
  `x` should suggest nothing; the rule as written (one edit for ≤ 3
  characters) does suggest it.
- **Fixed — `status.embedQueue` is the embedding queue depth** of
  `spec/search` §2.3: the embeddable blocks whose current
  `(content_hash, ctx_hash)` has no cached vector for the `embedding.model`
  setting when one is named, else for any model — counted from the cache
  alone (`staleEmbedCount` in `@omgbase/core`), so it needs no provider and
  is 58 for the alchemy fixture (`read::status`, `status-json`, every
  `status` step). The human `queue` cell reads `<n> queued`.
- **Fixed — `links --blocks` renders block-grain rows**: one per open edge
  with the source block beside the far node (`references > d_13 (b_307)`,
  `d_0 (b_28) > references`), no count; `docLinks(blocks: true)` gains
  `block` on both directions and the inbound side is per edge too
  (`history::links-blocks`, `links-blocks-json`).
- **Fixed — the shell's `?` help prints an empty line** between the
  reference and builtin groups, not two spaces (`shell::help-line`).

**Workspace and help**

- **Fixed — `config` falls back to the workspace layer** when no repo is
  selectable (a workspace with none, an ambiguous cwd); the fallback tested
  for the library's `RepoSelectionError` after `Cli.repo()` had already
  wrapped it as `repo_not_found`, so it never fired. An explicit
  `--repo <unknown>` is still `repo_not_found`
  (`admin::empty-workspace-reads`: `config` in the empty workspace prints
  `  workspace defaults`, exit 0).
- **Fixed — the help words need no workspace**: `config help`,
  `embed help`, `node help`, `source help`, a bare `node` and a bare
  `source` are routed to their card before the workspace is opened or
  swept, exactly like the `--help` flag
  (`invoke::node-bare-needs-workspace`,
  `admin::config-help-word-needs-workspace`,
  `embed-help-word-needs-workspace` — the three keep their names and now
  print the card, exit 0).
- **Pinned — `edit` needs `OMG_EDITOR` for a scripted edit**: `$EDITOR`/`$VISUAL`
  are refused without a TTY (`mutate::edit-editor-needs-tty`).
- **Pinned — heading text is not a CLI ref**: `append Contents` is
  `block_missing: not a block: Contents`; the MCP tools' `heading` text
  resolution (and therefore `ambiguous_heading`) is unreachable from the CLI.
- **Pinned — an unknown OQX root is silently empty** (`q 'from nope'` prints
  `  no hits`, exit 0; `query::unknown-root`).

**Engine behavior surfaced through the CLI**

- **Fixed — `doctor`'s FTS check compares index rows to live leaf
  blocks.** The old check compared `SELECT count(*) FROM blocks_fts` — which
  an external-content FTS5 table answers from `blocks`, tombstones and
  containers included (314 for alchemy, before and after a deletion) — to
  every live block, so it "held" only while nothing had been deleted and
  "failed" after a deletion no rebuild could cure. It now compares the
  index's own row count (`blocks_fts_docsize`) to the live leaf count of
  `spec/search` §1.1 (`fts rows == live leaf blocks`, detail
  `fts=<n> leaves=<n>`), and holds after a deletion and after
  `rebuild-index --fts` (`admin::doctor`, `doctor-json`,
  `doctor-after-observed-delete`, `doctor-after-api-delete`). The index was
  right all along; the check was wrong.
- **Pinned — every freshness sweep mints a checkpoint id**, even an empty one, so
  `sync --json`'s `checkpointId` depends on how many sweeping commands ran
  before it (`cp_5` after four reads).
- **Pinned — `gc` sweeps nothing after `rm --doc`** (`admin::gc-after-removals`):
  the tombstoned document's blobs stay referenced by its revisions.

**Port notes.** The Rust binary today renders `mcp` only; its `--help` and
`--version` are its own (`omgbase <version>`, a usage block) and differ from
the reference's, so the allowlist starts empty. `embedder_failed`'s
`reason` is the OS's spawn error text (Node: `spawn … ENOENT`) — a port's
will differ; no fixture pins it. Both engines must implement the `mintId`
redraw of `spec/store` 13.5 for the ids in `mutate.json` to agree (the
bootstrap leaves `b_0`–`b_313` in use; a fresh process's first block mint is
`b_314`).

- **Fixed — a write on a sourceless repo printed the library's untyped
  message** (`error[repo_not_found]: Error: mutation requires a rootPath or
  an explicit docStore`, the catch-all code with `String(err)`), while the
  MCP server pre-checks and says `repo has no filesystem source; mutation
  disabled` (`spec/surface` §4). The library now throws that typed error, so
  both clients render the same bytes (`sync::sourceless`).

## 10. Decisions

- 2026-09-27, cli 1.0 specified as built: every verb, every output mode it
  implements, the script-mode shell, the seams at the entry point (until
  now only `omg mcp` read `OMGBASE_SPEC_MINTER`/`OMGBASE_SPEC_CLOCK`; every
  verb honors them, `mcp`'s announcements are unchanged), 470 cases (676
  recorded invocations) across nine suites. Brendan's decision (2026-09-27) to render
  the `omg` verbs in the Rust `omgbase` binary is what this contract serves;
  the Rust runner ships with an empty allowlist.
- 2026-09-27, cli 1.0 also: thirty-odd as-built accidents fixed in the
  reference before any port built against them (§9, "Fixed"); the rest
  pinned with a fixture each. One "pinned" item turned out to be data loss
(`insert` to a heading — see the mutate 1.2 bullet) and was fixed the same
day.
