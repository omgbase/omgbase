// The filesystem baseline: FsServer's seven tools over a copy of the corpus (path
// safety, the exact-match edit rule, the grep cap, move/delete), the write/read
// split the metrics rest on, and the `fs` profile end to end — the scripted
// solution through the real loop, the hook firing before the first write, the
// sweep, the omgbase checks — with no API spend.
import { afterAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_SYSTEM_PROMPT, SYSTEM_PROMPT, runAgent, systemPromptFor } from "../src/agent.ts";
import { dryRun, openAgentServer, openCheckServer, solutionFor } from "../src/bench.ts";
import { runChecks } from "../src/checks.ts";
import { FS_TOOL_NAMES, FsServer, GREP_CAP, globToRegExp } from "../src/fs-server.ts";
import { ScriptedModel } from "../src/model.ts";
import { loadTasks } from "../src/tasks.ts";
import { FS_PROFILE, isFsProfile, isWriteTool, type Task, type TranscriptEvent } from "../src/types.ts";
import { ALCHEMY_DIR, createWorkspace, fixtureBytes, type Workspace } from "../src/workspace.ts";

const { tasks, problems } = loadTasks();
if (problems.length > 0) throw new Error(problems.join("\n"));
const task = (id: string): Task => tasks.find((t) => t.id === id)!;

const roots: string[] = [];
const made: Workspace[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  for (const w of made) w.cleanup();
});

/** A throwaway copy of the corpus with an FsServer over it (no omg involved). */
function vault(): { root: string; fs: FsServer } {
  const root = mkdtempSync(join(tmpdir(), "agent-bench-vault-"));
  roots.push(root);
  cpSync(ALCHEMY_DIR, root, { recursive: true });
  return { root, fs: new FsServer(root) };
}

describe("FsServer", () => {
  it("serves the seven generic tools, in order, each with an object schema and no omgbase vocabulary", async () => {
    const { fs } = vault();
    const tools = await fs.tools();
    expect(tools.map((t) => t.name)).toEqual(["list_files", "read_file", "write_file", "edit_file", "grep", "move_file", "delete_file"]);
    expect(FS_TOOL_NAMES).toEqual(tools.map((t) => t.name));
    for (const t of tools) {
      expect(t.input_schema).toMatchObject({ type: "object" });
      expect(t.description).not.toMatch(/omgbase|block|_id|_path|oqx/i);
    }
    expect(fs.profile).toBe(FS_PROFILE);
    expect(isFsProfile("fs")).toBe(true);
    expect(isFsProfile("full")).toBe(false);
  });

  it("resolves vault-relative paths in either form and refuses an escape", async () => {
    const { fs } = vault();
    const rooted = await fs.call("read_file", { path: "/substances/salt.md" });
    const bare = await fs.call("read_file", { path: "substances/salt.md" });
    expect(rooted.ok && bare.ok).toBe(true);
    expect(rooted.result).toEqual({ path: "substances/salt.md", content: fixtureBytes("/substances/salt.md") });
    expect(bare.result).toEqual(rooted.result);
    for (const path of ["../outside.md", "/../../etc/passwd", "substances/../../x.md"]) {
      const r = await fs.call("read_file", { path });
      expect(r.ok).toBe(false);
      expect(r.error_code).toBe("outside_vault");
      expect(r.result).toMatchObject({ error: "outside_vault", message: expect.stringContaining("outside the vault") });
    }
    // a `..` that stays inside is fine
    expect((await fs.call("read_file", { path: "substances/../index.md" })).ok).toBe(true);
    expect((await fs.call("read_file", { path: "/nope.md" })).error_code).toBe("not_found");
    expect((await fs.call("read_file", { path: 7 })).error_code).toBe("invalid_arguments");
    expect((await fs.call("no_such_tool", {})).error_code).toBe("unknown_tool");
    // every result is JSON text, like omg's
    expect(JSON.parse(rooted.text)).toEqual(rooted.result);
  });

  it("list_files: every .md recursively, sorted; a subdirectory; a missing directory", async () => {
    const { fs } = vault();
    const all = await fs.call("list_files", {});
    const files = (all.result as { files: string[] }).files;
    expect(files).toHaveLength(20);
    expect(files).toEqual([...files].sort());
    expect(files[0]).toBe("index.md");
    expect(files).toContain("processes/calcination.md");
    const sub = await fs.call("list_files", { dir: "/processes" });
    expect(sub.result).toEqual({ dir: "processes", files: ["processes/calcination.md", "processes/coagulation.md", "processes/dissolution.md", "processes/magnum-opus.md"] });
    expect((await fs.call("list_files", { dir: "nowhere" })).error_code).toBe("not_found");
  });

  it("edit_file replaces exactly one occurrence and refuses zero or several, leaving the file alone", async () => {
    const { root, fs } = vault();
    const before = readFileSync(join(root, "texts/mutus-liber.md"), "utf8");
    const none = await fs.call("edit_file", { path: "texts/mutus-liber.md", old_string: "not in the file", new_string: "x" });
    expect(none.error_code).toBe("no_match");
    const many = await fs.call("edit_file", { path: "texts/mutus-liber.md", old_string: "- [ ]", new_string: "- [x]" });
    expect(many.error_code).toBe("ambiguous_match");
    expect(many.result).toMatchObject({ error: "ambiguous_match", data: { matches: 3 } });
    expect(readFileSync(join(root, "texts/mutus-liber.md"), "utf8")).toBe(before);
    const empty = await fs.call("edit_file", { path: "texts/mutus-liber.md", old_string: "", new_string: "x" });
    expect(empty.error_code).toBe("invalid_arguments");
    const one = await fs.call("edit_file", { path: "texts/mutus-liber.md", old_string: "- [ ] Obtain a facsimile", new_string: "- [x] Obtain a facsimile" });
    expect(one.ok).toBe(true);
    expect(one.result).toEqual({ path: "texts/mutus-liber.md", replaced: 1 });
    expect(readFileSync(join(root, "texts/mutus-liber.md"), "utf8")).toBe(before.replace("- [ ] Obtain a facsimile", "- [x] Obtain a facsimile"));
  });

  it("grep: path:line: text, a glob, a cap with a truncation note, a bad pattern", async () => {
    const { fs } = vault();
    const r = await fs.call("grep", { pattern: "practitioners/newton\\.md" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ count: 2, truncated: false });
    expect((r.result as { matches: string[] }).matches).toEqual([
      "index.md:44: | [Isaac Newton](/practitioners/newton.md) | Western | 17th century |",
      "texts/emerald-tablet.md:31: [Jabir](/practitioners/jabir-ibn-hayyan.md) to [Newton](/practitioners/newton.md)",
    ]);
    const g = await fs.call("grep", { pattern: "^stage: ", glob: "processes/*.md" });
    expect((g.result as { matches: string[] }).matches).toEqual([
      "processes/calcination.md:8: stage: nigredo",
      "processes/coagulation.md:8: stage: rubedo",
      "processes/dissolution.md:8: stage: nigredo",
    ]);
    const every = await fs.call("grep", { pattern: "" });
    const v = every.result as { matches: string[]; count: number; truncated: boolean; note?: string };
    expect(v.matches).toHaveLength(GREP_CAP);
    expect(v.count).toBeGreaterThan(GREP_CAP);
    expect(v.truncated).toBe(true);
    expect(v.note).toMatch(new RegExp(`cut at ${GREP_CAP} of ${v.count}`));
    expect((await fs.call("grep", { pattern: "(" })).error_code).toBe("invalid_pattern");
  });

  it("globToRegExp: * within a segment, ** across, ? one character", () => {
    expect(globToRegExp("processes/*.md").test("processes/a.md")).toBe(true);
    expect(globToRegExp("processes/*.md").test("processes/x/a.md")).toBe(false);
    expect(globToRegExp("**/index.md").test("index.md")).toBe(true);
    expect(globToRegExp("**/index.md").test("a/b/index.md")).toBe(true);
    expect(globToRegExp("/texts/*.md").test("texts/a.md")).toBe(true);
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
    expect(globToRegExp("a?.md").test("a/.md")).toBe(false);
  });

  it("write_file creates (mkdir -p) or overwrites; move_file renames and refuses a missing source or an existing target; delete_file deletes", async () => {
    const { root, fs } = vault();
    const created = await fs.call("write_file", { path: "/new/dir/note.md", content: "# New\n" });
    expect(created.result).toEqual({ path: "new/dir/note.md", created: true, bytes: 6 });
    expect(readFileSync(join(root, "new/dir/note.md"), "utf8")).toBe("# New\n");
    const over = await fs.call("write_file", { path: "new/dir/note.md", content: "# Newer\n" });
    expect(over.result).toMatchObject({ created: false });
    expect((await fs.call("write_file", { path: "processes", content: "x" })).error_code).toBe("is_directory");

    const moved = await fs.call("move_file", { from: "/practitioners/newton.md", to: "/practitioners/isaac-newton.md" });
    expect(moved.result).toEqual({ from: "practitioners/newton.md", to: "practitioners/isaac-newton.md" });
    expect(existsSync(join(root, "practitioners/newton.md"))).toBe(false);
    expect(readFileSync(join(root, "practitioners/isaac-newton.md"), "utf8")).toBe(fixtureBytes("/practitioners/newton.md"));
    expect((await fs.call("move_file", { from: "/practitioners/newton.md", to: "/x.md" })).error_code).toBe("not_found");
    expect((await fs.call("move_file", { from: "/index.md", to: "/practitioners/isaac-newton.md" })).error_code).toBe("exists");
    expect((await fs.call("move_file", { from: "/index.md", to: "../escaped.md" })).error_code).toBe("outside_vault");

    const deleted = await fs.call("delete_file", { path: "new/dir/note.md" });
    expect(deleted.result).toEqual({ path: "new/dir/note.md", deleted: true });
    expect((await fs.call("read_file", { path: "new/dir/note.md" })).error_code).toBe("not_found");
    expect((await fs.call("delete_file", { path: "new/dir/note.md" })).error_code).toBe("not_found");
  });

  it("the write/read split the metrics use: the four writers write, the three readers do not", () => {
    for (const w of ["write_file", "edit_file", "move_file", "delete_file"]) expect(isWriteTool(w)).toBe(true);
    for (const r of ["list_files", "read_file", "grep"]) expect(isWriteTool(r)).toBe(false);
  });

  it("the system prompts differ only in naming the medium", () => {
    expect(systemPromptFor("fs")).toBe(FS_SYSTEM_PROMPT);
    expect(systemPromptFor("full")).toBe(SYSTEM_PROMPT);
    expect(systemPromptFor("minimal")).toBe(SYSTEM_PROMPT);
    expect(FS_SYSTEM_PROMPT).toMatch(/^You are managing a Markdown knowledge base .* through filesystem tools\. Complete the task; read before you write, and change nothing beyond what the task asks\.$/);
    expect(FS_SYSTEM_PROMPT).not.toMatch(/omgbase|MCP|plan/);
  });
});

describe("the fs profile end to end", () => {
  it("the stale-plan hook fires before the agent's first write; the scripted solution re-reads, the sweep observes the edit, the omgbase checks pass", async () => {
    const t = task("stale-plan-retry");
    const workspace = createWorkspace();
    made.push(workspace);
    const server = await openAgentServer(workspace, "fs");
    expect(server).toBeInstanceOf(FsServer);
    const tools = await server.tools();
    const events: TranscriptEvent[] = [];
    const solution = solutionFor(t, "fs");
    expect(solution).toBe(t.solution_fs);
    const loop = await runAgent({ task: t, model: new ScriptedModel(solution), server, workspace, tools, maxTurns: 10, onEvent: (e) => events.push(e) });
    expect(loop.metrics).toMatchObject({ turns: 5, tool_calls: 4, failed_calls: 0, write_calls: 2, plan_calls: 0, plan_before_write: false, hook_fired: true });
    expect(loop.metrics.calls_by_tool).toEqual({ read_file: 2, edit_file: 2 });
    const kinds = events.map((e) => (e.type === "tool_result" ? `${e.tool}:${e.ok ? "ok" : e.error_code}` : e.type === "hook" ? `hook:${e.when}` : e.type));
    expect(kinds).toEqual([
      "assistant", "tool_call", "read_file:ok",
      "assistant", "tool_call", "hook:before_write", "edit_file:ok",
      "assistant", "tool_call", "read_file:ok",
      "assistant", "tool_call", "edit_file:ok",
      "assistant", "end",
    ]);
    // the disk line sits before the paragraph, at the end of the file
    const raw = readFileSync(workspace.file("timeline/review.md"), "utf8");
    expect(raw).toMatch(/- Who keeps the lab notes in March\?\n- Confirm the alum order before the dissolution trials resume\.\n\nDecisions deferred to spring are tracked in the March notes\.\n$/);
    // the checks go through omgbase: the sweep first, then a full server
    const checker = await openCheckServer(workspace, "fs", server, (e) => events.push(e));
    try {
      const sync = events.find((e) => e.type === "sync");
      expect(sync).toMatchObject({ type: "sync", scanned: 20, ingested: ["/timeline/review.md"], deleted: [], conflicted: [] });
      expect(checker.profile).toBe("full");
      expect(await runChecks(t, { server: checker, finalText: loop.metrics.final_text })).toEqual([]);
      // an agent that wrote the whole file from its first read would have lost the disk line — and the check says so
      const clobbered: Task = { ...t, checks: [{ kind: "read", path: "/timeline/review.md", not_matches: ["Confirm the alum order"] }] };
      expect(await runChecks(clobbered, { server: checker, finalText: "" })).toEqual(["/timeline/review.md: matches /Confirm the alum order/ but must not"]);
    } finally {
      await checker.close();
      await server.close();
    }
  });

  it("dryRun under fs: a move with inbound links and a new document both reach their end state and both negative controls hold", async () => {
    const log: string[] = [];
    const problems = await dryRun([task("doc-move"), task("create-then-section")], ["fs"], (l) => log.push(l));
    expect(problems).toEqual([]);
    expect(log).toEqual([
      "  ok   doc-move [fs] solution: 4 step(s), 0 expected failure(s), swept +3 -1",
      "  ok   doc-move [fs] negative control: 6 failing check(s) on a fresh workspace",
      "  ok   create-then-section [fs] solution: 2 step(s), 0 expected failure(s), swept +1 -0",
      "  ok   create-then-section [fs] negative control: 3 failing check(s) on a fresh workspace",
    ]);
  });
});
