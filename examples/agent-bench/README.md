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

Three **profiles**, one per surface: `full` and `minimal` are omgbase;
`fs` is the filesystem baseline. For every (task, profile, run) cell the harness:

1. builds a **fresh workspace** from the alchemy corpus
   (`packages/core/corpus/oqx/fixtures/alchemy`) exactly as the CLI spec runner
   does — `omg init --yes --no-embedder`, `omg source add vault --repo fixture -y`
   under `OMGBASE_SPEC_MINTER=sequential` / `OMGBASE_SPEC_CLOCK`, so ids are
   deterministic (`d_0` is `/index.md`, `b_153` the "Tasks" heading of
   calcination) and a task can name them;
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
   server for the checks.

Only the local `omg mcp` is ever used; nothing here knows about any remote
gateway.

## Running

```
pnpm build                                      # at the repo root: the harness spawns packages/cli/dist/src/main.js
export ANTHROPIC_API_KEY=sk-ant-…              # or an `ant auth login` profile — the SDK resolves either; or Bedrock, below
pnpm --filter agent-bench bench --profiles full,minimal,fs   # the three-way comparison: 13 tasks × 3 profiles × 3 runs → results/<timestamp>/
pnpm --filter agent-bench bench                 # the omgbase pair only: 13 tasks × {full, minimal} × 3 runs
pnpm --filter agent-bench bench --dry           # no model: prove the tasks and checks (below)
```

```
pnpm bench [--profiles full,minimal,fs] [--runs 3] [--tasks id,id] [--model claude-opus-5]
           [--effort low|medium|high|xhigh|max] [--max-turns 20] [--out results] [--dry]
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

### `--dry`: proving the checks without the model

`pnpm bench --dry` loads and validates every task, then for each task and
profile:

- replays the task's **scripted solution for that profile** (`solution.steps`
  under `full`/`minimal`, `solution_fs.steps` under `fs` — a fixed tool-call
  sequence) through the real agent loop against a fresh workspace — so the
  stale-plan hook fires exactly as it would for the model — and requires every
  step to succeed (or to fail with the error it says it expects) and every
  check to pass;
- runs the checks against an **untouched** workspace and requires them to
  **fail** (a task may opt out with `trivial_on_fresh: true`; none does today —
  the no-op's `final_text` check discriminates).

Green means every check describes a reachable end state and rejects the
starting one — and, per profile, that every task is solvable with that
profile's tools. ~20 s per profile; `--profiles full,minimal,fs` is 78 cells
in under a minute.

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
move). The `unchanged` check's second half — "no `api`-origin commit touched
the document" — is vacuous under `fs`, where every commit is observed, and the
bytes comparison carries it (`src/checks.ts`).

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
edit (move the paragraph below it).

**Cost expectations.** An `fs` run reads whole files (`read_file`) where an
omgbase run reads a query's hits or a block, and grep output instead of a
`links`/`query` answer, so expect more **uncached** input tokens per run than
either omgbase profile — and a far smaller cached prefix (seven short tool
definitions, ~2 k characters, against `minimal`'s ~9 k and `full`'s ~51 k).
The numbers belong to the first real run; the table in "Cost expectations"
below is the omgbase pair's.

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
transcript has them per request). A full 13 × 2 × 3 run is on the order of
ten to twenty dollars (a 13 × 3 × 3 run with `fs` proportionally more);
`--tasks` and `--runs 1` are the knobs for a cheap smoke run.

## The tasks

`tasks/<id>.json`, one per scenario of the brief (the "split and merge" item is
two tasks):

| id | scenario |
| --- | --- |
| `frontmatter-edit` | a frontmatter edit |
| `append-under-heading` | append under a heading named by its TEXT ("Tasks" in calcination) |
| `create-then-section` | create a document, then add a section to it |
| `rollup` | a multi-document rollup: one line per matching doc into `index.md` |
| `stale-plan-retry` | the harness edits the file on disk right after the model's first `plan` (under `fs`: right before its first write); the stale commit fails and must be retried (under `fs`: nothing fails — the agent must not clobber the line) |
| `link-retarget` | retarget every link to one document |
| `split-paragraph` | split a paragraph at a sentence boundary |
| `merge-paragraphs` | merge two adjacent paragraphs |
| `insert-after-block` | a read-then-write that needs a block id (insert after a table) |
| `bulk-check-off` | check off every open task of a document |
| `doc-move` | move a document that has inbound links |
| `noop` | set a value to what it already is — the right move is no write |
| `contradiction` | two incompatible values for one field — report, do not force |

A task file:

```jsonc
{
  "id": "frontmatter-edit",              // = the file name
  "prompt": "…",                         // what the model is told, identical across profiles
  "checks": [ … ],                       // all must pass (below) — through omgbase, under every profile
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
| `unchanged` | the bytes equal the fixture file **and** no `api`-origin commit touched the document (`changes_since`; vacuous under `fs`, where the bytes carry the check) |
| `final_text` | the model's last assistant text matches the regex |

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
`move_file` sequences that reach the end state on bare files, their
`old_string`s taken from the corpus bytes: `doc-move` greps for the old path,
moves the file and rewrites both inbound links by hand; `link-retarget` edits
the four linking files; `rollup` greps the process notes' frontmatter and
appends to `index.md`; `bulk-check-off` edits three lines; `split-paragraph`
and `merge-paragraphs` are string edits; `create-then-section` is a
`write_file` then an `edit_file`; `noop` and `contradiction` read and make no
write; `stale-plan-retry` is the read → edit → re-read → edit above. `--dry`
proves, for `fs` as for the omgbase profiles, that every task is solvable with
the profile's tools and that the checks discriminate.

### Adding a task

1. Write `tasks/<id>.json` with a prompt, checks, a scripted `solution` that
   reaches the end state using tools of the **minimal** profile (so `--dry`
   is green under both omgbase profiles) and a `solution_fs` that reaches it
   with the seven file tools. Under the sequential minter the fixture ids
   are stable, so a solution may name them (`b_153`); when it must discover
   one, use a `query` step and `$result`. Spell names the surface 5.0 way: an
   engine attribute is `_`-prefixed in a query, an argument, a target and a
   result (`_path`, `_type`, `_kind`, `docs_read { _path }`, `{ kind:
   "document", _path }`, `{ kind: "block", _id }`, `_frontmatter.<k>`,
   `_attrs.checked`, `hits.0._id`); an authored frontmatter key or `attrs` key
   stays bare (`verified`, `layer`, `checked`); roles stay bare (`docs_create`'s
   `path`, `to`, `heading_id`, `at`, `expect`).
2. `pnpm bench --dry --tasks <id> --profiles full,minimal,fs` — each solution
   must pass the checks and the checks must fail on a fresh workspace.
3. `pnpm test` — `test/tasks.test.ts` pins the task list; extend it.

## Reading the report

```
| task | profile | pass | turns | calls | failed | uncached / cached / out | $ / run | wall s | plan→write |
```

The header line names which profiles are omgbase and which is the filesystem
baseline (`` `full`, `minimal` (omgbase MCP), `fs` (filesystem baseline, no
omgbase) ``); the per-profile sections carry the same label.

- **pass** — runs whose every check passed, over runs (`k/n (p%)`).
- **turns** — mean model requests per run (an assistant turn with tool calls
  plus the final answer; the turn cap is 20).
- **calls** — mean tool calls per run; **failed** — mean calls that returned an
  error envelope or were refused (`unknown_tool` under a profile); the
  per-profile sections list the codes (`filter_invalid`, `sync_conflict`,
  `conflicting_effects`, … — under `fs`: `no_match`, `ambiguous_match`,
  `not_found`, `outside_vault`, `exists`) and the tool-call histogram.
- **uncached / cached / out** — mean tokens per run: input billed at full price,
  input served from or written to the cache (reads + writes; a tenth and 1.25×
  of the input price), and output. `results.json` keeps the four counters apart.
- **$ / run** — mean cost per run at Anthropic list price (`src/pricing.ts`);
  blank when the model is not in the table. The header carries the total.
- **wall s** — mean wall time per run (model + server; under `fs` the sweep and
  the check server are outside the loop and not counted).
- **plan→write** — of the runs that wrote something, the share whose first
  write was preceded by a `plan` (`—` when no run wrote: the no-op, the
  contradiction; and always under `fs`, which has no plan tool).

The "Totals per profile" table aggregates every task; the "Runs" table lists
each run with its check failures and a link to its transcript.

### Metrics schema (`results.json` → `results[]`)

| field | meaning |
| --- | --- |
| `task`, `profile`, `run`, `model` | the cell |
| `turns` | model requests |
| `tool_calls`, `calls_by_tool` | forwarded calls, and per tool |
| `failed_calls`, `failed_by_code` | calls that failed, and per error code (`unknown_tool` = refused by the profile, `rpc_error` = transport) |
| `plan_calls`, `execute_calls`, `write_calls` | counts; a write is any tool not in `READ_TOOLS` (`src/types.ts`; `plan` counts as a read, so do `list_files`/`read_file`/`grep`) |
| `plan_before_write` | did a `plan` precede the first write? `null` when nothing was written (always `false` for an `fs` run that wrote) |
| `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | summed over the run's requests; `input_tokens` is the *uncached* input |
| `cost_usd` | the run at Anthropic list price (`src/pricing.ts`); absent for an unpriced model |
| `wall_ms`, `hit_turn_cap`, `hook_fired` | |
| `passed`, `check_failures` | the end-state verdict and why |
| `final_text` | the model's last assistant text |
| `transcript` | `transcripts/<task>.<profile>.<run>.jsonl`, relative to the results directory |
| `error` | set when the harness or the API failed (the run counts as failed) |

A transcript is one JSON object per line: `start` (system prompt, task prompt,
the tool names served), `assistant` (the full content incl. thinking blocks,
`stop_reason`, that request's usage), `tool_call`, `tool_result` (ok / error
code / ms / the parsed result), `hook`, `end`, `sync` (`fs` only: the sweep's
`ingested`/`deleted`/`conflicted` paths), `check`, `error`.

## Layout

```
src/workspace.ts   fresh alchemy workspace under the seams; fixture bytes; syncWorkspace (omg sync, the fs profile's sweep)
src/server.ts      the ToolServer seam (tools / call / close) and CallOutcome
src/mcp.ts         OmgServer: spawn omg mcp, tools/list → Anthropic tool defs, forward calls
src/fs-server.ts   FsServer: the fs profile's seven file tools over vault/, path safety, the exact-match edit rule
src/model.ts       the Model seam: ClaudeModel (SDK; the two cache breakpoints; isCredentialError) and ScriptedModel (a task's solution)
src/agent.ts       the tool-use loop, the two system prompts, the hook, the per-run metrics and events
src/checks.ts      the four check kinds (always through an omg server)
src/tasks.ts       load + validate tasks/*.json (solution + solution_fs)
src/pricing.ts     list prices per bare model id; a run's cost from its four counters
src/report.ts      results → report.md
src/bench.ts       the CLI: cells, the agent/check servers per profile, --dry, results/<timestamp>/, the first-request credential probe
tasks/*.json       the thirteen tasks
test/*.test.ts     vitest: tasks validate; deterministic bootstrap; the loop end to end
                   against the real omg mcp with the scripted model (no API spend);
                   the hook fires; FsServer's tools and the fs profile end to end
                   (hook before the first write, sweep, omgbase checks); the report
                   renders; bench writes its files
```

Gates: `pnpm --filter agent-bench test`, `lint`, `typecheck`,
`pnpm bench --dry --profiles full,minimal,fs`.
Sources are TypeScript run directly by Node's type stripping (Node ≥ 22.18;
`erasableSyntaxOnly`), no build step.
