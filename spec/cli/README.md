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
`retarget`, `apply`, `execute`, `insert`, `move`, `split`, `merge`, `done`,
`append`, `node`, `shell` }. Any other command given `--server` (unless `--help`) is
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

**Profiles (cli 4.2).** The server may serve a catalog profile
(`spec/surface` §4 "Profiles": `omg mcp --tools minimal` lists ten tools).
The client lists the tools once per connection (`tools/list`, on connect);
a sugar verb (`insert`, `update <block>`, `move`, `rm`, `done`, `append`,
`split`, `merge`, `node set`, `new`, `mv`, `rm --doc`, `meta`, `update
<doc>`, `retarget --apply`) calls its sugar tool when the server lists it —
the server resolves refs and pins CAS — and otherwise sends `apply {
effects, reason }` with the effects the shared builders make from the refs
as given (the same closure the verb's `--dry-run` `plan` uses: a `b_`/`d_`
id names its row, anything else a document path), `reason` the verb's
`--reason` where it has one, else the sugar tool's name. Against a `full`
server nothing changes (every tool is listed, every call is the same as
before); `--dry-run` is `plan { effects }` under either profile. The one
thing a minimal server cannot do is resolve a `#` locator (`path#type[n]`),
so a verb falling back to `apply` with such a ref is the usage error
`usage: "<ref>" is a locator, and this server does not list <tool> (a minimal tools profile) — refs are not resolved server-side there; pass a block or document id instead`,
exit 2. `mv` over a minimal server reports no `retargeted`/`dangling` (the
Receipt alone carries neither); `retarget --apply` prints the Receipt without
`hits`/`pairs`; `append <block>` reads the block's type through `query`
instead of `blocks_read`. Unpinned here like the rest of the remote path
(the reference's `packages/cli/test/remote-minimal.test.ts` proves it against
`omg mcp --tools minimal`).

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
exceptions: an empty result leaves stdout empty in every verb. **Alerts
(store 17.0, slice 3e-ii).** After a verb has run against a repository, every
ACTIVE alert of that repository (`spec/store` §3.1 `alerts`, §5.8) is one
more stderr line, after the verb's own output, in every output mode:
`alert[<severity>] <code>: <message>` — the same rows the MCP server
carries in a result's `alerts` member (`spec/surface` §4), so a user at the
terminal and an agent over MCP are told alike. The workspace-less verbs
(`init`, `help`, `version`), the servers and sessions (`mcp`, `shell` — whose
lines each print their own), `--server` (no local store) and a verb whose
repository did not resolve print none. `admin::doctor-alert` pins the line
(`find` with no hit: `  no matches`, then the alert).

### 3.1a Paths (cli 2.0)

Every document path a verb prints — a hit's locator, `ls`/`docs_tree` rows,
the `outline`/`show` header, `new`/`mv`/`rm --doc`/`meta` confirmations, the
dry-run diff headers, `log` summaries, `find` locators, `sync`'s ingested /
deleted / conflicted lists, and every path inside a `--json` document — is the
**reference form**, `/`-rooted (`/projects/oqx.md`): `spec/surface` §1
"Paths". Every path a verb accepts — a ref, a glob, `new`'s path, `mv`'s
destination, `retarget`'s targets, `--doc` — tolerates both forms (`omg cat
/index.md` and `omg cat index.md` read one document). A `--cursor` issued by a
1.x `omg` is refused as `filter_invalid` (§3.5), the message naming the cause.

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
`provider_unavailable`, `embedder_failed`, …) and anything else thrown — is

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
      "_hash": "…",
      "markdown": "…"
    },
    "retriable": true
  }
```

(`current._hash` is the block row's hash under the engine names of
`spec/surface` §1.2, 5.0 — `current.hash` through 4.x; `op_index`, `block`
and `expected_content_hash` are roles and stay bare.) Every `--json` error
`data` carries the tool's payload verbatim, so the row-attribute keys inside
it are the surface's: `doc_missing { _id?, _path? }`, `block_missing { _id
}`, `ambiguous_heading.candidates[{ _id, _doc_id }]`, `stale_plan.current {
revision, _hash }`.

### 3.6 `--dry-run`

`--dry-run` is global, and since cli 4.0 **every dry run is a `plan`**
(`spec/mutate` §11.6): the verb builds the effects it would commit, plans
them, prints `  dry run — <n> file(s) would change, nothing committed` on
stderr, then on stdout, per changed file of the Plan's `preview.diffs` in
order: the path, the unified diff of before → after (`spec/surface` §3's
Myers diff, `@@` hunks with three lines of context, no `---`/`+++` header),
then an empty line. `--json` prints the Plan itself — what `execute` takes
back. A dry run **burns no id**: planning runs under the symbolic minter, so
the ids it reports are `$new.n` (a `new --dry-run --json`'s revision id is
`$new.0`, an `insert --dry-run --json`'s result id `$new.0`) and a committed
run that follows takes exactly the ids the dry run would have
(`mutate::apply-effects-dry-run`: the dry run, then the commit minting
`b_328`, the same id the commit alone mints). This holds for every
mutator — the block verbs (`apply`, `insert`, `update` on a block, `move`,
`rm` on blocks, `done`, `append`, `split`, `merge`, `node set`, `edit`,
`retarget --apply`) and the document verbs (`new`, `mv`, `rm --doc`,
`meta`): a create is `""` → the bytes, a delete the bytes → `""`, a rename
two entries (the old path emptied, the new path filled), a `meta` patch the
one file before → after; every check the real run makes (`doc_missing`,
`path_taken`, …) runs. Nothing is written or committed.

For a whole-document `update`, `--dry-run` prints the plan's identity
consequences instead of diffs (§6 `update`). `execute` has no dry run — the
plan is the preview; `execute --dry-run` is the usage error
`execute has no dry run — the plan is the preview (re-plan with apply --dry-run)`.

Through 3.x a dry run ran the kernel changeset with `dry_run` and **consumed**
the ids it reported (`spec/surface` §9, closed at 4.0), `--json` printed the
`ApplyResult` with `diffs`, and only `apply -f { effects }` planned (cli 3.2,
"the one exception").

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
(`disk.changed`/`deleted`/`untracked`); and **every sweep writes the
repository's status row** (`spec/sync` §4.1, 4.0) — an empty one too — so
`sync --json`'s `batchId` is the first committing member's commit id of that
sweep's batch, or `null` when the sweep committed nothing (through cli 5.x a
`checkpointId` `cp_n` counted the sweeping commands run since the bootstrap). `shell` skips
the pre-sweep but each line it runs sweeps on its own. Since `spec/sync` 2.2
the sweep's step 0 replays the api path's pending materialization rows
(`spec/store` §5.7), so the pre-verb sweep is also the CLI's recovery point
for a write the previous process did not finish; nothing a fixture can see.

Every write runs under the writer lock of `spec/sync` §7
(`<workspace>/.omgbase/writer.lock`); a watcher holds the watch lease
(`watch.lock`) and `status` reports it (`watcher: live`/`none`). Neither is
observable in a fixture beyond `status`'s `none`.

The commit **actor** of every CLI write defaults to `human:<os username>`
(`--actor` overrides it) — unpinnable, so every fixture passes
`--actor human:spec`.

## 4. Shared renderers

- **id + locator pairing**: `<id>  <locator>` — two spaces, the id first
  (`query` hits — their `_id` and `_path` —, `find` hits, the shell's inspect
  listing).
- **columns** (`ls`, the query table, `repos`, `source list`): cells padded
  to the widest cell of their column, joined by two spaces, the last column
  unpadded, trailing whitespace removed from every line; a column may be
  right-aligned (`ls`'s counts and times).
- **the query hit table** (`query`, `run`): a hit is `{ _id, _path,
  ...projection }` (`spec/surface` §1.4, 5.0 — the envelope under the
  engine names: on every record a bare name is the user's, an
  underscore-prefixed name the engine's). With no projection, one
  `<id>  <path>` line per hit (the values); with a projection, a header row
  (`_id`, `_path`, then the projected keys in first-seen order across the
  hits — a `select _path`/`_id` is the envelope key itself, so it is never a
  column; a column *named* `_id` or `_path` that is not the attribute itself
  is refused by the surface — alias it; a projected authored `path` or `id`
  key is an ordinary column beside the envelope's), then one row per hit.
  Cells: strings verbatim up to their first newline (a cut is marked `…`),
  numbers and booleans as JavaScript prints them, `null`/absent → empty,
  lists and records as compact JSON; every cell but `_id`/`_path` is clipped
  to 60 visible characters, the 60th being `…`. Through 4.x the header read
  `id`/`path`; before 3.0 a `$path` projection sat beside the `path` column;
  for a few days of the 3.0 line the header read `$id`/`$path` (§10).
  **`--bare` (4.1)**: the hit is its projection alone (`spec/surface` §1.4,
  4.2), so the table has no envelope columns — the header is every projected
  key in first-seen order and a projected `_id`/`_path` is an ordinary
  column, clipped like any cell (`query::bare`).
- **the outline wire format** (`outline`): `spec/surface` §2's text
  verbatim, one line per block.
- **commit confirmation** (block mutators; every write is a Receipt since
  cli 4.0): stderr `  ok committed · <n> document<s> touched` (`document`
  for one), `<n>` the receipt's `revisions`, then (cli 4.3) the Receipt's
  `summary` — one line per effect, in words (`spec/mutate` §11.9), each
  indented four spaces on stderr (`    set _frontmatter.verified = false in
  /substances/salt.md`); stdout the ids the write names,
  one per line — the Plan's `preview.results[*].ids` in order (duplicates
  included) with every `$new.n` realized from the receipt's `new_ids`, when
  the Plan is at hand with its preview (every local write, any `execute`);
  when it is not (a plan echoed without `preview`, a remote write), every
  id the plan minted: the `new_ids` values in order, which includes the
  discarded mints of a re-parse (`spec/mutate` §10) — ids that name no row.
  `--json` prints the Receipt (a `retarget --apply` adds `hits`/`pairs`).
- **document-op confirmation** (`new`/`mv`/`rm --doc`/`meta`): stderr
  `  ok <verb> <path>` (`created` / `moved to` / `deleted` / `patched`),
  then (cli 4.3) the Receipt's `summary` lines indented four spaces as
  above; stdout the document id. `--json` prints `{ _id, _path, committed }`
  (5.0; `{ id, path, committed }` through 4.x — the document's row
  attributes under the engine names, `committed` a role) — the summary is
  the human rendering's.
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
hist, diff, links, history), `mutate` (apply, execute, insert, update, edit, move, rm,
done, append, retarget, split, merge, node), `documents` (new, mv, meta), `session`
(shell), `sync & serve` (sync, mcp), `admin` (rebuild-index, gc, doctor,
config, embed, version). `help` is unlisted. The exact bytes are
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
`source`, `node` and `history` with no subcommand print their card; `config help`,
`embed help`, `history help`, `node help` and `source help` print theirs. The help words are
the `--help` flag spelled differently: they are routed before any workspace
is opened or swept, so every card prints from any directory.

## 6. The verbs

Alphabetical. For each: the usage line, the options, what it renders (the
MCP tool / library operation of `docs/surface-map.md`), the human rendering,
the `--json` shape, and the errors. "Exact bytes" points at the cases.

### `append`

`append <block> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]`
— `blocks_append` (surface 3.0; `sections_append` before): the block(s)
parsed from the markdown are appended INTO the block — a heading's section
(before the next heading of equal or higher level) or a container's children;
a leaf is `block_not_container`. `<block>` is a block id or locator (a path
or heading *text* is `block_missing`, §9). Content: `-m`, `-f <file>`, `-f -`
or a bare `-` for stdin, else stdin. Commit confirmation (§4);
`--json` the Receipt. Missing block → `usage: append requires a <block>`.

### `apply`

`apply [-f <changeset.json|->] [--reason <s>] [--actor <s>] [--dry-run]` —
the primitive: `{ "effects": [...] }` from `-f <file>`, `-f -` or stdin
(`spec/mutate` §11, the `apply` tool's `effects`): the ordered intentional
writes, planned and committed as one transaction with `origin.actor`/`reason`
(`applyEffects`); confirmation (§4, the Receipt form); `--json` the Receipt
`{ plan_id, commit, revisions, new_ids, committed }`; `--dry-run` the Plan
(§3.6). An empty `effects` prints `  nothing to do` on stderr, exit 0. No
`effects` member → `usage: changeset must have an \`effects\` array`; not an
array → `usage: changeset \`effects\` must be an array`; an `ops` member
(the kernel changeset `apply -f { ops }` took through 3.x) →
`usage: \`ops\` is no longer an input — apply takes \`effects\` (the kernel
ops are a library/fixture contract since spec/mutate 3.0)`. Planner and
kernel errors (`conflicting_effects`, `stale_expectation`, `path_taken`,
`block_missing`, …) render per §3.5 with the planner's payload
(`effect_index`, `focus`, the op's `op_index`, …) —
`mutate::apply-conflicting-effects`.

### `cat`

`cat <node…|-> [--resolution raw|text|outline|skeleton|full]` — `docs_read` or
`blocks_read`, chosen by the ref's shape on the client (`b_`, `n_` or
`path#type[n]` → `blocks_read`, a `d_` id or a path → `docs_read`; ids carry
their kind, so there is no polymorphic `read_ref` tool since surface 3.0).
Each ref (a block id, doc id, node id or document path in either form; `-` reads refs
from stdin one per line, a `-` with empty stdin is
`usage: cat requires a <node> (or - to read refs from stdin)`) prints, in
order: a document → its exact bytes (`docs_read`); a block → its raw
markdown, or at `--resolution text|outline|skeleton|full` the `blocks_read`
field `_raw ?? _text ?? label`. `--resolution` other than `raw` on a document
ref warns on stderr
`  --resolution <r> ignored for <ref>: a document is always its exact bytes (resolutions apply to block refs)`
and prints the bytes. `--json`: one ref → the object, several → an array;
`--jsonl` one object per line (`--ids`: the same document — a read has no
id list); a block's object is `blocks_read` at the resolution
(`{ _id, _type, _raw, _hash }` at raw), a document's is the `docs_read`
result `{ _id, _path, rev, properties: { frontmatter, inline, computed },
_raw }` (5.0 — the row rule of `spec/surface` §1.2: the row attributes
under the engine names, `rev` and `properties` roles; `properties.computed`
spells its rows `_title`/`_tags`, the authored groups stay bare; `{ id,
path, rev, properties, raw }` through 4.x). Unknown ref →
`doc_missing: no node <ref>` (a `b_` id too, §9).

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

`diff <doc> [--from <rev>] [--to <rev>] [--blocks]` — `docs_diff_unified`.
`--to` defaults to the document's current revision, `--from` to the one
before it (or the current one again when there is only one → an empty
diff, stderr `  no changes`). Human: the unified diff's lines
(`spec/surface` §3, no header); `--json` the tool's result
`{ _id, _path, from, to, diff }` (5.0; the reference and the tool share one
function — `from`, `to`, `diff` are roles); `--jsonl`/`--ids` the same document. `--blocks` is the
block-grain `docs_diff` tool over the same resolved pair: human one line per
entry, `+ <id>  <first line of after>` (added), `- <id>  <first line of
before>` (removed), `~ <id>  <first line of after>` (changed), none → stderr
`  no changes`; `--json` the entry array
`[{ kind, _id, before?, after? }]` (5.0), `--jsonl` one per line, `--ids` the
block ids. Unknown doc → `doc_missing: no document <ref>`; unknown revision
→ `target_missing: no revision "<rev>" for document <id>` with
`data { doc, rev }`.

### `doctor`

`doctor [--json]` — six checks on the selected repo (five through cli 5.3;
through cli 5.x a
`convergence` check — `repos_status.unconverged === 0` — which store 17.0
retired with the count: identically true under I1): `fts rows == live leaf blocks` (the rows the index
holds — counted from FTS5's `blocks_fts_docsize` shadow table, since a
`count(*)` on an external-content table answers from `blocks` — against the
live leaf blocks of `spec/search` §1.1: live rows no live row names as
`parent_block`; detail `fts=<n> leaves=<n>`), `head present` (every live
document has a `docs.head`; detail `<n> without a head`), `bytes
reproducible` (cli 5.4, store 17.4: every live document of the selected
repository with a `file_hash` has `sha256(reconstruct) == file_hash` —
`spec/store` §5.11, C9 — re-derived IN FULL here and the repository's
`legacy_bytes` alert written to match, raised with the count and a sample
of ids or cleared, so the `alerts` check below sees the current condition;
detail `<n> document(s) not reproducible from their rows`; a document
ingested before block trivia was stored fails it until `omg sync` repairs
its rows from the file), `capture complete`
(every live head minted within the open coverage interval has its
`revisions` row — capture agrees with the head, `spec/store` §8 H1; detail
`<n> heads without a revision`; since cli 5.1 (store 17.1 Phase 4a) the
check reads the repository's manifest: with capture off it passes with the
detail `history disabled (captured <from>..<to>[, …])` (`history disabled`
when nothing was ever captured), on a build without the module `history
unavailable in this build`; through store 16.x the one check `no dangling
current_rev`), `alerts` (store 17.0,
slice 3e-ii: the selected repository's ACTIVE alerts, `spec/store` §3.1
`alerts` / §5.8 — `ok` iff there is none; detail `none active`, else every
active alert as `<code>[<severity>]: <message>` joined by `; `), `sqlite
integrity`. Human: `  ok <name>` per passing check,
`  x <name>  (<detail>)` per failing one; exit 1 when any fails. `--json`
(and every non-human mode) `{ ok, checks: [{ name, ok, detail }] }`. The
FTS check holds after a deletion (observed or `rm --doc`) and after
`rebuild-index --fts`. `admin::doctor-alert` pins the failing `alerts` check
in both modes over a stale pending row the fixture's `sql` device plants
(§8): the backlog alert names the row's age and the replay to run.

`doctor --size [--json]` (cli 4.3) — the **size report** instead of the
checks: what the workspace database is made of, and what would reclaim
space. It is `spec/store` §7 "Size" rendered: the store measures every
table through SQLite's `dbstat` virtual table (an index counts toward its
table, an FTS5 table's shadow tables fold into it), groups the tables into
the **six** categories the store spec assigns (`spec/store` §7.2; store
17.0 — four through store 16.x) — `content` (the live state: docs, blocks,
sections, nodes, the open edges, the rollup, external nodes, properties),
`identity` (the id claims and the resurrection pool), `recovery` (pending
materializations), `history` (blobs, tree nodes, revisions, commits,
dispositions, block changes, edge transitions, archives), `search` (the
FTS tables, embeddings) and `sync` (repos, sources, adapters, attachments,
the change feed and its entries — where `checkpoints` was — file stats,
settings, and anything the spec does not name — `sqlite_schema` among
them) — counts each table's rows, and derives the advice. Needs no repo
(the database is the workspace's; the `feed` line below is the selected
repository's when the selection resolves, else the store's only one); exit
0 — a size report is information, not a check — and an unreadable database
is the ordinary open error.

Human, on stdout: a header row `category  bytes  share  rows`, then per
category (always the six, in the fixed order content, identity, recovery,
history, search, sync) one line `<name>  <bytes>  <share>  <rows>` followed by its three
biggest tables (by bytes desc, then name) indented two more; the bytes
cell is the humanized size right-aligned in 9 columns (`4.0 KB`,
`788.0 KB`, `13.1 MB`; `<n> B` under 1024, else one decimal of a
1024-based unit, the tenths rounded half up), the share cell `<n>.<d>%` of
the dbstat total right-aligned in 6, the row count right-aligned to the
widest (at least `rows`); §4 columns otherwise. Then an empty line, then
the file block — `file  <path>`, `size  <bytes> on disk, wal <bytes>` (the
`-wal` file's, `0 B` when absent), `pages  <page_count> x <page_size>
bytes, <freelist_count> free`, `reclaimable  <bytes>`
(`freelist_count × page_size`: what a `VACUUM` returns to the filesystem),
(cli 4.6) `archived  <n> revisions in <s> segments, <bytes> on disk`
(`spec/store` §7 "Size" `archived`: the history already moved to archive
segments), (store 17.0) `id claims  <n> ids claimed` (`spec/store` §7.2
`id_claims`: one row per id ever minted and still held, §2.1), and (store
17.0, slice 3e) `feed  epoch <ep>, <n> entries, seq <oldest>..<head>`
(`spec/store` §7.2 `feed`: the change feed's epoch, retained rows and
position for the report's repository; `feed  no repository selected` when
the store has several and none resolved), and (store 17.0, slice 3e-ii) the
manifest's two lines for the same repository (`spec/store` §7.2
`capabilities`) — `history  enabled since <coverage_from>` (`disabled` when
the row says so or is absent; `no repository selected` like `feed`) and
`semantic  enabled (<model>)` (`enabled` when no model is configured,
`disabled` otherwise) — the keys padded to
`reclaimable`; then one `  advice: <text>`
line per advice. Without `dbstat` in the SQLite build the bytes and share cells are
`—`, the tables order by rows, and a line `  dbstat unavailable: row counts
only` follows the table (no fixture: both engines' builds have it).

The advice, in this order, each conditional (`spec/store` §7): `run \`omg
gc --vacuum\` to return <bytes> of free pages to the filesystem` when the
free pages exceed 1 MiB and 10 % of the pages; `history dominates
(<share>): blobs, tree nodes and dispositions grow with every commit —
enable gc (\`omg config set gc.enabled true\`) and run \`omg gc --vacuum\``
when `history` holds more than 50 %; `<n> same dispositions are history
nothing reads (store 14.2): \`omg gc\` removes them, \`--vacuum\` reclaims
the pages` when the `same` rows a pre-14.2 store wrote exceed 25 % of the
`dispositions` table (cli 4.5; never on a workspace the fixtures build);
`<n> revisions older than the policy would archive <bytes>: \`omg history
export --prune\`` when the retention plan of the store's repositories
(`spec/store` §7.1, each under its effective policy, at the spec clock)
would archive something worth more than 10 % of the `history` category
(cli 4.6; never on a workspace the fixtures build — every revision there is
younger than the default `keep_days`);
`embeddings are <share> of the
database: a smaller model (\`embedding.model\` / \`embedding.dim\`) or \`omg
embed drain --prune\` after a model switch shrinks them` when the two
embedding tables hold more than 25 %; `identity claims are <share> of the
database: set identity.claims_retain_days to release old ids` (store 17.0,
slice 3e-ii) when `id_claims` holds more than 10 %; `the feed holds <n>
entries over <d> day(s) (floors <retain_entries> / <retain_days>): raise
feed.max_entries or shorten the sync interval` (cli 5.2, store 17.2 Phase
4b — `spec/store` §5.8 `feed_capped`, §7.2) when the selected repository
has an active `feed_capped` alert (the write-time cap pruned rows; the
alert itself is printed to stderr as every alert is, `admin::doctor-size-
feed-capped` — the `sql` device caps the feed, a `meta` write prunes and
raises, `gc` clears); `nothing to reclaim`
when none applies.

`--json` (and every non-human mode — there is no list the machine modes
stream): `{ file: { path, bytes, wal_bytes, page_size, page_count,
freelist_count, reclaimable }, categories: [{ name, bytes, share, rows,
tables: [{ name, bytes, share, rows, indexes }] }], same_dispositions,
id_claims, archived: { revisions, segments, bytes }, feed: { epoch, oldest,
head, entries, retain_days, retain_entries, max_entries } | null,
capabilities: [{ capability, state, coverage_from, config }] | null, advice:
[string] }`
(+ `detail: "dbstat unavailable"` in the fallback, where every `bytes`,
`share` and `indexes` is `null`); `indexes` is the part of a table's
`bytes` its indexes take; `share` is one decimal; `same_dispositions`
(cli 4.5) is the `same` row count of `spec/store` §7, `0` on a 14.2 store;
`id_claims` (store 17.0) the `id_claims` row count of `spec/store` §7.2;
`feed` (store 17.0, slice 3e) the feed's position and effective policy
(`spec/store` §7.2, §7.4 — `epoch` a string, the rest integers);
`capabilities` (store 17.0, slice 3e-ii) the manifest of the same
repository (`spec/store` §7.2 — `history` then `semantic`, `coverage_from`
a timestamp or null, `config` the row's object), null like `feed`;
every other number is an integer of bytes or rows. Exact bytes: `admin::doctor-size`,
`doctor-size-json`, `doctor-size-jsonl`, `doctor-size-after-rm` — recorded
by shape (§8): the sizes and shares are `<bytes>`/`<share>`/`<number>`,
the names, order, row counts and advice exact.

### `done`

`done <blocks…|-> [--undo] [--actor <s>] [--dry-run]` — `blocks_check { _ids }`
(5.0; `--undo`: a `set _attrs.checked = false` effect — the kernel `update`
with `attrs: { checked: false }` — CAS pinned from the live row). Every block must be a live `task` block, checked before any op
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
`block_missing: no block with id "<ref>"`. The editor's own TTY interaction is
unpinnable; the fixtures use shell scripts as editors.

### `embed`

`embed [status]` · `embed enable [--provider <command|url>]` · `embed
disable` · `embed drain [--verbose] [--prune]` — semantic indexing: its
switch per repository (cli 5.2, store 17.2 Phase 4b — `spec/store` §5.10)
and the embedding queue. With no `embedding.provider` in the effective settings: stderr
`  no embedding provider configured — set one with \`omg config set embedding.provider <command|url>\` (e.g. omgbase-embedder)`,
exit 0, for both `status` and `drain`; `--json` `{"provider":null,"queued":0}`.

**`enable`** needs a provider: with `--provider <p>` it first writes
`embedding.provider` at the WORKSPACE layer (as `init --embedder` does — the
write re-derives every repository's semantic row whose provider changed),
then sets the selected repository's row `enabled` with an open coverage
interval; without a configured provider it is `usage: no embedding provider
configured — pass --provider <command|url>, or set one with omg config set
embedding.provider <command|url>` (exit 2). Stderr `  semantic enabled since
<ts> (provider <p>)`, already on: `  semantic already enabled since <ts>
(provider <p>)`. **`disable`** closes the interval and sets `disabled`; the
provider setting and the vectors stay. Stderr `  semantic disabled (embedded
<from>..<to>[, …])`, already off: `  semantic already disabled (embedded …)`
(`  semantic already disabled` when it never ran). `--json` for both `{
state, coverage: [{ from, to }], provider, changed }` (`changed` true when
the state moved, by the verb or by `--provider`'s write). Under the writer
lock. **While switched off with a provider configured** (the state only
`disable` leaves): `embed status` and `embed drain` are
`error[capability_unavailable]` `{ semantic, disabled, fix: "omg embed
enable" }` (the pinned message, exit 1), `query` with `semantic()` the
same, and `find` is FTS-only — nothing is spawned, so a broken provider is
not `embedder_failed` here. Unsetting the provider (`config set
embedding.provider ""`) flips the row to `disabled` by itself; a settings
write that leaves the provider as it was leaves the state alone. Exact
bytes under the fixture clock: `admin::embed-enable-no-provider`,
`embed-enable-disable`.
With a provider that cannot start, every semantic path (`embed`, `find`
without `--no-semantic`, `query` with `semantic()`) fails
`embedder_failed` with `data: { provider, reason }` — the `reason` is the
operating system's spawn error text and is **unpinned**. With a working
provider the status figures and the drain depend on the model — unpinned;
`spec/search` pins what is embedded.

### `execute`

`execute (-f <plan.json> | -) [--reason <s>] [--actor <s>]` — (cli 3.2) the
plan form of the `execute` tool (`spec/mutate` §11.7): the Plan JSON that
`apply -f <effects> --dry-run --json` printed, from `-f <file>`, `-f -` or a
bare `-` (stdin), admitted — `version` other than 1 →
`error[unsupported_plan_version]` with `{ version, supported: [1] }`, a core
whose digest no longer equals its `plan_id` → `error[plan_mismatch]` with
`{ expected, actual }`, a missing member → `error[filter_invalid]` — and
committed as one transaction with `origin.actor`/`reason`; a document that
moved on since the plan (an already executed plan included) →
`error[stale_plan]` with `{ doc, expected_revision, current: { revision, hash },
retriable: true }`, nothing written. Confirmation (§4, the Receipt form);
`--json` the Receipt. Neither `-f` nor `-` →
`usage: execute requires -f <plan.json> (or - for stdin)`; `--dry-run` →
`usage: execute has no dry run — the plan is the preview (re-plan with apply --dry-run)`.
Exact bytes: `mutate::execute-file`, `execute-stdin`, `execute-stale-plan`,
`execute-plan-mismatch`, `execute-unsupported-plan-version`.

### `find`

`find <text> [-n <N>] [-1] [-v] [--no-semantic]` — `blocks_resolve`
(`spec/search` §4 `resolve`); the positionals join with a space; `-n` (default 10) is the limit;
hybrid ranking when a provider is configured, FTS-only with `--no-semantic`
or without one. Human: `<id>  <locator>  <preview>` per hit; `-v` adds
`    <evidence as JSON>` on **stderr** under each; none → stderr
`  no matches`. `-1` prints the top hit's `_id` alone (nothing when there is
none). `--ids` the `_id`s; `--json` the hit array (`[{ _id, locator, preview,
evidence }]`, `spec/search` §4, 3.0 — `_id` the block row's, the rest roles);
`--jsonl` one hit per line.
No text → `usage: find requires <text>`.

### `gc`

`gc [--dry-run] [--vacuum]` — mark-and-sweep (`spec/store` §7), which
since store 14.2 also removes the `same` disposition rows a 14.1 store wrote
(`spec/store` §7 "The `same` sweep"). Refuses
unless `gc.enabled` is true in the effective settings:
`error[target_missing]: gc is disabled; set gc.enabled=true (or use --dry-run)`
(§9: the code). `--dry-run` (the command's own or the global flag) is
allowed regardless and deletes nothing — it counts all three sweeps. Human
(stderr) `  swept <b> blobs, <t> tree nodes, <s> same dispositions` (cli
4.5; through 4.4 the line stopped at the tree nodes); `--json`
`{ blobsSwept, treeNodesSwept, sameDispositionsSwept, claimsReleased,
feedPruned }`
(`claimsReleased` since store 17.0: the id claims whose core hold the prune
released under `identity.claims_retain_days`, `spec/store` §7.3; the human
line gains `, <n> id claims released` only when it is non-zero — the setting
is off by default; `feedPruned` since store 17.0 slice 3d: the change-feed
rows pruned under `feed.retain_days` / `feed.retain_entries`, `spec/store`
§7.4, the human line gaining `, <n> feed rows pruned` only when non-zero).
On a workspace
this spec's fixtures build every count is `0`: a fresh store has no `same`
rows to sweep, no claims policy and a feed well within the default floors.

`--vacuum` (cli 4.3) runs `VACUUM` after the sweep (`spec/store` §7
"Vacuum") — the sweep's freed pages are what it returns — under the same
refusal (`gc-vacuum-disabled`: `--vacuum` alone is not a dry run). Human
adds a second stderr line, `  vacuumed, reclaimed <bytes>` (the free pages'
bytes before the VACUUM, humanized as in `doctor --size`); the result gains
`vacuum: { reclaimable, applied: true }`. With `--dry-run` nothing is
vacuumed: the line is `  would vacuum <bytes>` and `applied` is `false`.
Exact bytes (recorded by shape, §8): `admin::gc-vacuum`,
`gc-vacuum-dry-run`, `gc-vacuum-dry-run-json`, `gc-vacuum-disabled`.

### `help`

See §5.

### `hist`

`hist <node> [-n <N>]` — `blocks_history` for a block (a document ref, or an
unknown id, is `block_missing: hist needs a block id; got <ref>`). Human,
newest first: `#<seq> <kind>[ (<confidence to 2 decimals>)] <origin> <ts>`;
none → stderr `  no history`. `--json` the change array; `--jsonl` one per
line; `--ids` the same array (a change carries no id).

### `history`

`history enable [--best-effort]` · `history disable` (cli 5.1, store 17.1
Phase 4a) · `history purge [--before <ts>]` (cli 5.2, store 17.2 Phase 4b) ·
`history plan [--before <ts>] [--policy <json|@file>]` ·
`history export [--prune] [--dest <dir>] [--before <ts>] [--policy <json|@file>] [--dry-run]` ·
`history attach <file|dir>` · `history detach <segment_id|path>` ·
`history list` — the operator surface of history CAPTURE (`spec/store`
§5.9: `enable`/`disable` switch the selected repository's capture through
its manifest row) and of history RETENTION ((cli 4.6) `spec/store` §7.1,
15.0: which revisions the policy would move to an archive segment, writing
the segment, squashing the store, and the segment registry). Needs a repo
(`repo_not_found` on a workspace without one, as every repo verb); not
`--server`; a bare `history`, `history help` and `--help` print the card
(§5); an unknown subcommand is `usage: unknown history subcommand '<x>'
(enable|disable|purge|plan|export|attach|detach|list)` with the card as hint.

**`enable`** turns capture on (`spec/store` §5.9): the history bundle's DDL
when absent, the **baseline** commit — one `import` feed row, `reason`
`history enabled`, a `changed` entry per live document under its existing
head, a checkpoint revision for every head the recorder does not hold — and
the manifest row `enabled` with a new open coverage interval and
`writer_requires` 1 (`--best-effort`: 0 — a writer without the history
module may still write). Under the writer lock. Stderr `  history enabled
since <ts> (baseline <commit>: <n> revision(s))`; on a repository already
enabled nothing changes: `  history already enabled since <ts>` (`<ts>` the
open interval's start). `--json` `{ state, coverage: [{ from, to }], writer_requires,
changed, baseline?: { commit, revisions } }` — the row's capture state,
`baseline` when the enable wrote one. On a build without the history module
(the `OMGBASE_CAPABILITIES=core` override) it is `error[capability_unavailable]`
`{ history, unavailable }`. **`disable`** turns capture off: the open
interval closes at the process clock, `writer_requires` 0; the rows stay
and what was captured stays readable; later writes record nothing but the
feed (`log` shows them without disposition counts). Stderr `  history
disabled (captured <from>..<to>[, …])`; already off: `  history already
disabled (captured …)` (`  history already disabled` when nothing was ever
captured). `--json` the same shape without `baseline`. Needs no module.
Exact bytes under the fixture clock (every interval boundary is the clock):
`history::history-enable-already`, `history-disable-then-write` (the
writes after a disable — `meta`, `update` — commit, `log` lists them bare,
`hist` lists a block's captured changes only, `diff` compares the captured
revisions, `doctor`'s `capture complete` reads `history disabled (captured
…)`, `version --json` by shape), `history-enable-after-disable` (the
baseline as `#22 import import(?): … — changed` for every document, the
next edit captured, `diff` and `history plan` over the baseline's
revision), `history-enable-best-effort`, `history-core-build-writer-
refused` (under `env: { OMGBASE_CAPABILITIES: "core" }`: a write on the
alchemy repository is `error[capability_unavailable]` with the
`writer_requires` message and the `writer_refused` alert raised; `version
--json` reports `unavailable`; `hist` is refused; `history disable` turns
capture off; the same write then lands and clears the alert; `history
enable` is refused). `--policy` is a JSON object merged over the
repository's effective `history.retention` settings for the run
(`@<file>` reads it from a file); not JSON →
`usage: --policy: not JSON (pass an object, or @file)`; a malformed key →
`usage: --policy: <the policy error>` (`policy.keep_days must be a
non-negative integer`). `--before` is an RFC 3339 instant (`usage: bad
--before '<x>' (use an RFC 3339 instant)`); only revisions committed
strictly before it are candidates.

**`purge`** deletes the repository's captured history (`spec/store` §7.6):
every commit, or with `--before <ts>` (an RFC 3339 instant, `usage: bad
--before '<x>' (use an RFC 3339 instant)` otherwise) those strictly before
it — a live document's head revision and its commit stay while capture is
on; the first retained revision after a cut is re-checkpointed; the
recorder's id holds are released on what nothing names any more (the live
set keeps them while capture is on); when no repository is enabled and
every history table is empty afterwards the bundle's tables are dropped.
Coverage is not rewritten (a purged token reads `pruned`, `spec/surface`
§3). Under the writer lock. Stderr `  purged <c> commit(s), <r>
revision(s), <d> disposition(s), <b> block change(s), <e> edge
transition(s), <s> segment(s); swept <x> blob(s), <y> tree node(s);
released <n> id claim(s)` then `  history tables dropped` when they were;
nothing to do: `  nothing to purge`. `--json` the receipt `{ purged: {
commits, revisions, blobs, tree_nodes, dispositions, block_changes,
edge_transitions, archives }, claims_released, coverage, tables_dropped }`.
Afterwards a purged revision asked of `diff --from <rev>` is
`error[capability_unavailable]` `{ history, pruned, rev }`; on a database
whose tables were dropped `hist` and `diff` are `{ history, disabled }`
(nothing is captured in it), `log` still lists the feed, and `history
enable` re-creates the tables with a baseline. Exact bytes:
`history::history-purge-disabled` (disable, purge the whole alchemy
history — 20 commits, the tables dropped — a second purge, `--json`, the
reads, a write, `enable`), `history-purge-before-enabled` (a `meta` write,
`purge --before` one millisecond past the clock purges the one commit whose
revision is no longer a head, `diff --from r_17` is `pruned`, `hist`, the
same purge again, a bad `--before`).

**`plan`** evaluates the policy at the process clock and prints, on stdout,
a §4 table `path  revisions  keep  archive  bytes` (one row per document
with something to archive, by path; the counts right-aligned; `bytes` the
humanized logical bytes of `spec/store` §7.1 — blobs and tree-node entries
reachable from the archived revisions alone — so the line is exact, not a
shape), then the summary `  <a> of <r> revisions in <d> document(s) would
archive <bytes>` or `  nothing to archive: <r> revisions, all kept`, then
`  policy  <the effective policy as compact JSON>` and, when given, `
before  <ts>`. `--json` the plan verbatim (`spec/store` §7.1: `{ policy,
now, before, docs: [{ id, path, revisions, keep, archive, bytes }], totals
}`); `--jsonl` one document per line; `--ids` the document ids. Exact
bytes: `history::history-plan-nothing`, `history-plan`,
`history-plan-json`, `history-plan-policy-file`, `history-plan-before`,
`history-plan-bad-policy`, `history-plan-not-json`,
`history-plan-bad-before`.

**`export`** writes ONE new segment file (`spec/store` §7.1: a SQLite
database with `archive.sql`'s DDL, named
`<repo_id>-<seq_lo>-<seq_hi>-<segment_id>.omgarchive.db`) under `--dest`
(resolved against the cwd; created) or `<workspace>/.omgbase/archives/`,
holding the bodies of the revisions the plan archives — and with `--prune`,
under the writer lock, squashes the store afterwards (the archived
revisions lose their bodies and gain `archive`, the wholly archived
commits' dispositions and non-earliest block changes go, the unreachable
blobs and tree nodes are swept, the segment is recorded). Stdout the
segment's path; stderr `  wrote segment <id>: <n> revision(s) (commit #<k>
| commits #<lo>–#<hi>), <bytes>` and with `--prune` `  squashed <n>
revision(s), <c> commit(s), <d> disposition(s), <b> block change(s); swept
<x> blob(s), <y> tree node(s)`. The crash rule (`spec/store` §7.1): a
complete, unrecorded segment under the destination whose revisions are
still live — what a crash between the two phases or an export without
`--prune` leaves — is finished instead of writing a new file, the first
line reading `  finished the unrecorded segment <id>: …`; a stale one is
`target_missing` with `data { path, rev }`. Nothing to archive → stderr `
nothing to archive`, no file, exit 0. `--dry-run` (the flag or the global)
is `plan`. `--json` `{ segment: { id, path, seq_lo, seq_hi, created_at,
revision_count, bytes, previous_segment } | null, reused, squashed: {
revisions, commits, dispositions, block_changes } | null, gc: { blobs,
tree_nodes } | null, totals }`. Exact bytes (the file sizes by shape, §8):
`history::history-export-dry-run`, `history-export-nothing`,
`history-export`, `history-export-prune`, `history-export-prune-json`,
`history-export-dest`, `history-export-reuses-pending`.

**`attach <file|dir>`** records a segment (idempotent: an already recorded
segment's path is re-recorded) or every `.omgarchive.db` of a directory
whose manifest names this repository (the rest are skipped and counted);
stderr `  attached <id>: <n> revision(s) (<commit range>) <path>` per
segment, `  skipped <n> file(s) that is/are not this repository's segments`
when any, `  nothing to attach` for an empty directory. A missing path or a
file that is not a segment, or one of another repository, is
`target_missing: <path>: no such file | not an archive segment | a segment
of repository <rp_x>, not <rp_y>` with `data { path }`. `--json` `{
attached: [{ segment_id, path, seq_lo, seq_hi, revision_count, bytes }],
skipped }`. **`detach <segment_id|path>`** forgets a segment (a ref holding
`/` or ending in `.db` is a path, resolved against the cwd): stderr `
detached <id>`; `--json` `{ detached }`; unknown → `target_missing: no
archive segment "<ref>"` with `data { segment }`. A detached segment's
revisions stay listed everywhere; reading one's bytes (`diff`, `cat` at a
revision through the surface) is `error[revision_archived]: revision "<rev>"
is archived in segment <id>, which is not attached (omg history attach
<file>)` with `data { rev, archive }` (`path` added when the segment is
recorded but its file is gone). **`list`** prints the §4 table `segment
commits  revisions  bytes  state  path` over the repository's recorded
segments (`attached` / `missing`) followed by the unrecorded ones under the
default archives directory (`pending` / `detached` / `stale`, `spec/store`
§7.1); none → stderr `  no segments`. `--json` the listing array (`[{
segment_id, path, seq_lo, seq_hi, revision_count, bytes, created_at, state
}]`), `--jsonl` one per line, `--ids` the segment ids. Exact bytes (sizes
by shape): `history::history-detach-attach`, `history-attach-dir`,
`history-attach-not-a-segment`, `history-attach-missing`,
`history-detach-unknown`, `history-list-empty`; the refusals
`history-no-repo`, `history-no-workspace`, `history-unknown-sub`,
`history-attach-no-arg`, `history-detach-no-arg`,
`history-server-rejected`; the card `invoke::help-card-history`,
`help-card-history-bare`, `help-card-history-word`.

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
`<to>` must be a container (`list`, `list_item`, `task`, `blockquote`, `table`) or a document; a leaf such as a heading is the kernel's `type_mismatch` with its hint (`spec/mutate` §1.1, 1.2 — §9).
Confirmation (§4); `--json` the Receipt. Missing parent →
`usage: insert requires a <to> parent (a container block id, or a doc id/path for the top level)`;
unknown → `block_missing: no block with id "<ref>"`.

### `links`

`links <node> [--in|--out] [--pred <p,p>] [--blocks]` — `docLinks` for the
node's document (a block ref reports its document). Human: `  out` then
`    <predicate> > <doc_id> ×<count>` per outgoing group, `  in (backlinks)`
then `    <doc_id> > <predicate> ×<count>` per incoming group; `--in`/`--out`
alone select a direction (both together mean both); `--pred` keeps the
listed predicates; groups are ordered by the far node's id as text; none →
stderr `  no links`. `--blocks` is block-grain: one row per open edge,
ordered by (predicate, doc_id, block_id), the source block beside the far
node — `    <predicate> > <doc_id> (<block_id>)` out, `    <doc_id>
(<block_id>) > <predicate>` in (`(frontmatter)` for a block-less relation),
no count. `--ids` the far node ids (out, then in); `--json` the
`{ out: [{ _predicate, _doc_id, kind, count, samples? }], in: [...] }` object
(`_doc_id` is the far node: a document id, or for an outgoing external or
phantom edge that node's id; `--blocks`: `count` is 1, no `samples`, plus
`_block_id`) — 5.0: the keys that carry a link row's attributes take the
engine names (`predicate`/`doc_id`/`block_id` 3.0–4.x, `node`/`block`
before 3.0); `kind`, `count` and `samples` are the grouping's own and stay
bare. `docLinks` is a library read with no tool of its own, so this shape is
the CLI's; `--jsonl` the same object (it is not a list). Unknown ref →
`doc_missing: no node <ref>`.

### `log`

`log [--since <24h|7d|ISO>] [--cursor <n> [--epoch <ep>]] [--origin
api|observed] [-n <N>]` — `changes_since` from a feed cursor (`spec/surface`
§3, 6.0: the pair `(epoch, seq)`; `--epoch` names the cursor's epoch and
defaults to the repository's current one; a cursor the feed no longer serves
— another epoch, past the head, pruned behind the oldest retained row — is
the `expired_cursor` envelope, exit 1). `--since` is resolved
**client-side** to a cursor: a relative age (`/^(\d+)([hdwm])$/`, hours,
days, weeks, 30-day months) or an absolute timestamp becomes an instant
(against the pinned clock), and the cursor is the highest retained feed
`seq` whose `ts` is strictly before it (so `--since` equal to every commit's
`ts` returns them all; an instant before the oldest retained row is cursor
`oldest − 1` — everything the feed holds; cursor 0 itself is
`expired_cursor` on a feed pruned to `oldest ≥ 2`, `spec/surface` §3, so a
bare `log` with neither flag surfaces the envelope there and the user
continues with `--cursor <oldest − 1>`); anything else is
`usage: bad --since '<v>' (use a relative age like 24h or 7d, or an ISO timestamp)`,
exit 2. Human, oldest first: `#<seq> <origin padded to 8> <summary>` — the
digest's summary, composed from its feed entries (`spec/surface` §3, 6.0,
unpinned there; pinned here by the cases): `observed: <path> — created`,
`api(<actor>): <path> — changed — 12 edited, 1 inserted` (the disposition
counts follow when the history capability holds the commit), a deletion
`observed: deleted <path>` / `api(<actor>): deleted <path>`, a move
`api(<actor>): moved <from> → <to>` (the moved document's own entry —
D11; the rewritten sources follow after `; `), several documents joined by
`; `. None → stderr `  no changes`;
truncated → the footer with the next seq. `--json` the
`{ digests, cursor, epoch, oldest, head, truncated }` result (`spec/surface`
§3 — a digest's `revisions` are `[{ _id, _path, _hash, kind, from_path? }]`,
6.0); `--jsonl` one digest per
line plus the footer; `--ids` the commit ids plus the footer.

### `ls`

`ls [<glob>] [--ids|--json|--jsonl]` — `docs_list`, every page walked. The
glob is a path pattern with `*` matching any run of characters, in either
path form. Human: a column table of `<path>` (rooted), `<n> blocks` (right-aligned), the relative time
(§4, right-aligned); none → stderr `  no documents`. `--ids` the `_id`s
(3.0; the paths before); `--json` the row array `[{ _id, _path, _updated_at,
blocks }]` (5.0 — `docs_list.items[]` under the engine names; `blocks` is a
count, a role); `--jsonl` one row per line.

### `mcp`

`mcp [-C <workspace-dir>] [--repo <slug>] [--no-watch] [--tools full|minimal]`
— the MCP server on stdio (`spec/surface` §4, §7). `--tools` (cli 4.2) picks
the catalog profile of `spec/surface` §4 "Profiles" (`full`, the default, or
`minimal`); it overrides the workspace's `mcp.tools` setting, and any other
value is the usage error `usage: --tools must be one of full|minimal (got
"<value>")`, exit 2, before the workspace is opened (an unrecognized
*setting* value is reported on stderr and the full catalog served). Pinned:
the card; `mcp --tools <bad>` (`invoke::mcp-bad-tools`); the seam
announcements on stderr when the seams are set —
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
`{ _id, _path, committed }`. Neither `--set` nor `--unset` →
`usage: meta requires --set or --unset`; a value without `=` →
`usage: --set expects k=v, got '<v>'` / `usage: --set-json expects k=json, got '<v>'`.
`--dry-run`: the patched file's diff (§3.6).

### `move`

`move <blocks…|-> --to <parent> [--at …] [--expect <parent_children_hash>] [--actor <s>] [--dry-run]`
— a `move` op (`--at`/`--expect` as `insert`). Confirmation lists the moved
ids. Missing `--to` → `usage: move requires --to <parent>`; no blocks →
`usage: move requires one or more blocks (or - for stdin)`.

### `mv`

`mv <doc> <new-path> [--no-retarget] [--actor <s>] [--dry-run]` —
`docs_move`: the file is renamed, identity and history preserved, and the
inbound links that named the old path are rewritten to the new one
(`spec/mutate` §6, 1.3 — a second `api` commit,
`retarget inbound links <old> -> <new>`). Confirmation (§4) `moved to
<new-path>`, then when anything was rewritten
`  ok retargeted <n> inbound link(s) in <m> document(s)` (`link`/`document`
for one); `--json` the `DocMoveResult`
`{ _id, _path, committed, dangling: [{ _doc_id, _path, _block_id, target,
_anchor, _field? }], retargeted }` (5.0 — a dangling entry is a `links` row
under its engine names; `target`, `retargeted` and `committed` are roles).
`--no-retarget`
(cli 1.2) passes `retarget_inbound: false`: the links are left as written
and listed in `dangling`. Whatever still dangles is reported on stderr after
the confirmation: `  ! <n> inbound link(s) still name(s) the old path:
<path> <block>, …` (`<path> (frontmatter)` for a block-less relation), then
the fix for each kind — `  fix: omg retarget /<old path> /<new path>
--apply` when an authored link dangles, and one
`  fix: omg meta <path> --set <field>=/<new path>` per (source, field) for a
frontmatter relation (a move never rewrites frontmatter); nothing when none
dangle. Unknown → `doc_missing: no document <ref>`; taken →
`path_taken: a document already exists at <path>`. `--dry-run`: the rename
as two file diffs plus the diff of every source the retarget would rewrite
(§3.6), then the same dangling note (no retargeted line).

### `new`

`new <path> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]` —
`docs_create` from complete file bytes (frontmatter included, `-m`
verbatim; the tool's `path` argument is where to create — a role, bare).
Confirmation (§4) `created <path>`; `--json`
`{ _id, _path, committed }`. Existing →
`path_taken: document already exists at <path>` (with the `{}` payload,
§9). `--dry-run`: the would-be file's diff (§3.6), nothing created.

### `node`

`node set <nodeId> <prop> <value> [--actor <s>] [--dry-run]` ·
`node props <nodeId>` — `nodes_set` / `editablePropsFor`. `props`: human
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

`query <source> [-n <N>] [--cursor <c>] [--bare] [--ids|--json|--jsonl]` ·
`query -f <file|->` — `query` (`spec/surface` §1). The source is the
positionals joined by a space, or the file / stdin. Rendering by the
result's consumer: `count`/`exists`/`none` → the scalar (`13`, `false`,
`true`); a `values` projection → one value per line (strings verbatim,
others as JSON; `--jsonl` all as JSON); otherwise the hit table (§4); no
hits → stderr `  no hits`; truncated → the footer with the cursor; (cli 4.4)
the result's `hints` (`spec/surface` §1.5: names the query reads that no row
of their kind carries) → one stderr line `  hint: <text>` per entry, LAST, in
every human rendering (scalar, values, table, `no hits`); the machine modes
carry the member itself (`query::unknown-name-hint`, `unknown-name-no-hits`,
`unknown-name-hint-json`; a links field is the error: `unknown-field-on-links`). `--ids`
the hit ids (`_id`); `--jsonl` one hit per line (`{ _id, _path, ... }`);
`--json` the whole `OqxResult` (`{ hits, truncated, cursor, consumer, count?
| exists? | none? | values?, hints? }`, every hit `{ _id, _path, ...projection }` —
`spec/surface` §1.4, 5.0; copy a hit's `_id` into the next `where _id == "…"`
unchanged; the source itself spells engine names with the underscore and
authored keys bare — `omg q 'docs { select _title, _path where layer ==
"canon" }'` — and a bare `title`/`id`/`path` reads the authored key, with the
result's `hints` pointing at `_title`/`_id`/`_path` when no document carries
one). `--bare` (4.1) is the tool's `bare: true` passed through
(`spec/surface` §1.4, 4.2): every hit is its projection alone, rendered as
the bare table (§4) — no `_id`/`_path` columns — and `--json`/`--jsonl` print the
bare hits; paging, `-n` and `--cursor` are unchanged (`query::bare`,
`bare-json`). Its refusals are the surface's, rendered as every
`filter_invalid`: without a `select` — "`bare` needs a `select` — without a
projection a hit is only its envelope" (`query::bare-needs-select`) — and
beside `values`. `--bare --ids` has no id to print and prints the document,
as `--ids` does for a scalar result.
An empty or missing source is
`usage: query requires a <source> (or -f file|-)`, exit 2. An OQX error
(lex, parse, eval) and an invalid `--cursor` are `filter_invalid` — the
OQX message, `data { reason: <message>, hint: "OQX" }`; `invalid cursor`,
`data { reason: "cursor was not issued by query", hint: … }` — as the
`query` tool reports them; an unknown root is `filter_invalid` naming the four
collections (surface 3.0 name pass, §9).
`semantic(...)` without a provider →
`error[provider_unavailable]: semantic(...) needs an embedding provider`
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
— **plan by default**: without `--apply` it is `plan { effects: [retarget] }`
(4.0; the `links_retarget` dry run before) and prints, per hit of the Plan's
`preview.retarget[0].hits`, the block id then the unified diff of the block's
old and new raw (`spec/surface` §3's diff, the one every preview prints),
then an empty line, under the stderr note
`  plan — <n> block(s) would change; re-run with --apply to commit`; no hits →
stderr `  no blocks reference <from>`. `--json` the plan
`{ from, to, hits: [{ _id, _path, oldRaw, newRaw }] }` (the hits under the
row rule, 5.0: `_id` the block, `_path` its document, rooted; `oldRaw`/
`newRaw` roles). `--apply` commits
the `links_retarget` tool's call (the Receipt + `hits` + `pairs`; `--json`
prints it) through the Receipt confirmation (§4) and honors `--dry-run` as
§3.6 (the plan's per-file diffs). Targets are
compared as written: `/texts/x.md` for a Markdown link, `salt` for a
wikilink. `--scope` is a path glob over the documents searched.

### `rm`

`rm <blocks…|-> [--actor <s>] [--dry-run]` · `rm --doc <doc> [--actor <s>] [--dry-run]`
— a `remove` op (confirmation lists the removed ids; `--json`'s result
carries `removed`), or with `--doc` `docs_delete` (document-op confirmation
`deleted <path>`; `--json` `{ _id, _path, committed }`; the file leaves the
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
— the authored keys bare and the computed ones under their engine names,
`_title` (5.0; `title` through 4.x) — then `  out links` / `  backlinks` as
`links` renders them (each section only when non-empty). A block:
`  <type glyph> <type>  <id>`, the rule,
`  placement  parent=<parent_id|—> ordinal=<n> depth=<n>` (the row's
`parent_id`/`_ordinal`/`_depth`, 5.0; the line's words are text), `  attrs`
with `    <k> = <v>` lines when any (the attrs keys, the author's),
`  text  <text>` when any, and with
`--include history` `  history` then `    #<seq> <kind> <origin> <ts>` for the
last five changes. Several refs print one card after another. `--json`: a
block's `blocks_read` at `full` (+ `history` when included); a document's
`{ kind: "document", _id, _path, rev, properties: { frontmatter, inline,
computed }, _raw }` — `docs_read`'s result under `kind`, composed by the CLI
(the card's merged properties and links are the human rendering only); one ref → the object, several →
an array; `--jsonl` one object per line; `--ids` the same as `--json`.

### `source`

`source <add|list|attach|detach|rm> …` — the source registry of `spec/sync`
§2. `add <dir> [--repo <slug>] [--name <n>] [-y] [--no-history]`: `<dir>` must exist
(`target_missing: no such directory: <abs>`); the repo is `--repo` or the
directory's basename, the source `--name` or `<slug>-fs` (an existing name is
`path_taken: a source named '<n>' already exists`); it creates the repo —
with capture on from its birth, or **off** with `--no-history` (cli 5.1,
store 17.1 Phase 4a, `spec/store` §5.9: the manifest row `disabled`, no
coverage, no history table; the import itself writes no history row;
`omg history enable` turns it on later) —
registers and attaches the source, runs the initial freshness sweep and
rebuilds the stat cache; stdout `  * <slug> ← <abs> <n> files`; `--json`
`{ repo, repoId, source, root, ingested }`. `admin::source-add-no-history`
pins the flag (`doctor --size --json` with an empty `history` category and
the `disabled` manifest row, `version --json`, `log`, `doctor`). Without `-y` a TTY prompts (with
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

### `version`

`version [--json]` — (cli 1.1) the `version` tool of `spec/surface` §4,
rendered as aligned `key  value` lines: `engine`, `version`, then one line
per `components` entry (`  <name>  <version>`), then `specs` as one line
(`oqx 0.13 · store 13.5 · …`, in the tool's key order), `schema`, `mcp`
(`<protocol>` + ` (sdk <version>)` when present), `runtime`, `commit`,
`built` (`—` for null). Needs no repo; opens the workspace only for `schema`
(`—` when there is none, exit 0). `--json` is the tool result verbatim.
Fixtures record every leaf value as its type name (`<string>`, `<number>`,
`<null>`), in human output too (each value cell becomes its type name), so
both binaries pin the same shape while printing their own numbers. The two
engine-specific parts are recorded as one token: in JSON `components` becomes
`"<object>"` and the optional `mcp.sdk` is dropped (`spec/surface` §6); in
human output the indented `components` lines collapse into one `  <object>`
line and the whole `mcp` cell — protocol and any `(sdk …)` suffix — is one
`<string>`. `commit` and `built` are null or not by build environment (a git
checkout or not), so both modes record them as `<string|null>`. A human
value cell's type is the tool leaf's, decided by its key (`—` → `<null>`,
`schema` → `<number>`, else `<string>`), not read off the text. The keys are
aligned to the widest (`version`/`runtime`, 7). The `--version` flag (§2.5)
stays the one-line form. Since cli 5.1 (surface 6.1) the `capabilities`
member of `--json` is the SELECTED repository's manifest rendering
(`coverage_from`, `writer_requires`, `model` — by shape, so `coverage_from`
reads `<string>` on a repository that ever captured and `<null>` on one that
never did), the workspace layer's when none selects; the human rendering is
unchanged.

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
`<n> deleted`, `<n> drifted`, `<n> untracked`,
`disk unverified` (a sourceless repo), or `unconverged` (store 17.0 retired
the DB-internal `<n> behind` with `repos_status.unconverged`); the
`commits` figure and `commit#` are the feed's head. `queue` is
`empty` or `<n> queued`. `--json` (every machine mode) the two tools'
results as they are on the wire (`spec/sync` §4.4, 4.0):
`{ ...repos_status, sync: sync_status, watcher, embedQueue }` =
`{ _id, slug, rootPath, docs, blocks, feed: { epoch, oldest, head }, openEdges, disk: { changed, deleted, untracked, checked }, sync: { epoch, oldest, head, lastBatch: { ts, batchId, files } | null, convergent, diskChecked, disk, capabilities }, watcher: "live"|"none", embedQueue }`
(`_id` is the root row's id under the engine names, 5.0 — `repos_status`
spelled it `id` through 4.x; `rootPath` is `""` for a sourceless repo, as
`repos_status` reports it; through cli 5.x `commits`, `unconverged`,
`sync.lastCommitSeq` and `sync.lastCheckpoint`).
`embedQueue` is the embedding queue depth of `spec/search` §2.3 — the
embeddable blocks (live leaves of ≥ 24 tokens, §2.1) whose current
`(content_hash, ctx_hash)` has no cached vector for the `embedding.model`
setting when one is named, else for any model — counted from the cache
without a provider (58 for the alchemy fixture with no vectors).

### `sync`

`sync [--watch]` · `sync --server <cmd|url> [-H …]… [--root <dir>] [--out]`
— one-shot: the freshness sweep (§3.7), human: the wordmark `sync`, the rule,
`  scanned   <n> files`, then `  ok ingested  <n>` with `      <path>` per
file, `  x deleted   <n>` with paths, `  ! conflicts <n>` with paths,
`  ok repaired  <n>` with paths (cli 5.4 — the legacy documents whose
separator bytes the sweep repaired from their files, `spec/sync` §4.3 step
5 / `spec/store` §5.11; no commit), or
`  already up to date` when nothing changed; `--json` (every non-human mode)
the `SweepResult` `{ batchId, ingested, suppressed, deleted, conflicted, failed, scanned, candidates, changed, materialized, repaired }` (`batchId` — `spec/sync` §4.1, 4.0: the first committing member's commit id, `null` when the sweep committed nothing; `checkpointId` through cli 5.x; `repaired` since cli 5.4)
— `materialized` (3.1) is the sweep's step 0 (`spec/sync` §4.3): the paths
whose pending materialization rows (`spec/store` §5.7) it replayed before
the walk, `/`-rooted like the other lists and `[]` in every fixture (a
fixture cannot crash the engine between a commit and its file half). The
human rendering does not mention it. `repaired` is likewise `[]` in every
fixture (a fixture workspace has no legacy rows); `omg sync` after a
migration is where it is non-empty (`docs/modular-core/migration-runbook.md`).
A sourceless repo: stderr `  <slug> has no filesystem source — nothing to sync`
(an empty-result note, §3.1), `--json`
`{"scanned":0,"ingested":[],"deleted":[],"conflicted":[],"changed":false,"materialized":[]}`.
`--watch` (a long-running process: lease, adapter, checkpoints, signals) and
`--server` (the remote coordinator) are **unpinned** — their output depends
on timing and on a second process; only the card is fixed.

### `update`

`update <block|doc> (-m <markdown> | -f <file> | -) [--expect <hash>] [--reason <s>] [--actor <s>] [--dry-run]`
— polymorphic on the target. A **`b_`-prefixed token** is the block path:
an `update` op replacing the block's markdown (a token that names no live
block is `block_missing: no block with id "<ref>"`, never a document lookup);
without `--expect` the
CAS is pinned from the live row and stderr says
`  updating <ref> (CAS pinned from current bytes)`; with it, a mismatch is
`stale_expectation: content hash mismatch` with the current hash and
markdown; confirmation (§4). **Anything else** — a document id or a path —
is the whole-document update: one `set content` effect
(`spec/mutate` §11.3; locally `applyEffects`, remotely the `docs_update`
tool — its sugar, `spec/surface` 4.0) reconciling the bytes against the
current tree and committing the derived ops as one transaction. `--dry-run`
— the plan (locally `planEffects`, remotely the `plan` tool over the same
effect; 4.0: the `--plan` alias is gone, `docs_update { dry_run: true }` was
the call before): stderr `  plan for <path>`, stdout the identity
consequences from the Plan's `preview.identity[<doc id>]`
(`renderIdentityPlan`: one `<OP> <target>     <disposition> [<reason>]`
line per op, an empty line, the `preserved: n  updated: n  …` summary line
— byte-identical to the 3.x opset rendering, minus the never-returned
non-convergent warning: content the planner cannot reproduce is
`error[plan_not_convergent]`). A commit: the Receipt confirmation (§4)
`  ok committed · 1 document touched` on stderr (`0 documents` when the
content already is the document — nothing commits, `spec/mutate` §11.7),
stdout every id the plan's results name once, in order of first appearance.
`--json` the Plan (dry run) or the Receipt. A sourceless repo →
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
| `…[i]` then `….field` | one index (1-based) then one shallow field (`[A-Za-z_]\w*`, optionally `$`-prefixed for an OQX-named projection: `@1._id`, `@t[1]._path` — a hit's identity —, `@1.title` an authored key, `@1.$depth`), in that order, no deeper — any projected key, as the result spells it |

A **collection** result replaces the frame and prints, on stderr,
`  <n> row(s) — address with @1..@<n>` (`1 row`, `2 rows`; nothing when
empty). Collections: `query`/`run` hits (row ref = `_id`, label `_path`;
5.0), `ls` rows (ref = `_id`, label `_path`), `find` hits (`_id`), `links` (out then in; ref = `_doc_id`), a write's
Receipt (the ids the write names, flattened; ref = the id), any array. A
card or scalar (`show`, `cat`, a count) sets `@_` and leaves the frame.
**Not captured** at all (they leave `@_` and the frame untouched): `log`,
`hist`, `outline`, `diff`, `status`, `repos`, `sync`, the admin verbs (§9).
`cat` captures the bytes (a string) for a document, the `blocks_read` object
for a block; `show` a document captures the card object.

Substitution coerces a row to its ref; a scalar to its string; an object
with `_id`/`_doc_id`/`_block_id`/`node`/`block`/`locator`/`_path`
(in that precedence; 5.0 — the `$id`/`id`/`$path`/`path` tolerance of
`REF_KEYS` is gone, so a 4.x server's rows no longer address by their
envelope: the bare namespace is the user's, and a bare `id` on a row is an
authored key, never the identity) to that; a bare collection is
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
      "sql": ["<statement>", …],
      "stdin": "…", "argv": ["…"], "pin_stderr": true,
      "expect": { "exit": 0, "stdout": "…", "stderr": "…" } },
    { "name": "…", "workspace": "…", "env": {…}, "files": {…}, "sql": […],
      "steps": [ { "argv": [...], "stdin": "…", "env": {…}, "files": {…}, "sql": […], "pin_stderr": true,
                   "expect": {…} }, … ] }
  ] }
```

Suites: `invoke.json` (the invocation model, help, seams), `read.json`,
`query.json` (with `run`), `history.json` (`log`, `hist`, `diff`, `links`, `history`
— since cli 5.1 the capture verbs too, one case under `env: {
OMGBASE_CAPABILITIES: "core" }` driving the core-only override),
`mutate.json`, `docs.json`, `shell.json`, `sync.json`, `admin.json` (`init`,
`source`, `rebuild-index`, `gc`, `doctor`, `config`, `embed`).

**The four compositions (5.3, modular-core Phase 5a; `spec/store` §9.6).**
The runner's own `OMGBASE_CAPABILITIES` (`core | history | semantic | full`)
reaches every binary it spawns — added to the base environment below, before
the case's own `env`, which still wins — so the SAME cases run against the
composition named. The fixtures are the full composition's record; under a
reduced one a case is **skipped** (and counted) when its inputs or its
recorded outputs carry an OBSERVABLE of the absent module, and every other
case must pass unchanged. The classifier reads the case, never the run, and
is textual and conservative: without the history module a case is skipped
when any step's argv names a verb of `log`, `hist`, `diff`, `history` or a
flag of `--history`, `--at`, or when its stdin, `files`, `sql` or recorded
`stdout`/`stderr` match the history wire — a recorder table name (`commits`,
`revisions`, `dispositions`, `block_changes`, `tree_nodes`, `blobs`,
`edge_transitions`, `archives`), the recorder's disposition summary (` — <n>
inserted|edited|…`), `"history":{"state":"enabled`, `history enabled`, a
non-null `coverage_from`, `"writer_requires":true`, `capture complete`,
`history unavailable`, `writer_refused`, `capability_unavailable`,
`revision`; without the semantic module when argv names `embed` or `find`, or
the text matches the semantic wire — `queued`, a non-zero `embedQueue`,
`embeddings`/`doc_embeddings`, `"semantic":{"state":"enabled`, `embedding`,
`provider_unavailable`, `capability_unavailable`, `semantic(`. The runner
prints one ledger line `[cli spec] composition=<name>: compared=<n> mapped=0
skipped=<n>` that `pnpm conformance` collects (the reference: `core` 381 /
182, `history` 508 / 55, `semantic` 414 / 149 of 563 cases); `CLI_SPEC_UPDATE`
is refused under a reduced composition. The Rust runner mirrors the
classifier word for word for the composition its binary runs with.

**The workspace.** A case runs in a fresh directory `<tmp>` (the harness's
scratch path, canonicalized — macOS's temp dir is a symlink):

- `none` — `<tmp>` holds only `home/` and `tmp/`.
- `empty` — `<tmp>` is a workspace with no repo: `init --yes --no-embedder`
  (equivalently: create `<tmp>/.omgbase/omgbase.db` with the schema).
- `alchemy` — the alchemy corpus (`packages/core/corpus/oqx/fixtures/alchemy`,
  20 documents, the same files `spec/surface` §6 embeds) copied to
  `<tmp>/vault`, then `init --yes --no-embedder` and
  `source add vault --repo fixture -y` under the seams — equivalently, with
  an engine's library: `ensure_repo("fixture", <tmp>/vault)` (`spec/sync` §2:
  repo `rp_0`, source `fixture-fs` = `src_0`), one freshness sweep at the
  spec clock (the walk is depth-first with each directory's entries in
  bytewise order, `spec/sync` §4.2, so `d_0` is `index.md`, `d_19`
  `timeline/review.md`, `b_0`–`b_326` the blocks in document pre-order,
  `c_0`–`c_19` the commits, `cp_0` the checkpoint), then `rebuild_file_stats`.
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
a `*.sh` file is made executable. `sql` (store 17.0, slice 3e-ii; the
case's before the first step, a step's before that step, after its
`files`) is run verbatim, in order, in one transaction on
`<tmp>/.omgbase/omgbase.db` by the harness through its engine's library —
the device that puts into the workspace rows no verb writes (a stale
pending materialization, `admin::doctor-alert`), the CLI twin of
`spec/store` §9.4's `exec`; a statement may not reference anything the
fixture minter has not issued. The token `<workspace>` in argv, env
values, stdin and file contents is replaced by `<tmp>` before use; in
stdout and stderr every occurrence of `<tmp>` is replaced by `<workspace>`
after, and every occurrence of the binary's own version string (what
`--version` prints: the npm package version for `omg`, the crate version for
`omgbase`) by `<version>` — the two binaries are versioned apart, so the
fixtures pin the shape of `--version`, not the number. The first step of a sequence runs on the fresh workspace, every
following step on the workspace the previous one left.

Some verbs' outputs are **recorded by shape** rather than byte for byte,
because their values are the engine's build, not its behavior: `version`
(§6: every leaf is its type name) and, since 4.3, `doctor --size` and
`gc --vacuum`, whose byte counts depend on the SQLite build and its page
allocation — joined in 4.6 by `history export` (not `--dry-run`, which is
the plan over logical bytes and is exact), `history list` and `history
attach`, whose segment-file sizes are a page layout too. For those, on a successful run, both harnesses rewrite stdout
and stderr alike before comparing or recording: in JSON every number under
the keys `bytes`, `wal_bytes`, `page_size`, `page_count`,
`freelist_count`, `reclaimable`, `share` and `indexes` becomes
`"<number>"` (a `null` stays; `rows`, names, the path and the advice are
kept); in text a size-table row's bytes cell (9 columns, right-aligned)
becomes `<bytes>` and its share cell (6 columns) `<share>` with the name
padding and gutters kept, and on every other line each humanized size
(`788.0 KB`, `0 B`) becomes `<bytes>`, each `<n>.<d>%` `<share>`, and the
`pages` line's three counts `<number>`. Row counts are never rewritten:
they are deterministic and pinned.

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
prints each id once; `mv` retargets the inbound links by default and reports
what it did (and what still dangles) on stderr in human mode too; an invalid
`b_` token is `block_missing`; `split --at` with a
non-integer is a usage error; machine modes follow one rule — `--jsonl` on a
non-list result prints the `--json` document, `--ids` on a result without an
id list prints the `--json` document, and the truncation footer is printed in
every mode but `--json` (whose document carries `truncated`/`cursor`);
`--json` is the mapped tool's result shape for `cat` (doc →
`docs_read`), `show` (doc → `{ kind: "document", ...docs_read }`, composed
client-side), `diff` (→ `docs_diff_unified`; `--blocks` → `docs_diff`), `repos`
(→ `repos`), `retarget`'s plan (→ `plan { retarget }`, its `preview.retarget[0].hits`) and `status`
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
  `provider_unavailable`'s config command: `query::semantic-unavailable-json`).
- **Fixed — an empty error payload prints nothing**: a `data` of `{}` (a
  `MutationError` raised without a payload) no longer prints the two lines
  `  {` / `  }` under the message, and is omitted from the JSON error
  (`docs::new-duplicate`, `mv-missing`, `mutate::node-set-unknown-node`).

**`--dry-run` and writes**

- **Fixed — `new`, `mv`, `rm --doc` and `meta` honor `--dry-run`** (they
  used to accept the flag and commit). Through 3.x the document operations
  took `dryRun` in their library context and returned `committed: false`
  with the per-file `diffs` of §3.6 (and the MCP tools `docs_create`,
  `docs_move`, `docs_delete`, `docs_set_meta` accepted `dry_run`); since
  cli 4.0 the dry run is the `plan` of the verb's document effect, rendered
  with the one renderer every verb shares. `docs::new-dry-run-commits`
  keeps its name and shows the document *not* created; `new-dry-run-json`
  prints the Plan (its revision id `$new.0` — no `d` minted), `mv-dry-run`,
  `mv-dry-run-json`, `meta-dry-run`, `rm-doc-dry-run` the plan's diffs.
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
  CLI before any op is built; the `blocks_check` macro (`spec/mutate` §5)
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
  (and after a dry run's diffs); `--json`'s `dangling` is as before. Since
  cli 1.2 the links are rewritten by default (`spec/mutate` 1.3) and the
  confirmation counts them; the dangling note is what `--no-retarget` (or a
  frontmatter relation, with a `meta` fix) leaves behind (`docs::mv`,
  `mv-dry-run`, `mv-no-retarget`).
- **Fixed — a `b_`-prefixed `update` target is always the block path**:
  `update b_nope` is `block_missing: no block with id "b_nope"`; it no longer
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
  `{ kind: "document", ...docs_read }` (composed by the CLI; the `read_ref`
  tool's shape before 3.0; `read::show-doc-json`,
  `shell::previous-result`); `diff` → `docs_diff_unified`'s
  `{ doc, path, from, to, diff }` (`docDiffUnified`; `diff --blocks` → the
  `docs_diff` tool's entries); `repos` → the `repos` tool's
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
  after `mv` (a deletion is the documents whose `deleted_at` is the
  commit's `ts`; a move is read from the commit's `reason`, `move <from> ->
  <to>`).
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
  `block_missing: no block with id "Contents"`; the MCP tools' `heading` text
  resolution (and therefore `ambiguous_heading`) is unreachable from the CLI.
- **Fixed (cli 3.0, with the surface 3.0 name pass) — an unknown OQX root was
  silently empty** (`q 'from nope'` printed `  no hits`, exit 0). The surface
  now refuses a top-level `from <name>` that is no collection — `` `nope` is
  not a target — the repository's collections are `docs`, `blocks`, `nodes`,
  `links` `` (`from edges` adds that `edges` was renamed `links`) — and the
  CLI renders it as every `filter_invalid`, exit 1 (`query::unknown-root`).

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
- **Pinned — every freshness sweep writes the status row**, even an empty one;
  `sync --json`'s `batchId` is the sweep's first committing member's commit id
  and `null` for an empty sweep (through cli 5.x a `checkpointId` `cp_n`
  counted the sweeping commands run since the bootstrap — `cp_5` after four
  reads).
- **Pinned — `gc` sweeps nothing after `rm --doc`** (`admin::gc-after-removals`):
  the tombstoned document's blobs stay referenced by its revisions.

**Port notes.** The Rust binary today renders `mcp` only; its `--help` and
`--version` are its own (`omgbase <version>`, a usage block) and differ from
the reference's, so the allowlist starts empty. `embedder_failed`'s
`reason` is the OS's spawn error text (Node: `spawn … ENOENT`) — a port's
will differ; no fixture pins it. Both engines must implement the `mintId`
redraw of `spec/store` 13.5 for the ids in `mutate.json` to agree (the
bootstrap leaves `b_0`–`b_326` in use; a fresh process's first block mint is
`b_327`; before surface 1.5 grew the corpus by two `timeline/` documents it
was `b_314`).

- **Fixed — a write on a sourceless repo printed the library's untyped
  message** (`error[repo_not_found]: Error: mutation requires a rootPath or
  an explicit docStore`, the catch-all code with `String(err)`), while the
  MCP server pre-checks and says `repo has no filesystem source; mutation
  disabled` (`spec/surface` §4). The library now throws that typed error, so
  both clients render the same bytes (`sync::sourceless`).

- **Open — remote mode drops `--actor`.** No writing tool takes an actor, so
  a `--server` write commits as `api(agent:mcp)` where the local run records
  `api(human:<user>)`; giving the writing tools an optional `actor` would be a
  `spec/surface` minor. Also unpinned, observed while proving `--server` both
  ways: the reference client spawns its stdio engine with the MCP SDK's
  safelisted environment, so `OMGBASE_SPEC_*` never reach an `omg --server`
  child (the Rust client inherits the whole environment); before 3.0
  `cat --json <block>` remotely carried `read_ref`'s `kind` (`cat` now calls
  `blocks_read` directly in both modes); `outline <d_id>` remotely heads with
  the id; block sugar `--json` remotely prints the tool's decorated result;
  `retarget --apply` remotely prints `ok retargeted N block(s)`; the Rust
  client keeps `--dry-run` on `retarget --apply` a preview and still says
  `nothing to do` for an empty `apply`, where the reference posts the call.

## 10. Decisions

- 2026-10-26, cli 5.4 (store 17.4 Phase 5a-ii, sync 4.4): **`doctor`'s
  `bytes reproducible`; `sync`'s `repaired`.** `doctor` gains its sixth
  check (§6) — the store's fidelity check re-derived in full for the
  selected repository, the `legacy_bytes` alert written to match — and
  `sync` renders the sweep's new `repaired` member (`spec/sync` §4.3 step
  5): a `  ✓ repaired  <n>` line with the paths in human mode, the member in
  every machine mode. Fixtures: every `doctor` rendering moved by the one
  line (`admin::doctor`, `doctor-json`, `doctor-after-observed-delete`,
  `doctor-after-api-delete`, `doctor-alert`, `invoke::help-card-doctor`,
  `history::history-disable-then-write`, `history-purge-disabled`,
  `history-purge-before-enabled`), the `sync --json` shapes by the member
  (`sync::up-to-date-json`, `up-to-date-ids-is-json`, `out-of-band-edit`,
  `out-of-band-new-file`). A check and a member added: a minor.
- 2026-10-26, cli 5.3 (store 17.3 Phase 5a, surface 6.3, sync 4.3): **the four
  compositions in the runner** (§8) — the textual classifier that skips a
  case carrying an observable of the absent module, the ledger line, the
  composition passed through the base environment. No verb changed; one
  fixture moved by the store's D2 step two alone (`admin::doctor-size-after-
  rm`: the size table counts 315 `blocks` rows after the `rm`, not 327 — a
  tombstoned document keeps no block row, `spec/store` §5.6).
- 2026-10-26, cli 5.2 (store 17.2 Phase 4b, surface 6.2, sync 4.2): `history`
  gains `purge [--before <ts>]`, `embed` gains `enable [--provider <p>]` /
  `disable` (§6), `doctor --size` gains the feed-cap advice line read from
  the `feed_capped` alert, `diff` answers a revision the recorder does not
  hold by `spec/surface` §3's decision table (`pruned`/`outside_coverage`/
  `disabled`; an unknown token on an enabled repository stays
  `target_missing` with `{ doc, rev }`). Decided here: `embed enable`
  without a provider is a usage error (exit 2) rather than an envelope — the
  verb was given nothing to enable; `embed status|drain` on a switched-off
  repository refuse while `find` degrades to FTS-only (the explicit verbs
  name the capability, the opportunistic one has no leg); `--provider` writes
  the workspace layer, as `init --embedder` does. Fixtures moved:
  `history::history-unknown-sub` (the subcommand list), the help cards
  `invoke::help-bare`, `help-flag`, `help-command`, `help-card-history`,
  `help-card-history-bare`, `help-card-history-word`, `help-card-embed`,
  `admin::embed-help-word`, `embed-help-word-needs-workspace` (the `history`
  and `embed` summaries and cards). New: `history::history-purge-disabled`,
  `history-purge-before-enabled`, `admin::embed-enable-no-provider`,
  `embed-enable-disable`, `doctor-size-feed-capped`.
- 2026-10-26, cli 5.1 (store 17.1 Phase 4a, surface 6.1, sync 4.1): `history`
  gains `enable [--best-effort]` / `disable` (§6), `source add` gains
  `--no-history`, `doctor`'s `capture complete` reads the manifest, `version
  --json`'s `capabilities` carries the selected repository's row with the
  6.1 keys, `sync --json`/`status --json` carry the batch result's `failed`
  list (sync 4.1) and `sync_status`'s capability keys. Fixtures moved,
  all by those shapes: `read::version-json`, `read::status-json`, `read::
  status-ids-is-json`, `sync::up-to-date-json`, `sync::up-to-date-ids-is-
  json`, `sync::out-of-band-edit`, `sync::out-of-band-new-file`, `sync::out-
  of-band-delete`, `sync::sourceless`, `admin::source-add`, `admin::doctor-
  after-observed-delete`, `docs::rm-doc`, `invoke::ambiguous-repo`, `shell::
  global-flags-per-line` (`status --json`'s `sync.capabilities` / `failed`),
  `history::history-unknown-sub` (the subcommand list), the help cards
  `invoke::help-bare`, `help-flag`, `help-command`, `help-card-source`,
  `help-card-source-bare`, `help-card-history`, `help-card-history-bare`,
  `help-card-history-word` (the `history` summary line, the `source add`
  usage, the card). New: `history::history-enable-already`,
  `history-disable-then-write`, `history-enable-after-disable`,
  `history-enable-best-effort`, `history-core-build-writer-refused`,
  `admin::source-add-no-history`.
- 2026-10-25, cli — store 17.0 slice 3d (`spec/surface` 6.0, `spec/sync` 4.0;
  no cli version move — the verbs' argv is unchanged, their renderings
  follow the specs they render): `log` gains `--epoch` and renders the
  feed's summaries, `--json` the new result keys; `gc --json` gains
  `feedPruned`; `doctor` loses the identically-true `convergence` check;
  `doctor --size` files the feed under `sync`; `status` reports the feed's
  position and the last batch; `sync --json`'s `checkpointId` is `batchId`.
  Fixtures regenerated accordingly (`admin`, `history`, `read`, `sync`,
  `shell`, `docs`, `invoke`).
- 2026-10-20, cli 5.0 (`spec/surface` 5.0 "underscore = engine"; with
  `spec/mutate` 4.0, `spec/sync` 3.0, `spec/search` 3.0, `spec/graph` 2.0):
  the surface's row rule became one rule for every record kind — a BARE name
  is a user-authored entry, an UNDERSCORE-prefixed name is engine-provided,
  `$` stays OQX's — and the CLI renders it. Every verb's `--json`/`--jsonl`
  carries the tool result verbatim, so the shapes moved with the surface's:
  the hit envelope `{ _id, _path, …projection }` (`query`, `run`), `docs_read`
  `{ _id, _path, rev, properties, _raw }` (`cat`, `show`), `blocks_read`
  `{ _id, _type, _raw, _hash, … }`, `docs_list` `[{ _id, _path, _updated_at,
  blocks }]` (`ls`), `blocks_resolve` `[{ _id, locator, preview, evidence }]`
  (`find`), the Receipt's and a digest's `revisions[{ _id, _path, _hash }]`
  (every write, `log`), the document ops' `{ _id, _path, committed }` (`new`,
  `mv`, `rm --doc`, `meta`) and `mv`'s `dangling[{ _doc_id, _path, _block_id,
  target, _anchor, _field? }]`, `docs_diff_unified` `{ _id, _path, from, to,
  diff }` and `docs_diff` `[{ kind, _id, before?, after? }]` (`diff`), the
  retarget plan's `hits[{ _id, _path, oldRaw, newRaw }]`, `repos_status`'s
  `_id` (`status`), and every error `data` (`stale_expectation.current {
  _hash, markdown }`, `doc_missing { _id?, _path? }`, …). The human hit
  table's envelope columns read `_id` and `_path` (the bare list prints the
  values, unchanged in text); `show`'s card prints the computed title as
  `_title` beside the bare authored keys; the shell's row ref reads `_id`
  (label `_path`), `.field` reads any projected key as the result spells it
  (`@1._id`, `@t[1]._path`), and the `$id`/`id`/`$path`/`path` tolerance of
  `REF_KEYS` is gone — a bare `id` on a row is an authored key. argv is
  unchanged: no flag moved, and the only argv that carries the new spelling
  is an OQX source (`omg q 'from docs select _title, _path'`). Role keys kept
  their names everywhere — `rev`, `cursor`, `truncated`, `committed`,
  `plan_id`, `new_ids`, `commit`, `locator`, `from`/`to`, `kind`,
  `parent_id`, `blocks` (a count), `rootPath`, `source add`'s `repoId`
  (this verb's own shape), and `links`' `kind`/`count`/`samples` (its
  `predicate`/`doc_id`/`block_id` carry link-row attributes and moved to
  `_predicate`/`_doc_id`/`_block_id`, the far node under `_doc_id`). A JSON
  key renamed and a
  header line changed in meaning: a major. **Migration:** scripts parsing
  `--json`/`--jsonl` read `_id`/`_path` (and the other `_` keys above); the
  bare `<id>  <path>` list and `--ids` are unchanged; OQX sources respell
  engine names with the underscore (`id` → `_id`, `title` → `_title`,
  `data.<k>` → `<k>`, `doc.<x>` → `_doc.<x>`; `scripts/rename-engine-names.
  mjs` rewrites a 4.x query). Fixtures: every expectation moved by the key
  spelling alone (table headers, `--json`/`--jsonl` bodies, error payloads,
  shell frames, OQX sources in argv); nothing else. The Rust `omgbase`
  binary follows in a separate round with the rest of the Rust twin; until
  it lands `cli_spec.rs`'s allowlist is red by design.
- 2026-10-15, cli 4.6: `history plan | export | attach | detach | list`
  (§6) — the operator surface of `spec/store` 15.0's retention (§7.1 there),
  and `doctor --size`'s `archived` line and retention advice. A CLI verb
  family and no MCP tool, on purpose: archiving is an operator's act over
  the workspace's files (it writes a segment under `.omgbase/`, takes the
  writer lock, and its inputs are a policy and a directory), the agent-facing
  consequence is already in the catalog — `revisions.archived` and the
  `revision_archived` error (`spec/surface` 4.9) — and a remote client that
  wants history archived asks its operator. One subcommand word, so the
  catalog gains one entry (`history & links`) rather than five; `history`
  prints its card bare, like `source` and `node`. The plan prints in logical
  bytes (blobs and tree-node entries) and is pinned exactly; the export,
  list and attach outputs carry a segment file's size, which is SQLite's
  page layout, so §8's shape rule covers them as it does `doctor --size`.
  Fixtures: `history.json` 42 → 70, `invoke.json` 90 → 93 (the card three
  ways), `help-bare`/`help-flag`/`help-command` and `help-card-doctor`
  re-rendered, the `doctor --size` cases gain the `archived` key and line.
- 2026-10-13, cli 4.5: `gc` prints its third count and `doctor --size`
  carries `same_dispositions` (§6), rendering `spec/store` 14.2 — `same`
  dispositions are no longer persisted, the default gc sweep removes a 14.1
  store's, and the size report says when that sweep is worth running. The
  stderr line gains `, <s> same dispositions` and the JSON a key
  (`sameDispositionsSwept`; `same_dispositions` on the report): additive
  renderings, a minor as 4.3 and 4.4 were. `--dry-run` now really deletes
  nothing — through 4.4 it ran the (always empty) mark-and-sweep for real,
  which was harmless only because nothing was ever unreachable. Fixtures:
  the `gc` cases gain the count, the `doctor --size` cases the key, the
  `hist` and `log` cases over api writes lose the untouched blocks' entries
  and the inflated `<n> edited` summaries, `version` reports the new spec
  lines; the help cards re-render.
- 2026-10-13, cli 4.4: `query` prints the result's `hints` (`spec/surface`
  4.6 §1.5 — names the query reads that no row of their kind carries) as dim
  stderr lines `  hint: <text>`, one per entry, after everything else, in
  every human rendering; `--json` already carried the member. Dropping them
  in the human mode would have been the silence the surface rule exists to
  end. A stderr line added to one verb's rendering: a minor, as 4.3 was.
  Fixtures: `query.json` 51 → 55 (`unknown-name-hint`, `unknown-name-hint-json`,
  `unknown-name-no-hits`, `unknown-field-on-links`); nothing else moved.

- 2026-10-13, cli 4.3: the commit confirmation and the document-op
  confirmation print the Receipt's `summary` (`spec/mutate` 3.3 §11.9) —
  one line per effect in words, indented four spaces on stderr under the
  `ok` line — for `apply`, `execute`, every block mutator, `retarget
  --apply`, `update` and the four document verbs, local and `--server`
  alike; `--json` carries `summary` inside the Receipt it already prints.
  Rendering only, a key added to a JSON result: a minor. Fixtures: every
  `pin_stderr` write case gains its summary lines, every `--json` write case
  the Receipt's `summary`; nothing else moves.

- 2026-10-13, cli 4.3: `doctor --size` and `gc --vacuum` (§6) render
  `spec/store` 14.1's size report and `VACUUM`. `doctor --size` is a
  separate mode of `doctor` — the checks still run without it — because the
  question it answers ("what is this database made of, and what would
  reclaim space") is the one a 100 MB file over 2 MB of Markdown raises, and
  the answer is history, not embeddings; it needs no repo and exits 0. The
  categories print in a fixed order (content, history, search, sync) rather
  than by size: a report that reads the same across databases is easier to
  compare, and on the alchemy corpus `search` and `sync` tie to the page,
  which would have made the order a coin toss between SQLite builds; the
  tables under a category do order by bytes. `--vacuum` keeps the sweep's
  refusal rule (`gc.enabled`), since a VACUUM rewrites the whole file and the
  flag is the operator's consent to maintenance writes; `--dry-run --vacuum`
  measures. The bytes are recorded by shape (§8) — a new normalizer in both
  harnesses beside `version`'s — while names, order, row counts and advice
  are pinned exactly. Two flags added: a minor. Fixtures: `admin.json`
  60 → 68 (`doctor-size`, `doctor-size-json`, `doctor-size-jsonl`,
  `doctor-size-after-rm`, `gc-vacuum`, `gc-vacuum-dry-run`,
  `gc-vacuum-dry-run-json`, `gc-vacuum-disabled`), `invoke::help-card-doctor`
  and `help-card-gc` re-rendered; the catalog is unchanged (the summaries
  stand).
- 2026-10-13, cli 4.2: `mcp --tools <full|minimal>` (§6 `mcp`) serves a
  catalog profile of `spec/surface` 4.3; the `--server` client lists the
  tools once and falls back from a sugar tool to `apply { effects }` where
  the server does not list it (§2.3 "Profiles"), refusing a `#` locator
  there. `version` prints a last `profile` line (the tool's new key; `full`
  locally, the remote's over `--server`). A flag added, a line added: a
  minor. Fixtures: `invoke::help-card-mcp`, `invoke::mcp-bad-tools` (new),
  `read::version`, `read::version-json`, `invoke::version-verb-no-workspace`
  (the `profile` line/key by shape).
- 2026-10-13, cli 4.1: `query --bare` (§4, §6) renders `spec/surface` 4.2's
  `query { bare: true }` — the hit table without the envelope columns, the
  bare hits under `--json`/`--jsonl`, the surface's refusals as every
  `filter_invalid`; nothing else moves. A flag added: a minor. Fixtures:
  `query.json` 48 → 51 (`bare`, `bare-json`, `bare-needs-select`),
  `invoke::help-card-query` (the usage lines and the `--bare` option).
- 2026-10-12, cli 4.0: the retirement release of ADR-021 (with `spec/mutate`
  3.0 and `spec/surface` 4.0; no deprecation period). `apply -f` takes
  `{ effects }` only (`{ ops }` is the usage error naming the replacement);
  `update <doc>` is the `set content` effect — `--dry-run` renders the Plan's
  `preview.identity` (the bytes of the 3.x opset plan, `docs::update-doc-
  dry-run` unchanged), a commit the Receipt confirmation + the touched ids
  once (`docs::update-doc`: the inserted paragraph is `b_330`, not `b_335`
  — the planner's verify no longer burns ids), `--json` the Plan or the
  Receipt (`docs::update-doc-json`), the `--plan` alias is gone
  (`invoke::help-card-update`); `retarget` plans through `plan { retarget }`
  and `--apply` renders the Receipt + hits; §3.6 is one rule — every dry run
  is a `plan`, burns no id and prints `$new.n` (`new --dry-run --json`'s
  `$new.0`, `insert --dry-run-json`'s `$new.0`; the 3.x "dry runs consume
  ids" is closed). A flag removed and outputs changed in meaning: a major.
  Regeneration: the cases named above now; the `apply-*` kernel cases, the
  17 `--dry-run` cases, `retarget-apply-*`, `sync::sourceless` and the
  `apply`/`retarget` help cards with the surface's removals.
- 2026-10-12, cli 3.2: the Effect layer's verbs (ADR-021, `spec/mutate` §11,
  `spec/surface` 3.1–3.3). `apply -f` accepts `{ effects }` beside `{ ops }`
  (exactly one): committed it renders the Receipt (confirmation + the ids of
  the plan's preview results, §4; `--json` the Receipt), `--dry-run` the Plan
  (the diffs of its preview; `--json` the Plan) and — the documented
  difference from §3.6 — burns no id. A new verb `execute (-f plan.json | -)`
  commits exactly a Plan (admission errors `unsupported_plan_version`,
  `plan_mismatch`, `filter_invalid`; `stale_plan` when a document moved on),
  in `REMOTE_OK` (the `execute` tool's plan form), the `mutate` help group
  and `docs/surface-map.md`. A verb and an input added: a minor. Ten cases
  (`mutate::apply-effects`, `apply-effects-dry-run`, `apply-effects-json`,
  `apply-both-inputs`, `apply-conflicting-effects`, `execute-file`,
  `execute-stdin`, `execute-stale-plan`, `execute-plan-mismatch`,
  `execute-unsupported-plan-version`) plus `invoke::help-card-execute`; the
  catalog (`invoke::help-bare`) and the `apply` card (`invoke::help-card-apply`)
  re-rendered for the new verb and input, nothing else moved. The Rust binary
  renders both verbs over the `apply`/`execute` tools (batch 2 of the
  migration).
- 2026-10-12, cli 3.1: `sync --json` (and the sourceless fallback) gains
  `materialized: [path…]`, the freshness sweep's step 0 result (`spec/sync`
  2.2, `spec/store` 14.0 §5.7). An additive result key: a minor; the five
  JSON `sync`/`doctor` cases gain `"materialized":[]`, nothing else moves,
  and the human rendering is unchanged (there is nothing a fixture could
  show, and a count of files the engine owed itself is noise beside
  `ingested`).
- 2026-10-11, cli 3.0 (batch 3 — the attributes drop the `$`): following
  `spec/surface` 3.0's final name rule (§1.2: `$` belongs to OQX, every engine
  attribute is bare and wins on collision, an authored key of the same name is
  `data.<k>`), every rendering that spelled `$id`/`$path`/`$raw`/`$hash`/
  `$updated_at`/`$title`/`$tags` in the two entries below spells the bare name:
  the hit table's header reads `id`, `path`; `--json`/`--jsonl` carry the
  surface's bare envelope and shapes (`{ id, path, rev, properties, raw }`,
  `[{ id, path, updated_at, blocks }]`, `{ id, path, hash }`, …) with
  `properties.computed` keyed `title`/`tags`; the shell's row ref is the hit's
  `id` (label `path`) and `.field` reads any projected key; the `query` help
  card and `query_syntax` text are respelled (`path`, `^id`, `data.<k>`, the
  envelope-collision alias). The human renderings are unchanged except for the
  header. Regeneration: every `--json`/`--jsonl` body and query-table header
  re-keyed, the help cards re-rendered, nothing else — a 3.0 line that has not
  shipped, so no further major.
- 2026-10-11, cli 3.0 (the rest of it): every verb's `--json`/`--jsonl`
  document follows `spec/surface` 3.0's row rule — a row's identity is
  `$id`/`$path`, its bytes `$raw`, its hash `$hash`, its time `$updated_at`,
  foreign keys are plain snake_case (`doc_id`, `block_id`, `parent_id`) —
  because the verbs render the tool results verbatim and those changed
  (`cat`/`show` `{ $id, $path, rev, properties, $raw }`, a block `{ $id,
  type, $raw, $hash, …, ordinal, depth, parent_id }`, `ls` `[{ $id, $path,
  $updated_at, blocks }]`, `diff` `{ $id, $path, from, to, diff }` /
  `[{ kind, $id, … }]`, `find` `[{ $id, locator, … }]`, `links` `doc_id` /
  `block_id`, the document ops `{ $id, $path, committed, … }`, `log`'s
  revisions `{ $id, $path, $hash }`, every apply result's revisions). Two
  renderings change with them: `ls --ids` prints the `$id`s (the paths were a
  stand-in for an identity the row did not carry) and `find -1`/`--ids` read
  `$id`; the shell's row ref for `ls` is the `$id` (label `$path`) and for
  `links` the far node's `doc_id`, and `.field` on a ref admits the new
  names. The human renderings are unchanged. Result keys renamed: part of the
  3.0 major (the hit envelope half shipped first, below). Regeneration:
  every `--json`/`--jsonl` expectation re-keyed, `ls --ids` and the shell
  cases that address an `ls` row re-rendered, nothing else.

- 2026-10-10, cli 3.0: **the query hit renders as `$id`/`$path`** (§4, §6
  `query`, §7), following `spec/surface` 3.0 — the same decision, rendered:
  the hit table's header reads `$id`, `$path`; the bare list `<$id>  <$path>`
  is unchanged in text (it prints the values); `--json`/`--jsonl` carry the
  surface's envelope verbatim, `--ids` the `$id`s; the shell's row ref for a
  `query`/`run` collection is the hit's `$id` and its label the `$path`
  (`@1` still substitutes the id), and substitution of an object accepts
  `$id`/`$path` ahead of `id`/`path`. A `select $path, …` no longer drops the
  `path` column (there is no `path` column: `$path` *is* the envelope) and
  shows no `$path` column either — the projection collapsed onto the
  envelope. Every regenerated expectation changed by the key spelling alone
  (table headers, `--json`/`--jsonl` bodies, shell frames). A rendered key
  changed in meaning: a major. **Migration:** scripts parsing `--json`/
  `--jsonl` read `$id`/`$path`; `--ids` and the bare list are unchanged.
- 2026-10-10, cli 2.0 also: the query text follows `spec/surface` 2.0 §1.1 —
  the repository is the root row (`^docs` from a row, `0^docs` from any depth,
  `^$id` the repository id; a top-level consumer is `docs count { … }`), and
  `$repo` or a bare target name inside a block is `filter_invalid` rendered
  like any other OQX error (§3.5; `query::root-caret`, `query::repo-removed`,
  `query::repo-removed-json`, `query::bare-target-in-block`). The `query` help
  card's examples are respelled (`invoke::help-card-query`); `^docs count { }`
  at the top level is refused too (`query::root-caret-past-the-root`). The CLI renders; the
  rule is the surface's.
- 2026-10-10, cli 2.0: paths print in the reference form (§3.1a), following
  `spec/surface` 2.0 — the same decision, rendered: every `<path>` cell, header,
  confirmation, diff header, `log` subject and `--json` path is `/`-rooted; every
  path argument accepts both forms; a 1.x `--cursor` is refused. The `cat`/`show`
  cards and the `query` card's examples say so. Every path-bearing expectation
  changed spelling (and the tables re-aligned by one column); nothing else did.
  An output changed in meaning: a major (`query::path-literal-rooted`,
  `path-literal-bare`, `cursor-from-1x`, `read::cat-doc-rooted-path`,
  `ls-glob-rooted`, `outline-rooted-path`, `docs::new-rooted-path`).
- 2026-09-28, cli 1.2: `mv --no-retarget`. `docs_move` retargets the
  inbound links by default (`spec/mutate` 1.3), so `mv` does too and says
  how many; the flag is the opt-out and the old dangling note is what it
  (or a frontmatter relation) leaves. A flag added: a minor
  (`docs::mv`, `mv-json`, `mv-dry-run`, `mv-dry-run-json`, `mv-no-retarget`,
  `mv-no-retarget-json`, `invoke::help-card-mv`).
- 2026-10-11, cli 3.0 (surface 3.0 tool-name pass): the verbs follow the
  catalog's renames — `cat`/`show` pick `docs_read` or `blocks_read` by the
  ref's shape (the polymorphic `read_ref` is gone; `show --json` on a document
  still prints `{ kind: "document", ...docs_read }`, composed client-side),
  `diff` → `docs_diff_unified` / `docs_diff` (`--blocks`), `find` →
  `blocks_resolve`, `done` → `blocks_check { ids }`, `node set` → `nodes_set`,
  `update <doc> --dry-run` → `docs_update { dry_run: true }` (`docs_plan_update`
  is gone); the `show` card says `out links`, the `query` help names the
  targets `docs|blocks|nodes|links` and the root collections `^links`
  (`from edges` is an unknown target). Renderings unchanged otherwise.
- 2026-10-11, cli 3.0 (surface 3.0 batch 2): the verbs send the surface's
  3.0 argument names — a `d_` ref is `id`, anything else `path` (`doc_id` /
  `doc_path` from `diff`), `blocks_read`/`blocks_read_many`/`blocks_history`
  behind `cat`/`show`/`hist`, `append <block>` renders `blocks_append` (a
  heading's section or a container's children; a leaf is
  `block_not_container`), `omg query`'s no-provider error is
  `provider_unavailable`; and the LOCAL verbs spell a missing document the
  way the tools do (`error[doc_missing]: no document with id or path "…"`,
  `no node with id "…"`), so a verb reads alike in both modes
  (`docs::*-missing`, `mutate::node-set-unknown-node`, `mutate::append-none`,
  `invoke::help-card-append`, `query::semantic-unavailable*`).
- 2026-09-27, cli 1.1: a `version` verb rendering the surface's `version`
  tool (Brendan: one place that says which engine and which component
  versions an MCP host or a shell is talking to). A verb added: a minor.
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
