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
export ANTHROPIC_API_KEY=sk-ant-…              # or an `ant auth login` profile — the SDK resolves either
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

The run writes `results/<timestamp>/`:

- `report.md` — the tables (below), rewritten after every cell so an
  interrupted run still has a report;
- `results.json` — `{ meta, results: RunMetrics[] }`, the raw numbers;
- `transcripts/<task>.<profile>.<run>.jsonl` — every event of the run.

No fallback model is configured: a `refusal` stop ends the turn like any other
and is visible in the transcript. A benchmark comparing two tool surfaces must
be answered by one model, so the server-side fallback the SDK offers is
deliberately not enabled.

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

Per model request the full catalog's tool definitions are ~51 k characters
(≈ 13–15 k tokens); the minimal profile's ~9 k characters. Tools and the
system prompt are the stable prefix and are cached (`cache_control` on the
system block), so after the first turn of a cell they come back as cache reads.
A typical run is 3–8 turns; with the conversation growing a few k tokens per
turn, expect roughly:

| | full | minimal |
| --- | --- | --- |
| input tokens per run (incl. cache reads) | 60–150 k | 20–60 k |
| of which uncached | 10–30 k | 5–20 k |
| output tokens per run | 1–4 k | 1–4 k |

At Opus 5 list prices ($5 / $25 per MTok, cache reads at a tenth) a full
13 × 2 × 3 run is on the order of a few dollars. The report prints the exact
token counts per cell; `results.json` has them per run. `--tasks` and `--runs 1`
are the knobs for a cheap smoke run.

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
| `read` | `docs_read { path }`'s raw bytes `equals` a string, match every `matches` regex, match none of `not_matches` |
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
parsed result, `{ "$result": 0, "$get": "hits.0.id" }` a member of it; a step
that is supposed to fail says `"expect_error": "<code>"`.

### Adding a task

1. Write `tasks/<id>.json` with a prompt, checks and a scripted solution that
   reaches the end state using tools of the **minimal** profile (so `--dry`
   is green under both profiles). Under the sequential minter the fixture ids
   are stable, so a solution may name them (`b_153`); when it must discover
   one, use a `query` step and `$result`.
2. `pnpm bench --dry --tasks <id>` — the solution must pass the checks and the
   checks must fail on a fresh workspace.
3. `pnpm test` — `test/tasks.test.ts` pins the task list; extend it.

## Reading the report

```
| task | profile | pass | turns | calls | failed | tokens in / out | wall s | plan→write |
```

- **pass** — runs whose every check passed, over runs (`k/n (p%)`).
- **turns** — mean model requests per run (an assistant turn with tool calls
  plus the final answer; the turn cap is 20).
- **calls** — mean tool calls per run; **failed** — mean calls that returned an
  error envelope or were refused (`unknown_tool` under a profile); the
  per-profile sections list the codes (`filter_invalid`, `sync_conflict`,
  `conflicting_effects`, …) and the tool-call histogram.
- **tokens in / out** — mean input tokens (uncached + cache reads + cache
  writes) and output tokens per run; `results.json` splits them.
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
| `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | summed over the run's requests |
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
src/model.ts       the Model seam: ClaudeModel (SDK) and ScriptedModel (a task's solution)
src/agent.ts       the tool-use loop, the hook, the per-run metrics and events
src/checks.ts      the four check kinds
src/tasks.ts       load + validate tasks/*.json
src/report.ts      results → report.md
src/bench.ts       the CLI: cells, --dry, results/<timestamp>/
tasks/*.json       the thirteen tasks
test/*.test.ts     vitest: tasks validate; deterministic bootstrap; the loop end to end
                   against the real omg mcp with the scripted model (no API spend);
                   the hook fires; the report renders; bench writes its files
```

Gates: `pnpm --filter agent-bench test`, `lint`, `typecheck`, `pnpm bench --dry`.
Sources are TypeScript run directly by Node's type stripping (Node ≥ 22.18;
`erasableSyntaxOnly`), no build step.
