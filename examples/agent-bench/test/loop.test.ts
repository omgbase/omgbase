// The agent loop end to end against the real `omg mcp`, driven by the scripted
// model: no API spend, the real tool results, the real hook.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runAgent, SYSTEM_PROMPT } from "../src/agent.ts";
import { runChecks } from "../src/checks.ts";
import { OmgServer } from "../src/mcp.ts";
import { ScriptedModel, substitute } from "../src/model.ts";
import { loadTasks } from "../src/tasks.ts";
import type { Task, TranscriptEvent } from "../src/types.ts";
import { createWorkspace, type Workspace } from "../src/workspace.ts";

const { tasks, problems } = loadTasks();
if (problems.length > 0) throw new Error(problems.join("\n"));
const task = (id: string): Task => tasks.find((t) => t.id === id)!;

const made: Workspace[] = [];
const spawned: OmgServer[] = [];
afterAll(async () => {
  for (const s of spawned) await s.close();
  for (const w of made) w.cleanup();
});

async function drive(t: Task, maxTurns = 10) {
  const workspace = createWorkspace();
  made.push(workspace);
  const server = await OmgServer.spawn({ workspace, profile: "full" });
  spawned.push(server);
  const tools = await server.tools();
  const model = new ScriptedModel(t.solution);
  const events: TranscriptEvent[] = [];
  const loop = await runAgent({ task: t, model, server, workspace, tools, maxTurns, onEvent: (e) => events.push(e) });
  const failures = await runChecks(t, { server, finalText: loop.metrics.final_text });
  return { workspace, server, loop, events, failures };
}

describe("the agent loop", () => {
  it("drives a one-call write to its end state and counts it", async () => {
    const { loop, events, failures } = await drive(task("frontmatter-edit"));
    expect(failures).toEqual([]);
    const m = loop.metrics;
    expect(m).toMatchObject({ turns: 2, tool_calls: 1, failed_calls: 0, write_calls: 1, plan_calls: 0, execute_calls: 0, plan_before_write: false, hit_turn_cap: false, hook_fired: false });
    expect(m.calls_by_tool).toEqual({ apply: 1 });
    expect(m.final_text).toBe("Set verified: true on /substances/philosophers-stone.md.");
    expect(events.map((e) => e.type)).toEqual(["assistant", "tool_call", "tool_result", "assistant", "end"]);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result).toMatchObject({ tool: "apply", ok: true, result: { committed: true } });
    // the conversation the model saw: prompt, assistant tool_use, tool_result, final assistant
    expect(loop.messages.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(SYSTEM_PROMPT).toMatch(/^You are operating an omgbase knowledge base through MCP tools\./);
  });

  it("the stale-plan hook fires after the first plan; the stale execute fails sync_conflict; the retry lands", async () => {
    const { workspace, loop, events, failures } = await drive(task("stale-plan-retry"));
    expect(failures).toEqual([]);
    const m = loop.metrics;
    expect(m).toMatchObject({ turns: 5, tool_calls: 4, failed_calls: 1, plan_calls: 2, execute_calls: 2, write_calls: 2, plan_before_write: true, hook_fired: true });
    expect(m.failed_by_code).toEqual({ sync_conflict: 1 });
    const kinds = events.map((e) => (e.type === "tool_result" ? `${e.tool}:${e.ok ? "ok" : e.error_code}` : e.type));
    expect(kinds).toEqual([
      "assistant", "tool_call", "plan:ok", "hook",
      "assistant", "tool_call", "execute:sync_conflict",
      "assistant", "tool_call", "plan:ok",
      "assistant", "tool_call", "execute:ok",
      "assistant", "end",
    ]);
    expect(events.find((e) => e.type === "hook")).toMatchObject({ when: "after_plan", turn: 1 });
    // the disk edit is in the file, before the model's paragraph
    const raw = readFileSync(workspace.file("timeline/review.md"), "utf8");
    expect(raw).toMatch(/alum order.*\n\n?Decisions deferred to spring/s);
  });

  it("when the model never plans, the hook fires before its first write instead", async () => {
    const t = task("stale-plan-retry");
    const direct: Task = {
      ...t,
      solution: {
        steps: [
          { tool: "docs_append", args: { path: "/timeline/review.md", text: "Decisions deferred to spring are tracked in the March notes." }, expect_error: "sync_conflict" },
          { tool: "docs_append", args: { path: "/timeline/review.md", text: "Decisions deferred to spring are tracked in the March notes." } },
        ],
        final_text: "appended after a retry",
      },
    };
    const { loop, events, failures } = await drive(direct);
    expect(failures).toEqual([]);
    expect(loop.metrics).toMatchObject({ plan_calls: 0, plan_before_write: false, hook_fired: true, failed_calls: 1 });
    expect(loop.metrics.failed_by_code).toEqual({ sync_conflict: 1 });
    expect(events.find((e) => e.type === "hook")).toMatchObject({ when: "before_write", turn: 1 });
    const order = events.filter((e) => e.type === "hook" || e.type === "tool_result").map((e) => e.type);
    expect(order[0]).toBe("hook");
  });

  it("the contradiction: the planner refuses, nothing is written, the final text reports the conflict", async () => {
    const { loop, failures } = await drive(task("contradiction"));
    expect(failures).toEqual([]);
    expect(loop.metrics.failed_by_code).toEqual({ conflicting_effects: 1 });
    expect(loop.metrics.write_calls).toBe(0);
  });

  it("the no-op: a read, no write, the document untouched", async () => {
    const { loop, failures } = await drive(task("noop"));
    expect(failures).toEqual([]);
    expect(loop.metrics).toMatchObject({ tool_calls: 1, write_calls: 0, plan_before_write: null });
  });

  it("a check fails when the end state is wrong, naming what differs", async () => {
    const t = task("frontmatter-edit");
    const wrong: Task = { ...t, solution: { steps: [{ tool: "docs_read", args: { path: "/index.md" } }], final_text: "did nothing" } };
    const { failures } = await drive(wrong);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatch(/hit 0\.verified = false ≠ true/);
  });

  it("the turn cap ends a run that keeps calling tools", async () => {
    const t = task("noop");
    const chatty: Task = { ...t, solution: { steps: Array.from({ length: 6 }, () => ({ tool: "version", args: {} })), final_text: "never reached" } };
    const { loop } = await drive(chatty, 3);
    expect(loop.metrics).toMatchObject({ turns: 3, tool_calls: 3, hit_turn_cap: true, final_text: "" });
  });
});

describe("substitute", () => {
  it("replaces $result placeholders, with and without $get, anywhere in the args", () => {
    const results = [{ plan_id: "p1", hits: [{ id: "b_1" }] }, "text"];
    expect(substitute({ plan: { $result: 0 }, at: { after: { $result: 0, $get: "hits.0.id" } }, s: { $result: 1 }, list: [{ $result: 0, $get: "plan_id" }] }, results))
      .toEqual({ plan: results[0], at: { after: "b_1" }, s: "text", list: ["p1"] });
    expect(() => substitute({ $result: 3 }, results)).toThrow(/has not run/);
  });
});
