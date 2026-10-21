// The two check kinds a retrieval task rests on: `answer` over the final text
// (pure: the ```answer block parsed and scored as an exact set or sequence, path
// forms normalized, the lenient mode the rescore uses) and `unchanged_all` over the
// vault and the commit log (through a real workspace: a fresh one passes, a disk
// write and an api write each fail it).
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { answerBlock, blockPaths, checkAnswer, checkFinalText, checkUnchangedAll, isTextOnlyFailure, mentions, normalizePath, runChecks } from "../src/checks.ts";
import { OmgServer } from "../src/mcp.ts";
import { answerRegex, validateTask } from "../src/tasks.ts";
import type { AnswerCheck, Task } from "../src/types.ts";
import { createWorkspace, type Workspace } from "../src/workspace.ts";

const made: Workspace[] = [];
const spawned: OmgServer[] = [];
afterAll(async () => {
  for (const s of spawned) await s.close();
  for (const w of made) w.cleanup();
});

describe("the answer check", () => {
  it("mentions: a case-insensitive substring (a rooted path in either form), or a regex when written /…/ (flags is)", () => {
    expect(mentions("Jabir ibn Hayyan and Paracelsus", "paracelsus")).toBe(true);
    expect(mentions("Jabir ibn Hayyan and Paracelsus", "newton")).toBe(false);
    expect(mentions("see `practitioners/paracelsus.md`", "/practitioners/paracelsus.md")).toBe(true); // the fs tools print no leading slash
    expect(mentions("see /practitioners/paracelsus.md", "/practitioners/paracelsus.md")).toBe(true);
    expect(mentions("a\nthen b", "/a[\\s\\S]*b/")).toBe(true);
    expect(mentions("b then a", "/a[\\s\\S]*b/")).toBe(false);
    expect(mentions("Mara Lindqvist", "/\\bmara lind\\b/")).toBe(false);
    expect(answerRegex("plain")).toBeNull();
    expect(answerRegex("/x/")).toBeInstanceOf(RegExp);
    expect(answerRegex("/a/b/")!.test("xa/by")).toBe(true); // a path-like entry wrapped in slashes is still a regex: wrap only what you mean
  });

  it("normalizes a path the way a model may write it, and parses the LAST ```answer block, one path per line, markers and blanks dropped", () => {
    expect(normalizePath("practitioners/x.md")).toBe("/practitioners/x.md");
    expect(normalizePath("  `/practitioners/x.md` ")).toBe("/practitioners/x.md");
    expect(normalizePath("//a/b.md")).toBe("/a/b.md");
    expect(answerBlock("no block here")).toBeNull();
    expect(answerBlock("```answer\n/a.md\n```")).toBe("/a.md");
    expect(answerBlock("text\n\n```answer\n/a.md\n/b.md\n```\n")).toBe("/a.md\n/b.md");
    expect(answerBlock("first\n```answer\n/x.md\n```\nthen\n```answer\n/y.md\n```")).toBe("/y.md");
    expect(answerBlock("```answer\n```")).toBe(""); // an empty block is a block
    expect(answerBlock("```json\n{}\n```")).toBeNull(); // another tag is not the answer
    expect(answerBlock("~~~answer\n/a.md\n~~~")).toBe("/a.md");
    expect(blockPaths("- `a/b.md`\n\n1. /c/d.md\n/c/d.md\n* e.md")).toEqual(["/a/b.md", "/c/d.md", "/e.md"]);
  });

  const two: AnswerCheck = { kind: "answer", paths: ["/practitioners/jabir-ibn-hayyan.md", "/practitioners/paracelsus.md"], must_mention: ["jabir", "paracelsus"] };
  const good = "Jabir (era 800) and Paracelsus (1530) qualify; Maria Prophetissa (250) and Newton (1680) fall outside.\n\n```answer\npractitioners/jabir-ibn-hayyan.md\n/practitioners/paracelsus.md\n```";

  it("strict: scores ONLY the block as an exact set, a leading slash optional; decoys in the prose are free, decoys in the block are not", () => {
    expect(checkAnswer(two, good)).toEqual([]);
    const decoyInBlock = good.replace("```answer\n", "```answer\n/practitioners/isaac-newton.md\n");
    expect(checkAnswer(two, decoyInBlock)).toEqual(["answer block lists 1 path(s) that do not belong: /practitioners/isaac-newton.md", `answer was: ${decoyInBlock}`]);
    const short = good.replace("/practitioners/paracelsus.md\n", "");
    expect(checkAnswer(two, short)).toEqual(["answer block is missing /practitioners/paracelsus.md", `answer was: ${short}`]);
    const noBlock = "Jabir (/practitioners/jabir-ibn-hayyan.md) and Paracelsus (/practitioners/paracelsus.md).";
    expect(checkAnswer(two, noBlock)).toEqual(["answer: no ```answer block in the final text (the prompt asks for one listing the matching paths, one per line)", `answer was: ${noBlock}`]);
    expect(checkAnswer(two, "")).toEqual(["answer: no ```answer block in the final text (the prompt asks for one listing the matching paths, one per line)", 'answer does not mention "jabir"', 'answer does not mention "paracelsus"', "answer was: "]);
    // must_mention over the whole text still applies (entries the block's paths do not already spell)
    const nameless = "Two qualify.\n\n```answer\n/practitioners/jabir-ibn-hayyan.md\n/practitioners/paracelsus.md\n```";
    expect(checkAnswer({ ...two, must_mention: ["Jabir ibn Hayyan", "era 1530"] }, nameless)).toEqual(['answer does not mention "Jabir ibn Hayyan"', 'answer does not mention "era 1530"', `answer was: ${nameless}`]);
    expect(checkAnswer({ ...two, must_mention: ["Jabir ibn Hayyan", "era 1530"] }, `Jabir ibn Hayyan (era 800), Paracelsus (era 1530).\n${nameless}`)).toEqual([]);
  });

  it("ordered: the block must list the paths in that order; a set check accepts any order", () => {
    const ordered: AnswerCheck = { kind: "answer", paths: ["/a.md", "/b.md", "/c.md"], ordered: true };
    const set: AnswerCheck = { kind: "answer", paths: ["/a.md", "/b.md", "/c.md"] };
    const inOrder = "```answer\n/a.md\n/b.md\n/c.md\n```";
    const swapped = "```answer\n/b.md\n/a.md\n/c.md\n```";
    expect(checkAnswer(ordered, inOrder)).toEqual([]);
    expect(checkAnswer(ordered, swapped)).toEqual(["answer block order differs: got /b.md, /a.md, /c.md; expected /a.md, /b.md, /c.md", `answer was: ${swapped}`]);
    expect(checkAnswer(set, swapped)).toEqual([]);
    // a missing path is reported as missing, not as an order problem
    expect(checkAnswer(ordered, "```answer\n/c.md\n/a.md\n```")[0]).toBe("answer block is missing /b.md");
  });

  it("lenient (the rescore of a run that predates the block): must_mention alone when the check has one; else every path anywhere in the text, either form, extras free, order on first occurrences", () => {
    const prose = "| Jabir | `practitioners/jabir-ibn-hayyan.md` |\n| Paracelsus | `practitioners/paracelsus.md` |\nMaria and Newton fall outside.";
    expect(checkAnswer(two, prose)).toHaveLength(2); // strict: no block
    expect(checkAnswer(two, prose, "lenient")).toEqual([]);
    expect(checkAnswer({ ...two, mode: "lenient" }, prose)).toEqual([]);
    expect(checkAnswer({ ...two, mode: "lenient" }, prose, "strict")).toHaveLength(2); // the argument overrides the check's mode
    // with must_mention the legacy verdict is the prose facts — the titles of a numbered list, say — even when the text names no path
    expect(checkAnswer({ kind: "answer", paths: ["/projects/aurora/kickoff.md"], ordered: true, must_mention: ["/kickoff[\\s\\S]*closeout/"] }, "1. Aurora kickoff\n2. Aurora closeout", "lenient")).toEqual([]);
    // without must_mention the paths carry it
    const one: AnswerCheck = { kind: "answer", paths: ["/lab/2026-02-notes.md"] };
    expect(checkAnswer(one, "The note is lab/2026-02-notes.md, not lab/2026-01-notes.md.", "lenient")).toEqual([]);
    expect(checkAnswer(one, "The note is lab/2026-01-notes.md.", "lenient")).toEqual(["answer (lenient) does not mention /lab/2026-02-notes.md", "answer was: The note is lab/2026-01-notes.md."]);
    const ordered: AnswerCheck = { kind: "answer", paths: ["/a/x.md", "/a/y.md"], ordered: true };
    expect(checkAnswer(ordered, "first a/x.md then /a/y.md", "lenient")).toEqual([]);
    expect(checkAnswer(ordered, "first /a/y.md then /a/x.md", "lenient")).toEqual(["answer (lenient) names the paths out of order: /a/x.md, /a/y.md expected in that order", "answer was: first /a/y.md then /a/x.md"]);
  });

  it("isTextOnlyFailure tells the rescore which stored failures to drop; checkFinalText is the final_text check", () => {
    expect(isTextOnlyFailure("answer block is missing /a.md")).toBe(true);
    expect(isTextOnlyFailure("answer does not mention \"x\"")).toBe(true);
    expect(isTextOnlyFailure("answer: no ```answer block in the final text")).toBe(true);
    expect(isTextOnlyFailure("answer was: …")).toBe(true);
    expect(isTextOnlyFailure("answer mentions the decoy \"maria\"")).toBe(true); // the old check's message
    expect(isTextOnlyFailure("final text does not match /x/: y")).toBe(true);
    expect(isTextOnlyFailure("/index.md: does not match /x/")).toBe(false);
    expect(isTextOnlyFailure("the vault differs from the timeline corpus in 1 file(s): /index.md")).toBe(false);
    expect(isTextOnlyFailure("harness: boom")).toBe(false);
    expect(checkFinalText({ kind: "final_text", matches: "no change" }, "No change was needed.")).toEqual([]);
    expect(checkFinalText({ kind: "final_text", matches: "no change" }, "done")).toEqual(["final text does not match /no change/: done"]);
  });

  it("validates: paths and/or must_mention, rooted .md paths without repeats, ordered needs paths, mode is not a task's to set", () => {
    const base = { id: "t", prompt: "p", solution: { steps: [], final_text: "x" }, solution_fs: { steps: [], final_text: "x" } };
    expect(validateTask({ ...base, checks: [{ kind: "answer", paths: ["/a.md"], ordered: true, must_mention: ["/b/"] }] }, "x")).toEqual([]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"] }] }, "x")).toEqual([]);
    expect(validateTask({ ...base, checks: [{ kind: "answer" }] }, "x")).toEqual(["x.checks[0]: an answer check needs `paths` and/or `must_mention`"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", paths: [] }] }, "x")).toEqual(["x.checks[0]: paths must be a non-empty array of strings"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", paths: ["a.md", "/a.md", "/a.md"] }] }, "x")).toEqual([
      "x.checks[0]: paths entry \"a.md\" must be a repository-root `.md` path (`/a/b.md`)",
      "x.checks[0]: paths must not repeat",
    ]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["a"], ordered: true }] }, "x")).toEqual(["x.checks[0]: ordered needs paths"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", paths: ["/a.md"], mode: "lenient" }] }, "x")).toEqual(["x.checks[0]: mode is set by the rescore, not by a task file"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: [] }] }, "x")).toEqual(["x.checks[0]: must_mention must be a non-empty array of strings"]);
    expect(validateTask({ ...base, checks: [{ kind: "answer", must_mention: ["/(/"] }] }, "x")[0]).toMatch(/does not compile/);
    expect(validateTask({ ...base, checks: [{ kind: "answer", paths: ["/a.md"], must_not_mention: ["b"] }] }, "x")).toEqual(["x.checks[0]: unknown member `must_not_mention` on a answer check"]);
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
