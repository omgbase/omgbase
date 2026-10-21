// The two check kinds a retrieval task rests on: `answer` over the final text
// (pure) and `unchanged_all` over the vault and the commit log (through a real
// workspace: a fresh one passes, a disk write and an api write each fail it).
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { checkAnswer, checkUnchangedAll, mentions, runChecks } from "../src/checks.ts";
import { OmgServer } from "../src/mcp.ts";
import { answerRegex, validateTask } from "../src/tasks.ts";
import type { Task } from "../src/types.ts";
import { createWorkspace, type Workspace } from "../src/workspace.ts";

const made: Workspace[] = [];
const spawned: OmgServer[] = [];
afterAll(async () => {
  for (const s of spawned) await s.close();
  for (const w of made) w.cleanup();
});

describe("the answer check", () => {
  it("an entry is a case-insensitive substring, or a regex when written /…/ (flags is)", () => {
    expect(mentions("Jabir ibn Hayyan and Paracelsus", "paracelsus")).toBe(true);
    expect(mentions("Jabir ibn Hayyan and Paracelsus", "newton")).toBe(false);
    expect(mentions("a\nthen b", "/a[\\s\\S]*b/")).toBe(true);
    expect(mentions("b then a", "/a[\\s\\S]*b/")).toBe(false);
    expect(mentions("Mara Lindqvist", "/\\bmara lind\\b/")).toBe(false);
    expect(mentions("Mara Lind owns it", "/\\bmara lind\\b/")).toBe(true);
    expect(answerRegex("plain")).toBeNull();
    expect(answerRegex("/x/")).toBeInstanceOf(RegExp);
    expect(answerRegex("/a/b/")!.test("xa/by")).toBe(true); // a path-like entry wrapped in slashes is still a regex: wrap only what you mean
  });

  it("must_mention, must_not_mention and count, with the answer quoted on failure", () => {
    const text = "Open per project: delta 5, fjord 4, cirrus 3, aurora 2, basalt 1, ember 0. Delta has the most.";
    expect(checkAnswer({ kind: "answer", must_mention: ["delta 5", "/(ember[\\s\\S]{0,40}\\b0\\b)/", "/most[\\s\\S]{0,80}delta|delta[\\s\\S]{0,80}most/"] }, text)).toEqual([]);
    expect(checkAnswer({ kind: "answer", must_mention: ["delta 5"], must_not_mention: ["ember"] }, text)).toEqual([
      'answer mentions the decoy "ember"',
      `answer was: ${text}`,
    ]);
    expect(checkAnswer({ kind: "answer", must_mention: ["delta 6"] }, text)).toEqual(['answer does not mention "delta 6"', `answer was: ${text}`]);
    expect(checkAnswer({ kind: "answer", must_mention: ["delta"], count: { pattern: "\\b\\d\\b", equals: 6 } }, text)).toEqual([]);
    expect(checkAnswer({ kind: "answer", must_mention: ["delta"], count: { pattern: "\\b\\d\\b", equals: 5 } }, text)).toEqual([
      "answer matches /\\b\\d\\b/ 6 time(s) ≠ 5",
      `answer was: ${text}`,
    ]);
    expect(checkAnswer({ kind: "answer", must_mention: ["x"] }, "")).toEqual(['answer does not mention "x"', "answer was: "]);
  });

  it("validates: a non-empty must_mention, compiling regex entries, a well-formed count", () => {
    const base = { id: "t", prompt: "p", solution: { steps: [], final_text: "x" }, solution_fs: { steps: [], final_text: "x" } };
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"], must_not_mention: ["/b/"], count: { pattern: "c", equals: 1 } }] }, "x")).toEqual([]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: [] }] }, "x")).toEqual(["x.checks[0]: must_mention must be a non-empty array of strings"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["/(/"] }] }, "x")[0]).toMatch(/does not compile/);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"], count: { pattern: "(", equals: -1 } }] }, "x")).toEqual([
      "x.checks[0]: count.pattern must be a regex string",
      "x.checks[0]: count.equals must be a non-negative integer",
    ]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"], extra: 1 }] }, "x")).toEqual(["x.checks[0]: unknown member `extra` on a answer check"]);
    // the task-level members
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"] }], corpus: "timeline", requires: ["semantic"], unchanged_all: true }, "x")).toEqual([]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"] }], corpus: "nope" }, "x")).toEqual(["x: corpus must be one of alchemy, timeline"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"] }], requires: ["telepathy"] }, "x")).toEqual(["x: unknown requirement `telepathy` (known: semantic)"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"] }], unchanged_all: "yes" }, "x")).toEqual(["x: unchanged_all must be a boolean"]);
  });
});

describe("unchanged_all", () => {
  async function fresh(): Promise<{ ws: Workspace; server: OmgServer }> {
    const ws = createWorkspace();
    made.push(ws);
    const server = await OmgServer.spawn({ workspace: ws, profile: "full" });
    spawned.push(server);
    return { ws, server };
  }

  it("passes on a fresh workspace, fails on a disk write (naming the file) and on an api write (naming the commit)", async () => {
    const { ws, server } = await fresh();
    expect(await checkUnchangedAll({ server, finalText: "", workspace: ws })).toEqual([]);
    expect(await checkUnchangedAll({ server, finalText: "" })).toEqual(["unchanged_all needs the run's workspace"]);
  }, 60_000);

  it("a disk write is a vault difference; an api write is an api commit", async () => {
    const { ws, server } = await fresh();
    writeFileSync(ws.file("/substances/salt.md"), "# Salt\n");
    const disk = await checkUnchangedAll({ server, finalText: "", workspace: ws });
    expect(disk).toEqual(["the vault differs from the alchemy corpus in 1 file(s): /substances/salt.md"]);

    const other = await fresh();
    const r = await other.server.call("apply", { effects: [{ op: "set", target: { kind: "document", _path: "/substances/mercury.md" }, field: "_frontmatter.verified", value: false }] });
    expect(r.ok).toBe(true);
    const api = await checkUnchangedAll({ server: other.server, finalText: "", workspace: other.ws });
    expect(api.some((f) => /1 api commit\(s\) were made \(.*\) touching \/substances\/mercury\.md/.test(f))).toBe(true);

    // through runChecks: a task with `unchanged_all` adds it after its own checks
    const task: Task = { id: "t", prompt: "p", unchanged_all: true, checks: [{ kind: "answer", must_mention: ["ok"] }], solution: { steps: [], final_text: "" }, solution_fs: { steps: [], final_text: "" } };
    expect(await runChecks(task, { server: other.server, finalText: "ok", workspace: other.ws })).toEqual(api);
    expect(await runChecks(task, { server, finalText: "ok", workspace: ws })).toEqual(disk);
  }, 60_000);
});
