import { describe, expect, it } from "vitest";
import { OmgError, type DocsReadResult, type Receipt } from "./client.js";
import type { CommandClient, CommandContext } from "./commands.js";
import { CREATE_REASON, REMOVE_CREATED_REASON, createDocumentCommand, creationError, defaultMarkdown, pathStem, rootedPath, titleFromPath } from "./commands-documents.js";

describe("paths and titles", () => {
  it("rootedPath: one leading slash, runs collapsed, idempotent", () => {
    expect(rootedPath("a/b.md")).toBe("/a/b.md");
    expect(rootedPath("/a/b.md")).toBe("/a/b.md");
    expect(rootedPath("//a//b.md")).toBe("/a/b.md");
    expect(rootedPath(rootedPath("///x.md"))).toBe("/x.md");
  });
  it("pathStem drops the directory and a letter-led extension only", () => {
    expect(pathStem("/a/b.md")).toBe("b");
    expect(pathStem("notes/v1.2")).toBe("v1.2");
    expect(pathStem("/a/salt.markdown")).toBe("salt");
  });
  it("titles from the file name: hyphens and underscores become spaces, the first letter capitalised", () => {
    expect(titleFromPath("/notes/dry-run_notes.md")).toBe("Dry run notes");
    expect(titleFromPath("/a/salt.md")).toBe("Salt");
    expect(titleFromPath("/a/-.md")).toBe("Untitled");
    expect(defaultMarkdown("/notes/dry-run.md")).toBe("# Dry run\n");
  });
  it("a given title wins; a blank one does not", () => {
    expect(defaultMarkdown("/a/salt.md", "Sal ammoniac")).toBe("# Sal ammoniac\n");
    expect(defaultMarkdown("/a/salt.md", "  ")).toBe("# Salt\n");
  });
});

// ---- a fake client ---------------------------------------------------------------------

type Call = { tool: string; args: unknown };

/** The two methods the command touches, over a one-document world: `doc` holds the live document (null = gone). */
class FakeClient {
  calls: Call[] = [];
  doc: DocsReadResult | null = null;
  /** What `apply` answers (or throws). */
  applyResult: Receipt | Error = {
    plan_id: "p1", commit: "c_1", revisions: [{ _id: "d_new", _path: "/notes/x.md", _hash: "h1" }], new_ids: { "$new.0": "d_new" }, committed: true, summary: ["create /notes/x.md"],
  };

  async apply(req: unknown): Promise<Receipt> {
    this.calls.push({ tool: "apply", args: req });
    if (this.applyResult instanceof Error) throw this.applyResult;
    // The server composed the file: body with its trailing newline.
    this.doc = { _id: "d_new", _path: "/notes/x.md", rev: "r_1", properties: { frontmatter: {}, inline: {}, computed: {} }, _raw: "# X\n" };
    return this.applyResult;
  }

  async docsRead(locator: unknown, opts?: unknown): Promise<DocsReadResult> {
    this.calls.push({ tool: "docs_read", args: { locator, opts } });
    if (this.doc === null) throw new OmgError("doc_missing", "no document at /notes/x.md", { data: { doc: "/notes/x.md" }, tool: "docs_read" });
    return this.doc;
  }

  ctx(): CommandContext {
    return { client: this as unknown as CommandClient };
  }
}

describe("createDocumentCommand", () => {
  it("apply sends exactly one `apply` with the create effect, then one docs_read, and records the bytes and rev", async () => {
    const c = new FakeClient();
    const cmd = createDocumentCommand({ path: "notes/x.md", markdown: "# X\n", repo: "alchemy" });
    expect(cmd.kind).toBe("repository");
    expect(cmd.label).toBe("create /notes/x.md");
    const applied = await cmd.apply(c.ctx(), { redo: false, previous: null });
    expect(c.calls.map((x) => x.tool)).toEqual(["apply", "docs_read"]);
    expect(c.calls[0]!.args).toEqual({ effects: [{ op: "create", path: "/notes/x.md", markdown: "# X\n" }], reason: CREATE_REASON, repo: "alchemy" });
    expect(c.calls[1]!.args).toEqual({ locator: { _path: "/notes/x.md" }, opts: { repo: "alchemy" } });
    expect(applied.receipts).toHaveLength(1);
    expect(applied.revisions).toEqual([{ _id: "d_new", _path: "/notes/x.md", _hash: "h1" }]);
    expect(applied.state).toEqual({ raw: "# X\n", rev: "r_1" });
  });
  it("the default body is the title heading; frontmatter rides along in the effect", async () => {
    const c = new FakeClient();
    const cmd = createDocumentCommand({ path: "/notes/dry-run.md", frontmatter: { layer: "notes" } });
    await cmd.apply(c.ctx(), { redo: false, previous: null });
    expect((c.calls[0]!.args as { effects: unknown[] }).effects).toEqual([{ op: "create", path: "/notes/dry-run.md", markdown: "# Dry run\n", frontmatter: { layer: "notes" } }]);
    expect((c.calls[0]!.args as { repo?: unknown }).repo).toBeUndefined();
  });
  it("a failed apply reads nothing", async () => {
    const c = new FakeClient();
    c.applyResult = new OmgError("path_taken", "a document exists at notes/x.md", { tool: "apply" });
    const cmd = createDocumentCommand({ path: "/notes/x.md" });
    await expect(cmd.apply(c.ctx(), { redo: false, previous: null })).rejects.toMatchObject({ code: "path_taken" });
    expect(c.calls.map((x) => x.tool)).toEqual(["apply"]);
  });
  it("compensate re-reads and yields removeDocument when the bytes are the ones creation produced", async () => {
    const c = new FakeClient();
    const cmd = createDocumentCommand({ path: "/notes/x.md", markdown: "# X\n", repo: "alchemy" });
    const applied = await cmd.apply(c.ctx(), { redo: false, previous: null });
    c.calls = [];
    const comp = await cmd.compensate(c.ctx(), applied);
    expect(comp).toEqual({ effects: [{ op: "remove", target: { kind: "document", _path: "/notes/x.md" } }], reason: REMOVE_CREATED_REASON });
    expect(c.calls).toEqual([{ tool: "docs_read", args: { locator: { _path: "/notes/x.md" }, opts: { repo: "alchemy" } } }]);
  });
  it("compensate refuses when the document is gone", async () => {
    const c = new FakeClient();
    const cmd = createDocumentCommand({ path: "/notes/x.md", markdown: "# X\n" });
    const applied = await cmd.apply(c.ctx(), { redo: false, previous: null });
    c.doc = null;
    expect(await cmd.compensate(c.ctx(), applied)).toEqual({ refused: "/notes/x.md no longer exists" });
  });
  it("compensate refuses when the bytes changed since", async () => {
    const c = new FakeClient();
    const cmd = createDocumentCommand({ path: "/notes/x.md", markdown: "# X\n" });
    const applied = await cmd.apply(c.ctx(), { redo: false, previous: null });
    c.doc = { ...c.doc!, _raw: "# X\n\nsomeone wrote here\n", rev: "r_2" };
    const comp = await cmd.compensate(c.ctx(), applied);
    expect("refused" in comp && comp.refused).toMatch(/edited since it was created \(rev r_2, expected r_1\)/);
  });
  it("compensate lets any other read error through", async () => {
    const c = new FakeClient();
    const cmd = createDocumentCommand({ path: "/notes/x.md", markdown: "# X\n" });
    const applied = await cmd.apply(c.ctx(), { redo: false, previous: null });
    c.docsRead = async () => { throw new Error("network down"); };
    await expect(cmd.compensate(c.ctx(), applied)).rejects.toThrow("network down");
  });
});

describe("creationError", () => {
  it("reads the codes a create can hit", () => {
    expect(creationError(new OmgError("path_taken", "x", { tool: "apply" }), "/a.md")).toBe("a document (or a file) already exists at /a.md");
    expect(creationError(new OmgError("path_taken", "x", { tool: "apply" }))).toBe("a document (or a file) already exists");
    expect(creationError(new OmgError("filter_invalid", "`path` must be a string", { tool: "apply" }))).toBe("the create request was malformed: `path` must be a string");
    expect(creationError(new OmgError("unknown_tool", "x", { tool: "apply" }))).toMatch(/does not offer `apply`/);
    expect(creationError(new OmgError("repo_not_found", "no repo zzz", { tool: "apply" }))).toBe("the repository is not on this server: no repo zzz");
    expect(creationError(new OmgError("conflicted_document", "x", { tool: "apply" }), "/a.md")).toMatch(/sync conflict/);
    expect(creationError(new OmgError("stale_plan", "moved on", { tool: "apply" }))).toBe("stale_plan: moved on");
  });
  it("any other error is its message", () => {
    expect(creationError(new Error("network down"))).toBe("network down");
    expect(creationError("odd")).toBe("odd");
  });
});
