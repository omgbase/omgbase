# agent-bench — full catalog vs minimal profile, measured

A private benchmark harness (unpublished, `private: true`) that answers one
question: **does an agent work an omgbase knowledge base better against the
full 47-tool MCP catalog or against the minimal ~10-tool profile**
(`omg mcp --tools minimal`: `docs_read`, `docs_tree`, `query_syntax`, `query`,
`blocks_resolve`, `apply`, `plan`, `execute`, `changes_since`, `version`)?

For every (task, profile, run) cell it:

1. builds a **fresh workspace** from the alchemy corpus
   (`packages/core/corpus/oqx/fixtures/alchemy`) exactly as the CLI spec runner
   does — `omg init --yes --no-embedder`, `omg source add vault --repo fixture -y`
   under `OMGBASE_SPEC_MINTER=sequential` / `OMGBASE_SPEC_CLOCK`, so ids are
   deterministic (`d_0` is `/index.md`, `b_153` the "Tasks" heading of
   calcination) and a task can name them;
2. spawns the built CLI as an MCP stdio server —
   `omg mcp -C <workspace> --no-watch [--tools <profile>]` — connects with
   `@modelcontextprotocol/sdk` and hands `tools/list` to the model **verbatim**
   (name, description, input schema);
3. drives Claude through `@anthropic-ai/sdk` with the task prompt and one fixed
   system prompt (identical across profiles), forwarding every tool call to the
   server and its result back, until the model stops calling tools or the turn
   cap (20) is hit;
4. runs the task's machine-checkable **end-state checks** through the same
   server and records the metrics and the full transcript.

Only the local `omg mcp` is ever used; nothing here knows about any remote
gateway.

## Running

```
pnpm build                                      # at the repo root: the harness spawns packages/cli/dist/src/main.js
export ANTHROPIC_API_KEY=sk-ant-…              # or an `ant auth login` profile — the SDK resolves either; or Bedrock, below
pnpm --filter agent-bench bench                 # 13 tasks × {full, minimal} × 3 runs → results/<timestamp>/
pnpm --filter agent-bench bench --dry           # no model: prove the tasks and checks (below)
```

```
pnpm bench [--profiles full,minimal] [--runs 3] [--tasks id,id] [--model claude-opus-5]
           [--effort low|medium|high|xhigh|max] [--max-turns 20] [--out results] [--dry]
```

Defaults: both profiles, 3 runs per cell, `claude-opus-5` (the current
recommendation for agentic tool use) with adaptive thinking at effort `high`,
turn cap 20. `OMG=<path to main.js>` points the harness at another omg build.
The profile is a plain config value: `--profiles full` runs today's catalog,
`--profiles full,minimal` adds `--tools minimal` to the server's argv and nothing
else changes, so the harness runs unchanged once that flag exists in a build
(it does in the current one; `test/workspace.test.ts` skips the profile test
on a build without it).

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
and is visible in the transcript. A benchmark comparing two tool surfaces must
be answered by one model, so the server-side fallback the SDK offers is
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

- replays the task's **scripted solution** (`solution.steps`, a fixed tool-call
  sequence) through the real agent loop against a fresh workspace — so the
  stale-plan hook fires exactly as it would for the model — and requires every
  step to succeed (or to fail with the error it says it expects) and every
  check to pass;
- runs the checks against an **untouched** workspace and requires them to
  **fail** (a task may opt out with `trivial_on_fresh: true`; none does today —
  the no-op's `final_text` check discriminates).

Green means every check describes a reachable end state and rejects the
starting one. ~30 s per profile.

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
ten to twenty dollars; `--tasks` and `--runs 1` are the knobs for a cheap smoke
run.

## The tasks

`tasks/<id>.json`, one per scenario of the brief (the "split and merge" item is
two tasks):

| id | scenario |
| --- | --- |
| `frontmatter-edit` | a frontmatter edit |
| `append-under-heading` | append under a heading named by its TEXT ("Tasks" in calcination) |
| `create-then-section` | create a document, then add a section to it |
| `rollup` | a multi-document rollup: one line per matching doc into `index.md` |
| `stale-plan-retry` | the harness edits the file on disk right after the model's first `plan`; the stale commit fails and must be retried |
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
  "checks": [ … ],                       // all must pass (below)
  "hook": { … },                         // optional: the stale-plan disk edit
  "solution": { "steps": [ … ], "final_text": "…" },  // the oracle for --dry and the tests
  "trivial_on_fresh": false,             // optional: skip the negative control
  "notes": "…"
}
```

Checks (`src/types.ts`):

| kind | what it asserts |
| --- | --- |
| `query` | the OQX `query` returns exactly `hits` (in order; each expected key deep-equal) and/or `count` |
| `read` | `docs_read { _path }`'s `_raw` bytes `equals` a string, match every `matches` regex, match none of `not_matches` (the check's own `path` member is the harness's name for it; the tool argument is `_path`, surface 5.0) |
| `unchanged` | the bytes equal the fixture file **and** no `api`-origin commit touched the document (`changes_since`) |
| `final_text` | the model's last assistant text matches the regex |

The hook (`stale-plan-retry` only): `{ "kind": "disk_edit", "on":
"after_first_plan", "path": "timeline/review.md", "append": "…" }` appends to
the file on disk once, right after the model's first successful `plan` — or,
when the model never plans and goes straight to a write, right before that
first write (`also_before_first_write`, default true), so the scenario is the
same under both profiles. The server answers the stale commit with
`sync_conflict` ("file changed on disk; re-ingested — retry", retriable) and
re-ingests; the check needs both the disk line and the model's paragraph.

The solution's `args` may reference earlier steps: `{ "$result": 0 }` is step 0's
parsed result, `{ "$result": 0, "$get": "hits.0._id" }` a member of it (a query
hit is `{ _id, _path, … }`, surface 5.0); a step
that is supposed to fail says `"expect_error": "<code>"`.

### Adding a task

1. Write `tasks/<id>.json` with a prompt, checks and a scripted solution that
   reaches the end state using tools of the **minimal** profile (so `--dry`
   is green under both profiles). Under the sequential minter the fixture ids
   are stable, so a solution may name them (`b_153`); when it must discover
   one, use a `query` step and `$result`. Spell names the surface 5.0 way: an
   engine attribute is `_`-prefixed in a query, an argument, a target and a
   result (`_path`, `_type`, `_kind`, `docs_read { _path }`, `{ kind:
   "document", _path }`, `{ kind: "block", _id }`, `_frontmatter.<k>`,
   `_attrs.checked`, `hits.0._id`); an authored frontmatter key or `attrs` key
   stays bare (`verified`, `layer`, `checked`); roles stay bare (`docs_create`'s
   `path`, `to`, `heading_id`, `at`, `expect`).
2. `pnpm bench --dry --tasks <id>` — the solution must pass the checks and the
   checks must fail on a fresh workspace.
3. `pnpm test` — `test/tasks.test.ts` pins the task list; extend it.

## Reading the report

```
| task | profile | pass | turns | calls | failed | uncached / cached / out | $ / run | wall s | plan→write |
```

- **pass** — runs whose every check passed, over runs (`k/n (p%)`).
- **turns** — mean model requests per run (an assistant turn with tool calls
  plus the final answer; the turn cap is 20).
- **calls** — mean tool calls per run; **failed** — mean calls that returned an
  error envelope or were refused (`unknown_tool` under a profile); the
  per-profile sections list the codes (`filter_invalid`, `sync_conflict`,
  `conflicting_effects`, …) and the tool-call histogram.
- **uncached / cached / out** — mean tokens per run: input billed at full price,
  input served from or written to the cache (reads + writes; a tenth and 1.25×
  of the input price), and output. `results.json` keeps the four counters apart.
- **$ / run** — mean cost per run at Anthropic list price (`src/pricing.ts`);
  blank when the model is not in the table. The header carries the total.
- **wall s** — mean wall time per run (model + server).
- **plan→write** — of the runs that wrote something, the share whose first
  write was preceded by a `plan` (`—` when no run wrote: the no-op, the
  contradiction).

The "Totals per profile" table aggregates every task; the "Runs" table lists
each run with its check failures and a link to its transcript.

### Metrics schema (`results.json` → `results[]`)

| field | meaning |
| --- | --- |
| `task`, `profile`, `run`, `model` | the cell |
| `turns` | model requests |
| `tool_calls`, `calls_by_tool` | forwarded calls, and per tool |
| `failed_calls`, `failed_by_code` | calls that failed, and per error code (`unknown_tool` = refused by the profile, `rpc_error` = transport) |
| `plan_calls`, `execute_calls`, `write_calls` | counts; a write is any tool not in `READ_TOOLS` (`src/types.ts`; `plan` counts as a read) |
| `plan_before_write` | did a `plan` precede the first write? `null` when nothing was written |
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
code / ms / the parsed result), `hook`, `end`, `check`, `error`.

## Layout

```
src/workspace.ts   fresh alchemy workspace under the seams; fixture bytes
src/mcp.ts         spawn omg mcp, tools/list → Anthropic tool defs, forward calls
src/model.ts       the Model seam: ClaudeModel (SDK; the two cache breakpoints; isCredentialError) and ScriptedModel (a task's solution)
src/agent.ts       the tool-use loop, the hook, the per-run metrics and events
src/checks.ts      the four check kinds
src/tasks.ts       load + validate tasks/*.json
src/pricing.ts     list prices per bare model id; a run's cost from its four counters
src/report.ts      results → report.md
src/bench.ts       the CLI: cells, --dry, results/<timestamp>/, the first-request credential probe
tasks/*.json       the thirteen tasks
test/*.test.ts     vitest: tasks validate; deterministic bootstrap; the loop end to end
                   against the real omg mcp with the scripted model (no API spend);
                   the hook fires; the report renders; bench writes its files
```

Gates: `pnpm --filter agent-bench test`, `lint`, `typecheck`, `pnpm bench --dry`.
Sources are TypeScript run directly by Node's type stripping (Node ≥ 22.18;
`erasableSyntaxOnly`), no build step.
