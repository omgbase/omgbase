# agent-bench — omgbase vs bare files, full catalog vs minimal profile, measured

A private benchmark harness (unpublished, `private: true`) that answers two
questions about an agent working a Markdown knowledge base:

1. **omgbase or bare files?** Does an agent do the same tasks better through
   omgbase's MCP tools than through generic filesystem tools over the same
   vault — the way an agent manages a plain Obsidian-style vault today?
2. **Full catalog or minimal profile?** Within omgbase, is the full 47-tool MCP
   catalog or the minimal ~10-tool profile (`omg mcp --tools minimal`:
   `docs_read`, `docs_tree`, `query_syntax`, `query`, `blocks_resolve`,
   `apply`, `plan`, `execute`, `changes_since`, `version`) the better surface?

Two kinds of task ask them. The thirteen **editing** tasks hand the agent a
document and ask for a change — the first three-way run showed bare files at
parity on correctness and ~3× cheaper there, because an exact-match editor does
a named edit in two calls. The nine **retrieval** tasks ask what omgbase is
for: finding, verifying and relating things *across* a corpus — range inclusion
in frontmatter, graph traversal along a project timeline, cross-document
aggregation, backlinks with their section, every open task in the vault,
semantic search — and end with an **answer** the harness checks, not a write.
Each is answerable by the file tools too (list / grep / read), just more
expensively; that is the comparison.

Three **profiles**, one per surface: `full` and `minimal` are omgbase;
`fs` is the filesystem baseline. For every (task, profile, run) cell the harness:

1. builds a **fresh workspace** from the task's corpus — the shared **alchemy**
   fixture (`packages/core/corpus/oqx/fixtures/alchemy`, 20 notes) or this
   package's generated **timeline** corpus (`corpora/timeline`, 348 notes,
   below) — exactly as the CLI spec runner does: `omg init --yes
   --no-embedder`, `omg source add vault --repo fixture -y` under
   `OMGBASE_SPEC_CLOCK` (and, for alchemy, `OMGBASE_SPEC_MINTER=sequential`, so
   its ids are deterministic — `d_0` is `/index.md`, `b_153` the "Tasks"
   heading of calcination — and a task can name them);
2. opens the profile's **tool server**: for `full`/`minimal` it spawns the built
   CLI as an MCP stdio server — `omg mcp -C <workspace> --no-watch [--tools
   <profile>]` — connects with `@modelcontextprotocol/sdk` and hands
   `tools/list` to the model **verbatim** (name, description, input schema);
   for `fs` it serves seven generic file tools in-process over the workspace's
   `vault/` directory, the very files the omg profiles ingest (below);
3. drives Claude through `@anthropic-ai/sdk` with the task prompt and the
   profile's fixed system prompt (the omgbase one for `full`/`minimal`, its
   file-tool analog for `fs` — they differ only in naming the medium),
   forwarding every tool call to the server and its result back, until the
   model stops calling tools or the turn cap (20) is hit;
4. runs the task's machine-checkable **end-state checks through omgbase** —
   the same oracle for every profile — and records the metrics and the full
   transcript. Under an omgbase profile the checks go through the run's own
   server; under `fs` the harness first sweeps the workspace (`omg sync`) so
   the store observes what the agent wrote to disk, then spawns a `full`
   server for the checks. A retrieval task's `answer` check reads the model's
   final text; its `unchanged_all` compares the whole vault to the corpus.

Only the local `omg mcp` is ever used; nothing here knows about any remote
gateway.

## Running

```
pnpm build                                      # at the repo root: the harness spawns packages/cli/dist/src/main.js
export ANTHROPIC_API_KEY=sk-ant-…              # or an `ant auth login` profile — the SDK resolves either; or Bedrock, below
pnpm --filter agent-bench bench --profiles full,minimal,fs   # the three-way comparison: 22 tasks × 3 profiles × 3 runs → results/<timestamp>/
pnpm --filter agent-bench bench                 # the omgbase pair only: 22 tasks × {full, minimal} × 3 runs
pnpm --filter agent-bench bench --dry           # no model: prove the tasks and checks (below)
pnpm --filter agent-bench bench --profiles full,minimal,fs --embedder omgbase-embedder   # …and run the semantic task under omgbase too
```

```
pnpm bench [--profiles full,minimal,fs] [--runs 3] [--tasks id,id] [--model claude-opus-5]
           [--effort low|medium|high|xhigh|max] [--max-turns 20] [--out results] [--embedder <cmd|url>] [--dry]
```

Defaults: the two omgbase profiles (`full,minimal` — add `fs` for the
recommended three-way run), 3 runs per cell, `claude-opus-5` (the current
recommendation for agentic tool use) with adaptive thinking at effort `high`,
turn cap 20. `OMG=<path to main.js>` points the harness at another omg build.
An omgbase profile is a plain config value: `--profiles full` runs today's
catalog, `minimal` adds `--tools minimal` to the server's argv and nothing else
changes, so the harness runs unchanged once that flag exists in a build (it
does in the current one; `test/workspace.test.ts` skips the profile test on a
build without it). `fs` is the one profile that is not a catalog: it never
spawns `omg mcp` for the agent (`src/fs-server.ts`).

### Running on Amazon Bedrock

The same model through Bedrock, with the AWS credentials you already have
(`AWS_PROFILE` / SSO, `AWS_REGION`) — no Anthropic key needed:

```
pnpm --filter agent-bench bench --provider bedrock              # model → global.anthropic.claude-opus-5
pnpm --filter agent-bench bench --provider bedrock --model eu.anthropic.claude-opus-5
```

The provider defaults to `bedrock` when the shell is already set up for it
(`CLAUDE_CODE_USE_BEDROCK` is set and no `ANTHROPIC_API_KEY` is), else to
`anthropic`; `AGENT_BENCH_PROVIDER=bedrock|anthropic` overrides the guess and
`--provider` overrides both. On Bedrock a bare Anthropic id (`claude-opus-5`,
`claude-sonnet-5`) is sent as the cross-region inference profile
`global.anthropic.<id>`; an id that already carries a region prefix
(`eu.anthropic.…`, `us.anthropic.…`, `global.anthropic.…`) is passed through
(a Claude Code `[1m]` suffix is dropped). Everything else — adaptive thinking,
effort, prompt caching, the metrics — is identical; the report names the
provider next to the model. The Bedrock client (`@anthropic-ai/bedrock-sdk`)
is loaded only when used, so an Anthropic-API run never touches the AWS stack.
Check what your account serves with
`aws bedrock list-inference-profiles --query "inferenceProfileSummaries[].inferenceProfileId"`.

The run writes `results/<timestamp>/`:

- `report.md` — the tables (below), rewritten after every cell so an
  interrupted run still has a report;
- `results.json` — `{ meta, results: RunMetrics[] }`, the raw numbers;
- `transcripts/<task>.<profile>.<run>.jsonl` — every event of the run.

No fallback model is configured: a `refusal` stop ends the turn like any other
and is visible in the transcript. A benchmark comparing tool surfaces must be
answered by one model, so the server-side fallback the SDK offers is
deliberately not enabled.

The very first model request of a bench is its **credential probe**: when it
fails on credentials — the Anthropic API's 401 `authentication_error` / 403, the
Bedrock SDK's `Failed to resolve AWS credentials from the credential provider
chain` (an expired SSO token reads `Token is expired … run 'aws sso login'`
underneath) — the whole bench aborts with that one message and a hint for the
provider, exit 1, and the empty `results/<timestamp>/` is removed; no FAIL rows
are written. A failure on any later request is that run's own and is recorded
as today (`error` in `results.json`, a FAIL row), so a token that expires
mid-bench shows up per run, not as an abort.

### Semantic search: `--embedder`

`semantic-find` needs `semantic(…)`, which needs an embedding provider; a store
without one answers `provider_unavailable`. The task therefore declares
`"requires": ["semantic"]`, and under an omgbase profile the bench runs it only
with `--embedder <cmd|url>`: the cell's workspace is built with `omg init
--embedder <cmd>` instead of `--no-embedder`, then — after `source add` — `omg
embed drain` embeds every block and document and the harness waits until `omg
embed status` reports an empty queue, so the agent's first `semantic()` has
every vector (`src/workspace.ts`, `embedWorkspace`). Only that task's
workspaces get the provider; the others are unaffected. Without the flag the
cell is **skipped**, not failed: one row per run with `skipped: "needs
--embedder"`, a one-line transcript (`{ "type": "skip", … }`), `skipped (needs
--embedder)` in the report's pass column, and it enters no mean or total. The
`fs` profile runs the task regardless — grep IS its semantic search, and that
is the comparison.

The provider is whatever `omg init --embedder` accepts (`packages/embedder/README.md`):
the published `omgbase-embedder` when it is on `PATH`, the monorepo's build
`node ../../packages/embedder/dist/src/bin.js` (relative to this package; pass
an absolute path to be safe), or an `http(s)://` endpoint. The local provider
is transformers.js + `Xenova/gte-base` (768 d); its first run downloads ~435 MB
into `node_modules/@huggingface/transformers/.cache`, after which it is
offline. `--dry --embedder <cmd>` proves the semantic task's scripted solution
end to end (the workspace is embedded, the ranking query runs through the real
server) in ~12 s on a cached model.

### `--dry`: proving the checks without the model

`pnpm bench --dry` loads and validates every task, then for each task and
profile:

- replays the task's **scripted solution for that profile** (`solution.steps`
  under `full`/`minimal`, `solution_fs.steps` under `fs` — a fixed tool-call
  sequence) through the real agent loop against a fresh workspace of the
  task's corpus — so the stale-plan hook fires exactly as it would for the
  model — and requires every step to succeed (or to fail with the error it
  says it expects) and every check to pass (a retrieval task's solution ends
  with the final text its `answer` check expects);
- runs the checks against an **untouched** workspace and requires them to
  **fail** (a task may opt out with `trivial_on_fresh: true`; none does today —
  the no-op's `final_text` check discriminates, a retrieval task's `answer`
  check fails on an empty answer);
- prints `skip <task> [<profile>] solution (needs --embedder)` for a task whose
  requirement the profile lacks (the negative control still runs).

Green means every check describes a reachable end state and rejects the
starting one — and, per profile, that every task is solvable with that
profile's tools. `--profiles full,minimal,fs` over the 22 tasks is 132 cells in
~3 minutes (a timeline workspace takes ~1.6 s to build, an alchemy one ~1 s).

## The `fs` profile: the filesystem baseline

`fs` asks what the same agent does on the same vault **without omgbase**: a
directory of `.md` files and the generic file tools an agent has today. The
tool server (`src/fs-server.ts`, in-process, `FsServer`) works on the
workspace's `vault/` directory — the exact copy of the corpus the omg
profiles ingest — and exposes seven deliberately generic, Claude-Code-like
tools whose descriptions carry no omgbase concept and are written as a good
generic file-tool server would write them (not tuned to the tasks):

| tool | arguments | does |
| --- | --- | --- |
| `list_files` | `dir?` | the `.md` files under `dir` (default the root), recursively, sorted, as vault-relative paths |
| `read_file` | `path` | the file's text |
| `write_file` | `path, content` | create or overwrite the whole file (`mkdir -p`) |
| `edit_file` | `path, old_string, new_string` | exact-match replace of **one** occurrence — the Claude Code rule: `no_match` when it occurs nowhere, `ambiguous_match` when more than once, the file untouched either way |
| `grep` | `pattern, glob?` | a JavaScript regex over the `.md` files, lines as `path:line: text`, capped at 200 lines with a truncation note |
| `move_file` | `from, to` | rename (`not_found` / `exists`) |
| `delete_file` | `path` | delete |

Paths are vault-relative in either form (`/substances/salt.md` or
`substances/salt.md`); `..` escapes and anything outside the vault are refused
with `outside_vault`. Every result is JSON text like omg's, an error
`{ error: "<code>", message }` with the tool result flagged as an error, so the
metrics read the same (`failed_by_code`); `write_file`, `edit_file`,
`move_file` and `delete_file` count as writes, the other three as reads
(`READ_TOOLS` in `src/types.ts`).

**The system prompt.** The omgbase profiles share one prompt ("You are
operating an omgbase knowledge base through MCP tools. Complete the task;
prefer previewing with plan before committing writes you cannot undo."); `fs`
gets its analog ("You are managing a Markdown knowledge base (an Obsidian-style
vault of `.md` files with YAML frontmatter and `[[wikilinks]]`/relative links)
through filesystem tools. Complete the task; read before you write, and change
nothing beyond what the task asks."). The two differ only in naming the medium
(`src/agent.ts`, `systemPromptFor`). The task prompts are identical across all
three profiles.

**How an `fs` run is judged.** The checks are omgbase queries and reads, and
that is the point: the end state is judged by the same oracle for every
profile. After the loop the harness runs `omg sync` over the workspace — the
explicit form of the freshness sweep (spec/sync §4.3): a file whose
`(mtime, size)` moved is re-hashed and, when its bytes changed, ingested as an
observed commit; a file the cache has never seen (a new document) is ingested;
a cached path that is gone is tombstoned, so a move is a deletion plus an
insertion — then spawns `omg mcp --tools full --no-watch` over it and runs the
checks. (`--no-watch` runs no priming sweep of its own, which is why the sweep
is explicit.) The transcript records the sweep as a `sync` event
(`ingested`/`deleted` paths); the dry run prints it (`swept +3 -1` for the
move, `swept +0 -0` for a retrieval). The `unchanged` check's second half — "no
`api`-origin commit touched the document" — is vacuous under `fs`, where every
commit is observed, and the bytes comparison carries it (`src/checks.ts`); the
same holds for `unchanged_all`, whose vault-to-corpus comparison is on disk
and so judges every profile alike.

**The hook analog.** `stale-plan-retry`'s disk edit fires after the model's
first `plan`, or before its first write when no plan preceded it. Under `fs`
there is no `plan`, so it fires right before the agent's first write: the file
changes under the agent exactly as it would on a shared vault — and, unlike
omgbase, nothing refuses the stale write; it simply lands. The task's check
then tells whether the agent's write clobbered the appended line (a whole-file
`write_file` from the first read does; an exact-match `edit_file` anchored to
the end, or a re-read, does not). That is a fair analog of the same hazard,
and the scripted `solution_fs` shows the honest path: read → edit (the hook
fires before it; the paragraph lands above the new disk line) → re-read →
edit (move the paragraph below it). The hook belongs to that one writing task;
no retrieval task has one — nothing fires on a run that only reads.

**Fairness.** The `fs` tools are the honest cost of files at this corpus
size, not a handicap. `grep` returns at most 200 matching lines and says when
it cut (a generic server would cap too; over the 348-file timeline corpus the
tasks' natural greps — `^after: ` under one project, `^window: ` under
`projects/`, `^- \[ \] ` over the vault — return 10–69 lines, well under the
cap, and a grep for every `- [x]` would not), and `read_file` returns whole
files (the notes are small: 0.1–2.3 kB, 212 kB in all). An `fs` agent therefore
pays in uncached input tokens for every file it opens and every grep line it
reads, where an omgbase agent reads a query's hits; the retrieval tasks are
where that difference should show, because a bare-files agent has to hold
the corpus in its context to relate notes, while a query relates them in the
store. The timeline corpus is sized so that a vault copy, `omg init` and
`source add` take ~1.6 s — the workspace build is never the bottleneck.

**Cost expectations.** An `fs` run reads whole files (`read_file`) where an
omgbase run reads a query's hits or a block, and grep output instead of a
`links`/`query` answer, so expect more **uncached** input tokens per run than
either omgbase profile — and a far smaller cached prefix (seven short tool
definitions, ~2 k characters, against `minimal`'s ~9 k and `full`'s ~51 k).
The first three-way run (`results/2026-10-20T23-24-17Z`, the thirteen editing
tasks) measured `fs` at $0.040 per run against `minimal`'s $0.111 and `full`'s
$0.143, at 95% / 100% / 100% pass; the retrieval tasks have not been run yet.

## Cost expectations

Per model request the full catalog's tool definitions are ~51 k characters, the
minimal profile's ~9 k; with the system prompt the first real run measured them
as 22.3 k and 5.7 k tokens of cached prefix per request (Opus 5 on Bedrock).
Prompt caching is a prefix match, so the harness places **two cache
breakpoints** on every request (`src/model.ts`, both providers): one on the
system block — tools + system are identical for every turn of a run and every
run of a profile, so they come back as cache reads from the second request on —
and one on the **last block of the last message** (the prompt's text on turn 1,
the turn's last `tool_result` after that), so turn n's conversation is turn
n+1's cache read and only the newest exchange is billed uncached. The first
real run (before the second breakpoint) showed why that matters: cache reads
stayed flat at 5.7 k / 22 k per turn while uncached input grew to 28 k+ by turn
10, so the minimal profile — half the input tokens of full — cost *more*
($11.03 vs $9.23 for 39 runs each at list price), because full's big catalog
was the cheap cached part and minimal's history the expensive uncached part.

A typical run is 3–8 turns; expect roughly, per run:

| | full | minimal |
| --- | --- | --- |
| uncached input tokens | 5–30 k | 5–30 k |
| cached input tokens (reads + writes) | 100–250 k | 30–100 k |
| output tokens | 1–4 k | 1–4 k |

The report splits every cell's tokens into `uncached / cached / out` and adds a
`$ / run` column (and a total in the header) at **Anthropic list price**, from
the table in `src/pricing.ts` — keyed by the bare model id (a Bedrock
`global.anthropic.…` / `us.` / `eu.` prefix and a `[1m]` annotation are
stripped), with the four per-MTok rates the usage counters bill at: input, cache
read (0.1×), cache write (1.25×, the 5-minute TTL), output. Today: Opus 5 at
$5 / $0.50 / $6.25 / $25, Sonnet 5 at $2 / $0.20 / $2.50 / $10. A model the table
does not know prints a blank. The `$` is list price, not a bill: Amazon Bedrock
prices on its own schedule, and the run's per-request `usage` is the ground
truth (`results.json` keeps the four counters and `cost_usd` per run; the
transcript has them per request). The 13 × 3 × 3 editing run cost $11.48; a
22 × 3 × 3 run will be on the order of twenty dollars (the timeline tasks hand
the model more hits per query and more grep lines per call); `--tasks` and
`--runs 1` are the knobs for a cheap smoke run.

## The tasks

`tasks/<id>.json`, one per scenario — the thirteen **editing** tasks of the
first brief (the "split and merge" item is two tasks) and the nine
**retrieval** tasks of the second:

| id | kind | corpus | scenario |
| --- | --- | --- | --- |
| `frontmatter-edit` | edit | alchemy | a frontmatter edit |
| `append-under-heading` | edit | alchemy | append under a heading named by its TEXT ("Tasks" in calcination) |
| `create-then-section` | edit | alchemy | create a document, then add a section to it |
| `rollup` | edit | alchemy | a multi-document rollup: one line per matching doc into `index.md` |
| `stale-plan-retry` | edit | alchemy | the harness edits the file on disk right after the model's first `plan` (under `fs`: right before its first write); the stale commit fails and must be retried (under `fs`: nothing fails — the agent must not clobber the line) |
| `link-retarget` | edit | alchemy | retarget every link to one document |
| `split-paragraph` | edit | alchemy | split a paragraph at a sentence boundary |
| `merge-paragraphs` | edit | alchemy | merge two adjacent paragraphs |
| `insert-after-block` | edit | alchemy | a read-then-write that needs a block id (insert after a table) |
| `bulk-check-off` | edit | alchemy | check off every open task of a document |
| `doc-move` | edit | alchemy | move a document that has inbound links |
| `noop` | edit | alchemy | set a value to what it already is — the right move is no write |
| `contradiction` | edit | alchemy | two incompatible values for one field — report, do not force |
| `range-era` | retrieval | alchemy | **range inclusion, numeric**: which practitioners worked between 700 and 1600 CE (`era in 700..1600`) — Jabir (800), Paracelsus (1530); decoys Maria (250), Newton (1680), the Emerald Tablet (a text with `era: 800`) |
| `range-window-includes` | retrieval | timeline | **range inclusion, dates**: which milestones were in flight on 2027-03-15 (`"2027-03-15" in range(window)`, inclusive ends) — six, two of them ending and one starting on that very day; decoys end the day before / start the day after, a journal and the project indexes carry containing windows but are not milestones |
| `timeline-follow` | retrieval | timeline | **graph traversal**: Aurora's eleven milestones in sequence order from the kickoff, walking the `after:` chain forward (`follow ^docs collect { where after == ^_path }`, two walks — the depth cap is 8); date order is wrong (one milestone slipped) and a sibling project's milestone names Aurora without being in the chain |
| `timeline-between` | retrieval | timeline | **bounded traversal**: what happened between two named Delta milestones — the three notes strictly between, in order (`frontier` at the far end); decoys are the neighbours just outside |
| `backlinks-with-context` | retrieval | alchemy | **backlinks + section**: which documents link to `/processes/calcination.md` from their body, and under which heading (`links` rows joined to `_block._section`) — five; decoys mention calcination in prose or in a `see_also` frontmatter list |
| `aggregate-by-key` | retrieval | timeline | **aggregation**: open milestones per project (`group by project`, `count()`), including the zero (ember), and which has the most (delta, 5); `blocked`/`dropped` are not `open` |
| `open-tasks-across-corpus` | retrieval | timeline | **structure across the corpus**: every unchecked task in the vault with its note (`md:task` nodes, `not checked`) — fourteen among 487 checked ones; the decoy is a `- [ ]` example inside a code fence |
| `semantic-find` | retrieval | alchemy | **semantic search** (`requires: ["semantic"]`): the lab note arguing repeated purification is not transformation, found by meaning (`order by semantic("…") desc` over paragraphs of lab notes); skipped under full/minimal without `--embedder`; `fs` greps |
| `rollup-filtered` | retrieval + write | timeline | **find across, then write**: append to `index.md` one line per milestone owned by Mara Lindqvist, done and closed in 2027, by closing date — three across two projects; decoys are her 2026/2028 ones and Mara **Lind**'s `Open day` |

A task file:

```jsonc
{
  "id": "frontmatter-edit",              // = the file name
  "prompt": "…",                         // what the model is told, identical across profiles
  "corpus": "alchemy",                   // optional: alchemy (default) | timeline — which corpus the workspace is built from
  "requires": ["semantic"],              // optional: capabilities an omgbase profile needs (else the cell is skipped, not failed)
  "checks": [ … ],                       // all must pass (below) — through omgbase, under every profile
  "unchanged_all": true,                 // optional: a pure retrieval — the whole vault must equal the corpus and no api commit may exist
  "hook": { … },                         // optional: the stale-plan disk edit
  "solution": { "steps": [ … ], "final_text": "…" },     // the oracle for full/minimal (--dry and the tests): minimal's tools
  "solution_fs": { "steps": [ … ], "final_text": "…" },  // the oracle for fs: the seven file tools
  "trivial_on_fresh": false,             // optional: skip the negative control
  "notes": "…"
}
```

Checks (`src/types.ts`):

| kind | what it asserts |
| --- | --- |
| `query` | the OQX `query` returns exactly `hits` (in order; each expected key deep-equal) and/or `count` |
| `read` | `docs_read { _path }`'s `_raw` bytes `equals` a string, match every `matches` regex, match none of `not_matches` (the check's own `path` member is the harness's name for it; the tool argument is `_path`, surface 5.0) |
| `unchanged` | the bytes equal the corpus file **and** no `api`-origin commit touched the document (`changes_since`; vacuous under `fs`, where the bytes carry the check) |
| `final_text` | the model's last assistant text matches the regex |
| `answer` | a retrieval task's verdict over the model's final text: it mentions every entry of `must_mention`, none of `must_not_mention` (the decoys), and `count.pattern` matches exactly `count.equals` times. An entry is a case-insensitive substring, or a regex when written `/…/` (flags `is`, so `/a[\s\S]*b/` pins an order); `count.pattern` is a regex (`gis`). On failure the answer is quoted |

A task-level `unchanged_all: true` adds, after the checks: the vault equals the
corpus file for file on disk (nothing added, removed or edited — judged the
same under every profile) and `changes_since { origin: "api" }` is empty. Every
pure retrieval task carries it, so an agent that "helpfully" writes fails.

The hook (`stale-plan-retry` only): `{ "kind": "disk_edit", "on":
"after_first_plan", "path": "timeline/review.md", "append": "…" }` appends to
the file on disk once, right after the model's first successful `plan` — or,
when the model never plans and goes straight to a write, right before that
first write (`also_before_first_write`, default true), so the scenario is the
same under every profile. An omgbase server answers the stale commit with
`sync_conflict` ("file changed on disk; re-ingested — retry", retriable) and
re-ingests; the file tools answer nothing — the write lands. The check needs
both the disk line and the model's paragraph, in order.

The solution's `args` may reference earlier steps: `{ "$result": 0 }` is step 0's
parsed result, `{ "$result": 0, "$get": "hits.0._id" }` a member of it (a query
hit is `{ _id, _path, … }`, surface 5.0); a step
that is supposed to fail says `"expect_error": "<code>"`.

The `solution_fs` oracles are the fixed `read_file`/`edit_file`/`write_file`/
`move_file`/`grep` sequences that reach the end state — or the answer — on bare
files, their `old_string`s taken from the corpus bytes: `doc-move` greps for
the old path, moves the file and rewrites both inbound links by hand;
`link-retarget` edits the four linking files; `rollup` greps the process notes'
frontmatter and appends to `index.md`; `bulk-check-off` edits three lines;
`split-paragraph` and `merge-paragraphs` are string edits;
`create-then-section` is a `write_file` then an `edit_file`; `noop` and
`contradiction` read and make no write; `stale-plan-retry` is the read → edit →
re-read → edit above. The retrieval oracles are greps: `^era: ` over the
practitioners; `^window: ` and `^title: ` under `projects/`; `^after: ` and
`^title: ` under one project (then chained by hand); the link path and every
heading line (paired by line number); `^status: open$` under `projects/` plus a
`list_files` for the zero; `^- \[ \] ` over the vault plus a read of the
template to see the fence; `transform` over `lab/`; and for `rollup-filtered`
the owner's lines, the `status:`/`closed:` lines, a read and one exact-match
edit of `index.md`. `--dry` proves, for `fs` as for the omgbase profiles, that
every task is solvable with the profile's tools and that the checks
discriminate. Each task's `notes` says what the omgbase answer rests on, what
the decoys are and how `fs` gets there.

### Adding a task

1. Write `tasks/<id>.json` with a prompt, checks, a scripted `solution` that
   reaches the end state using tools of the **minimal** profile (so `--dry`
   is green under both omgbase profiles) and a `solution_fs` that reaches it
   with the seven file tools. Name the corpus (`"corpus": "timeline"`) when it
   is not alchemy; a retrieval task ends with an `answer` check and
   `unchanged_all: true`. Under the sequential minter the alchemy ids are
   stable, so a solution may name them (`b_153`); timeline tasks name paths,
   never ids (below). When a solution must discover an id, use a `query` step
   and `$result`. Spell names the surface 5.0 way: an
   engine attribute is `_`-prefixed in a query, an argument, a target and a
   result (`_path`, `_type`, `_kind`, `docs_read { _path }`, `{ kind:
   "document", _path }`, `{ kind: "block", _id }`, `_frontmatter.<k>`,
   `_attrs.checked`, `hits.0._id`); an authored frontmatter key or `attrs` key
   stays bare (`verified`, `layer`, `checked`); roles stay bare (`docs_create`'s
   `path`, `to`, `heading_id`, `at`, `expect`).
2. `pnpm bench --dry --tasks <id> --profiles full,minimal,fs` — each solution
   must pass the checks and the checks must fail on a fresh workspace.
3. `pnpm test` — `test/tasks.test.ts` pins the task list; extend it (and
   `test/retrieval.test.ts` for a retrieval task).

## The timeline corpus

`corpora/timeline/` is a **generated** corpus: 348 small Markdown notes (0.1–2.3
kB each, 212 kB in all) describing a fictional three-year programme —
"Meridian", a mountain observatory, 2026–2028 — written by `src/corpus.ts` as a
pure function of that file (a seeded PRNG for the filler; the facts the tasks
rest on are authored tables in the source). The snapshot is committed so a
transcript is reproducible and `fixtureBytes`/`unchanged_all` have bytes to
compare against; `pnpm --filter agent-bench corpus` regenerates it, and
`test/corpus.test.ts` fails when the snapshot and a fresh generation differ.

Shape:

- `/index.md` — the hub: the six projects, the ten people, the conventions.
- `projects/<slug>/index.md` × 6 and `projects/<slug>/<milestone>.md` × 63 —
  the projects (`aurora` the spectrograph, 11 milestones; `basalt` site works,
  9; `cirrus` dome and enclosure, 12; `delta` data pipeline, 13; `ember` power
  and cooling, 8; `fjord` partnerships and outreach, 10), each a **chain** of
  milestone notes. A milestone's frontmatter: `type: milestone`, `project`,
  `title`, `when` (its date), `window: <first-day>..<last-day>` (a date range,
  spec/properties §2.2 — full ISO dates, inclusive ends), `status` (`open` ×
  15, `done` × 46, `blocked` × 1, `dropped` × 1), `closed` on the done ones,
  `owner: /people/<slug>.md` (a frontmatter link), `track` (instrument / civil
  / software / operations / outreach — the categorical key), `effort` (story
  points, numeric), `tags`, and **`after: /projects/<p>/<previous>.md`** — the
  milestone before it, repository-root path, one side only (the kickoff has
  none). Dates are monotone along every chain except Aurora's, where
  "Detector cooldown test" slipped past "Slit mask fabrication". Bodies: an H1
  (= `title`), a paragraph linking the project index and the owner (a
  `#hashtag`), a `## Scope` list, `## Notes` linking a decision and one
  milestone of another project, `## Tasks` with `- [x]` items (and the open
  ones the table below places).
- `people/<slug>.md` × 10 — `type: person`, `role`, `team`; what they own.
  **Mara Lindqvist** leads Aurora; **Mara Lind** (outreach) is the near-miss
  name.
- `meetings/<date>-weekly.md` × 130 — one per Tuesday 2026-01-06..2028-06-27:
  `attendees` (people links), the milestones in flight that week (links), a
  decision, two `- [x]` actions.
- `decisions/<nnn>-<slug>.md` × 40, `journal/<yyyy-mm>.md` × 30 (each with a
  month-long `window`), `glossary/<term>.md` × 30, `risks/r-<nn>-<slug>.md` ×
  25, `vendors/<slug>.md` × 12 (one is "Aurora Optics Ltd"), and
  `templates/meeting.md`, whose fenced code block shows `- [ ] Action item
  (owner, due date)`.

The decoys the tasks lean on: windows that end on 2027-03-15 (two) or start on
it (one), against ones ending 03-14 / starting 03-16 and a milestone *closed*
on 03-15 whose window ended earlier; a journal and the project indexes whose
windows contain the date; the slipped Aurora date; cirrus's "Dome slit
alignment to the spectrograph", tagged `aurora`, whose body names the Aurora
team; `blocked` and `dropped` beside `open`; the fenced task; Mara Lind beside
Mara Lindqvist. Exactly **fourteen** `- [ ]` tasks are open in the whole
corpus (`OPEN_TASKS` in the source), placed in people, milestone, meeting,
decision, journal, risk and vendor notes.

Two engine facts shaped the corpus. `[[wikilinks]]` resolve to
`phantom:<name>` in this engine (no basename resolution), so every link that
must resolve is a path link; a handful of `[[glossary]]` wikilinks remain as
flavour. And the **sequential id minter** (`OMGBASE_SPEC_MINTER=sequential`,
`packages/core/src/core/ids.ts`) starts a fresh issued set in every process and
gives up after 1000 in-use candidates — fine for alchemy's ~300 blocks, but the
timeline corpus has thousands, so a second process (the MCP server's first
write, `omg sync`) could mint nothing; timeline workspaces therefore run under
the production minter (`CORPORA` in `src/workspace.ts`), their ids differ run
to run, and timeline tasks name paths, never ids. The clock seam applies to
both corpora.

A note on `after:`. Following Brendan's field definition (`after` names the
documents that come *before* this one in a sequence; each document carries one
side and the other is derived — `^docs collect { where ^_path in list(after)
}`), the forward walk is the inverse relation. The alchemy fixture's
`timeline/kickoff.md` uses the word in the opposite sense (`after:
/timeline/review.md`, a later note), which is why the retrieval prompts spell
the semantics out.

## Reading the report

```
| task | corpus | profile | pass | turns | calls | failed | uncached / cached / out | $ / run | wall s | plan→write |
```

The header line names which profiles are omgbase and which is the filesystem
baseline (`` `full`, `minimal` (omgbase MCP), `fs` (filesystem baseline, no
omgbase) ``), the corpora the run spanned, how many runs were skipped, and the
embedder (or that none was given, so semantic tasks were skipped under the
omgbase profiles); the per-profile sections carry the same label.

- **corpus** — `alchemy` or `timeline`. The "Totals per profile" table adds a
  row per corpus when the run spans both, then the `all` row.
- **pass** — runs whose every check passed, over runs (`k/n (p%)`); or
  `skipped (needs --embedder)` for a cell that did not run — it is neither a
  pass nor a failure and enters no mean or total.
- **turns** — mean model requests per run (an assistant turn with tool calls
  plus the final answer; the turn cap is 20).
- **calls** — mean tool calls per run; **failed** — mean calls that returned an
  error envelope or were refused (`unknown_tool` under a profile); the
  per-profile sections list the codes (`filter_invalid`, `sync_conflict`,
  `conflicting_effects`, `provider_unavailable`, … — under `fs`: `no_match`,
  `ambiguous_match`, `not_found`, `outside_vault`, `exists`), the tool-call
  histogram and the skipped runs.
- **uncached / cached / out** — mean tokens per run: input billed at full price,
  input served from or written to the cache (reads + writes; a tenth and 1.25×
  of the input price), and output. `results.json` keeps the four counters apart.
- **$ / run** — mean cost per run at Anthropic list price (`src/pricing.ts`);
  blank when the model is not in the table. The header carries the total.
- **wall s** — mean wall time per run (model + server; under `fs` the sweep and
  the check server are outside the loop and not counted).
- **plan→write** — of the runs that wrote something, the share whose first
  write was preceded by a `plan` (`—` when no run wrote: the no-op, the
  contradiction, every pure retrieval; and always under `fs`, which has no
  plan tool).

The "Runs" table lists each run with its verdict (`pass` / `FAIL` / `skip`),
its check failures (an `answer` failure quotes the answer) and a link to its
transcript.

### Metrics schema (`results.json` → `results[]`)

| field | meaning |
| --- | --- |
| `task`, `corpus`, `profile`, `run`, `model` | the cell |
| `skipped` | set (the reason, `needs --embedder`) when the cell did not run; every count below is then zero |
| `turns` | model requests |
| `tool_calls`, `calls_by_tool` | forwarded calls, and per tool |
| `failed_calls`, `failed_by_code` | calls that failed, and per error code (`unknown_tool` = refused by the profile, `rpc_error` = transport) |
| `plan_calls`, `execute_calls`, `write_calls` | counts; a write is any tool not in `READ_TOOLS` (`src/types.ts`; `plan` counts as a read, so do `list_files`/`read_file`/`grep`) |
| `plan_before_write` | did a `plan` precede the first write? `null` when nothing was written (always `false` for an `fs` run that wrote) |
| `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | summed over the run's requests; `input_tokens` is the *uncached* input |
| `cost_usd` | the run at Anthropic list price (`src/pricing.ts`); absent for an unpriced model |
| `wall_ms`, `hit_turn_cap`, `hook_fired` | |
| `passed`, `check_failures` | the end-state verdict and why |
| `final_text` | the model's last assistant text (what an `answer` check judged) |
| `transcript` | `transcripts/<task>.<profile>.<run>.jsonl`, relative to the results directory |
| `error` | set when the harness or the API failed (the run counts as failed) |

A transcript is one JSON object per line: `start` (system prompt, task prompt,
the tool names served), `assistant` (the full content incl. thinking blocks,
`stop_reason`, that request's usage), `tool_call`, `tool_result` (ok / error
code / ms / the parsed result), `hook`, `end`, `sync` (`fs` only: the sweep's
`ingested`/`deleted`/`conflicted` paths), `check`, `error` — or, for a skipped
cell, the single line `skip` (task, profile, run, reason).

## Layout

```
src/corpus.ts      the timeline corpus: authored projects/milestones/people/open tasks + seeded filler → corpora/timeline (pnpm corpus)
src/workspace.ts   fresh workspace from a named corpus under the seams (the minter seam where the corpus allows); fixture bytes;
                   syncWorkspace (omg sync, the fs profile's sweep); embedWorkspace (--embedder: drain + wait); vaultDiff
src/server.ts      the ToolServer seam (tools / call / close) and CallOutcome
src/mcp.ts         OmgServer: spawn omg mcp, tools/list → Anthropic tool defs, forward calls
src/fs-server.ts   FsServer: the fs profile's seven file tools over vault/, path safety, the exact-match edit rule
src/model.ts       the Model seam: ClaudeModel (SDK; the two cache breakpoints; isCredentialError) and ScriptedModel (a task's solution)
src/agent.ts       the tool-use loop, the two system prompts, the hook, the per-run metrics and events
src/checks.ts      the five check kinds + unchanged_all (always through an omg server; the vault compared on disk)
src/tasks.ts       load + validate tasks/*.json (corpus, requires, checks incl. answer, solution + solution_fs)
src/pricing.ts     list prices per bare model id; a run's cost from its four counters
src/report.ts      results → report.md (corpus column, per-corpus totals, skipped cells)
src/bench.ts       the CLI: cells, the agent/check servers per profile, --embedder and the skip rule, --dry, results/<timestamp>/, the credential probe
tasks/*.json       the twenty-two tasks (thirteen editing, nine retrieval)
corpora/timeline/  the committed timeline snapshot (348 files; regenerate with pnpm corpus)
test/*.test.ts     vitest: tasks validate; deterministic bootstrap; the loop end to end
                   against the real omg mcp with the scripted model (no API spend);
                   the hook fires; FsServer's tools and the fs profile end to end
                   (hook before the first write, sweep, omgbase checks); the corpus
                   is deterministic and its oracle queries answer what the tasks
                   expect; the answer and unchanged_all checks; one dry run per
                   retrieval task (the semantic one's skip path); the report
                   renders; bench writes its files and skips what it must
```

Gates: `pnpm --filter agent-bench test`, `lint`, `typecheck`,
`pnpm bench --dry --profiles full,minimal,fs` (and, with a local embedder,
`pnpm bench --dry --tasks semantic-find --embedder <cmd>`).
Sources are TypeScript run directly by Node's type stripping (Node ≥ 22.18;
`erasableSyntaxOnly`), no build step.
