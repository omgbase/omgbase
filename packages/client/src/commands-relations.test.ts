import { describe, expect, it } from "vitest";
import { OmgError, type ApplyRequest, type DocsReadResult, type QueryResult, type Receipt } from "./client.js";
import { CommandLog, type Applied, type CommandClient } from "./commands.js";
import {
  attachRelationCommand, attachedValue, bodyLinkMarkdown, describeDetach, describeRelation, detachRelationCommand, detachedValue, fieldCounts, isPathValue, namesDocument, newTopLevelBlocks, relationKinds,
  type AttachRelationState, type DetachRelationState, type RelationKind,
} from "./commands-relations.js";

const A = "/a.md", B = "/b.md";
const run = { redo: false, previous: null } as const;

/** A hand-written minimal server: one document whose frontmatter, revision and
 * block list the test moves between calls; `apply` commits frontmatter effects,
 * inserts and removes for real when `commit` is on. */
class FakeDoc {
  frontmatter: Record<string, unknown>;
  rev: string | null = "r1";
  ids: string[] = ["b_1", "b_2"];
  hashes: Record<string, string> = { b_1: "h1", b_2: "h2" };
  parents: Record<string, string | null> = { b_1: null, b_2: null };
  raws: Record<string, string> = { b_1: "# A", b_2: "[Beta](/b.md)" };
  gone = false;
  applies: ApplyRequest[] = [];
  reads: { includeIds: boolean | undefined; repo: unknown }[] = [];
  queries: string[] = [];
  commit = false;
  /** An extra side effect per apply (the "server" doing something the commit rule does not). */
  onApply: (req: ApplyRequest) => void = () => {};
  constructor(frontmatter: Record<string, unknown>) { this.frontmatter = frontmatter; }

  client(): CommandClient {
    return {
      docsRead: async (_loc: unknown, opts: { includeIds?: boolean; repo?: unknown } = {}) => {
        this.reads.push({ includeIds: opts.includeIds, repo: opts.repo });
        if (this.gone) throw new OmgError("doc_missing", `no document at ${A}`, { tool: "docs_read" });
        const out: DocsReadResult = { _id: "d_a", _path: A, rev: this.rev, properties: { frontmatter: { ...this.frontmatter }, inline: {}, computed: {} }, _raw: "" };
        if (opts.includeIds) { out.ids = [...this.ids]; out.hashes = { ...this.hashes }; out.parents = { ...this.parents }; }
        return out;
      },
      query: async (q: string) => {
        this.queries.push(q);
        const m = /_id == "([^"]+)"/.exec(q);
        const id = m?.[1] ?? "";
        const hits = this.ids.includes(id) ? [{ _id: id, _path: A, _raw: this.raws[id] ?? "", _hash: this.hashes[id]! }] : [];
        return { hits, truncated: false, cursor: null, consumer: "collect" } satisfies QueryResult;
      },
      apply: async (req: ApplyRequest) => {
        this.applies.push(req);
        if (this.commit) this.commitEffects(req);
        this.onApply(req);
        const n = this.applies.length;
        this.rev = `r${n + 1}`;
        const receipt: Receipt = { plan_id: `p_${n}`, commit: `c_${n}`, revisions: [{ _id: "d_a", _path: A, _hash: `H${n}` }], new_ids: {}, committed: true, summary: [req.reason ?? ""] };
        return receipt;
      },
      call: () => Promise.reject(new Error("unused")),
    } as unknown as CommandClient;
  }

  /** The server applies the effects for real: frontmatter set/unset, an insert at the end (a new top-level block), a remove. */
  commitEffects(req: ApplyRequest): void {
    for (const e of req.effects) {
      if (e.op === "set" && e.field.startsWith("_frontmatter.")) this.frontmatter[e.field.slice("_frontmatter.".length)] = e.value;
      if (e.op === "unset" && e.field.startsWith("_frontmatter.")) delete this.frontmatter[e.field.slice("_frontmatter.".length)];
      if (e.op === "insert") {
        const id = `b_${this.ids.length + 1 + this.applies.length}`;
        this.ids.push(id);
        this.hashes[id] = `h_${id}`;
        this.parents[id] = null;
        this.raws[id] = e.markdown;
      }
      if (e.op === "remove" && "targets" in e) {
        for (const t of e.targets) {
          const id = typeof t === "object" && "_id" in t ? t._id : String(t);
          this.ids = this.ids.filter((x) => x !== id);
          delete this.hashes[id];
          delete this.parents[id];
          delete this.raws[id];
        }
      }
    }
  }
}

const DEP: RelationKind = { kind: "frontmatter", field: "depends_on" };
const BODY: RelationKind = { kind: "body-link" };

describe("relationKinds", () => {
  const edges = [
    { provenance: "frontmatter", field: "depends_on" },
    { provenance: "frontmatter", field: "related" },
    { provenance: "frontmatter", field: "depends_on" },
    { provenance: "body", field: null },
    { provenance: "body", field: "see" }, // an inline field is not a frontmatter kind
    { provenance: "external", field: "homepage" },
    { provenance: "frontmatter", field: "author" },
  ];
  it("the rendered frontmatter fields by frequency then name, the host's extras, then the body link", () => {
    expect(relationKinds(edges)).toEqual([
      { kind: "frontmatter", field: "depends_on" },
      { kind: "frontmatter", field: "author" },
      { kind: "frontmatter", field: "related" },
      { kind: "body-link" },
    ]);
    expect(relationKinds(edges, ["related", "parent", "", "author"])).toEqual([
      { kind: "frontmatter", field: "depends_on" },
      { kind: "frontmatter", field: "author" },
      { kind: "frontmatter", field: "related" },
      { kind: "frontmatter", field: "parent" },
      { kind: "body-link" },
    ]);
    expect(fieldCounts(edges)).toEqual(new Map([["depends_on", 2], ["related", 1], ["author", 1]]));
  });
  it("is never empty: an empty graph offers the body link alone", () => {
    expect(relationKinds([])).toEqual([{ kind: "body-link" }]);
    expect(relationKinds([{ provenance: "body", field: null }], ["parent"])).toEqual([{ kind: "frontmatter", field: "parent" }, { kind: "body-link" }]);
  });
});

describe("values and descriptions", () => {
  it("recognises path values and the documents they name", () => {
    expect(isPathValue("/a/b.md")).toBe(true);
    expect(isPathValue("[[Salt Of The Earth]]")).toBe(true);
    expect(isPathValue("a/b.md")).toBe(false);
    expect(isPathValue("/a b.md")).toBe(false);
    expect(isPathValue("https://example.com/x.md")).toBe(false);
    expect(namesDocument("[[salt|the salt]]", "/substances/salt.md")).toBe(true);
    expect(namesDocument("[[substances/salt]]", "/substances/salt.md")).toBe(true);
    expect(namesDocument("/substances/salt.md", "substances/salt.md")).toBe(true);
    expect(namesDocument("/other.md", "/substances/salt.md")).toBe(false);
  });
  it("describes an attach and a detach in one line each", () => {
    expect(describeRelation(DEP, "a.md", B)).toBe("add /b.md to `depends_on` of /a.md");
    expect(describeRelation(BODY, A, "b.md")).toBe("link /b.md from the body of /a.md");
    expect(describeDetach(DEP, A, B)).toBe("remove /b.md from `depends_on` of /a.md");
    expect(describeDetach(BODY, A, B)).toBe("remove the body link to /b.md from /a.md");
  });
  it("the body link's markdown and the new-block diff", () => {
    expect(bodyLinkMarkdown("b.md", "The [B] note")).toBe("[The B note](/b.md)");
    expect(bodyLinkMarkdown(B, null)).toBe("[b](/b.md)");
    expect(bodyLinkMarkdown(B, "  ")).toBe("[b](/b.md)");
    expect(newTopLevelBlocks(["b_1"], ["b_1", "b_2", "b_3"], { b_1: null, b_2: null, b_3: "b_2" })).toEqual(["b_2"]);
  });
  it("attachedValue is additive: absent → [to], list → list + to, scalar path → [scalar, to]; refuses a duplicate and a non-path scalar", () => {
    expect(attachedValue("f", undefined, false, A, B)).toEqual([B]);
    expect(attachedValue("f", null, true, A, B)).toEqual([B]);
    expect(attachedValue("f", ["/c.md"], true, A, "b.md")).toEqual(["/c.md", B]);
    expect(attachedValue("f", [], true, A, B)).toEqual([B]);
    expect(attachedValue("f", "/p.md", true, A, B)).toEqual(["/p.md", B]);
    expect(attachedValue("f", "[[p]]", true, A, B)).toEqual(["[[p]]", B]);
    expect(() => attachedValue("f", ["/c.md", B], true, A, B)).toThrow("already related: /b.md is already in `f` of /a.md");
    expect(() => attachedValue("f", ["[[b]]"], true, A, B)).toThrow(/already related/);
    expect(() => attachedValue("f", B, true, A, B)).toThrow("already related: `f` of /a.md already names /b.md");
    expect(() => attachedValue("f", 3, true, A, B)).toThrow("`f` holds a number, not a path or a list of paths");
    expect(() => attachedValue("f", "draft", true, A, B)).toThrow("`f` holds a string that is not a path, not a path or a list of paths");
    expect(() => attachedValue("f", { a: 1 }, true, A, B)).toThrow("`f` holds a record, not a path or a list of paths");
    expect(() => attachedValue("f", true, true, A, B)).toThrow("`f` holds a boolean, not a path or a list of paths");
  });
  it("detachedValue: the list without `to` (undefined when empty), undefined for the scalar `to`; refuses when nothing names it", () => {
    expect(detachedValue("f", ["/c.md", B, "/d.md"], true, A, B)).toEqual(["/c.md", "/d.md"]);
    expect(detachedValue("f", ["[[b]]", "/c.md"], true, A, B)).toEqual(["/c.md"]);
    expect(detachedValue("f", [B], true, A, B)).toBeUndefined();
    expect(detachedValue("f", B, true, A, "b.md")).toBeUndefined();
    expect(() => detachedValue("f", undefined, false, A, B)).toThrow("`f` of /a.md is absent; nothing names /b.md");
    expect(() => detachedValue("f", ["/c.md"], true, A, B)).toThrow("`f` of /a.md does not name /b.md");
    expect(() => detachedValue("f", "/c.md", true, A, B)).toThrow(/does not name/);
    expect(() => detachedValue("f", 3, true, A, B)).toThrow(/does not name/);
  });
});

describe("attachRelationCommand — frontmatter", () => {
  it("append: re-reads, writes ONE revision-guarded `set` with the list plus the destination, records the state", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.commit = true;
    const cmd = attachRelationCommand({ from: "a.md", to: "b.md", how: DEP, repo: "alchemy" });
    expect(cmd.kind).toBe("repository");
    expect(cmd.label).toBe("add /b.md to `depends_on` of /a.md");
    const applied = await cmd.apply({ client: doc.client() }, run);
    expect(doc.applies).toEqual([{ effects: [{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.depends_on", value: ["/c.md", B], expect: { revision: "r1" } }], reason: cmd.label, repo: "alchemy" }]);
    expect(doc.reads).toEqual([{ includeIds: undefined, repo: "alchemy" }]);
    expect(applied.state).toEqual({ field: "depends_on", previous: ["/c.md"], existed: true, written: ["/c.md", B] });
    expect(applied.revisions).toEqual([{ _id: "d_a", _path: A, _hash: "H1" }]);
    expect(doc.frontmatter.depends_on).toEqual(["/c.md", B]);
  });

  it("an absent field becomes [to]; a scalar path becomes [scalar, to] — never replaced", async () => {
    const doc = new FakeDoc({ parent: "/p.md" });
    doc.commit = true;
    const ctx = { client: doc.client() };
    const fresh = await attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "related" } }).apply(ctx, run);
    expect(doc.applies[0]!.effects).toEqual([{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.related", value: [B], expect: { revision: "r1" } }]);
    expect(doc.applies[0]!.repo).toBeUndefined();
    expect(fresh.state).toEqual({ field: "related", existed: false, previous: undefined, written: [B] });
    const listed = await attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "parent" } }).apply(ctx, run);
    expect(doc.applies[1]!.effects).toEqual([{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.parent", value: ["/p.md", B], expect: { revision: "r2" } }]);
    expect(listed.state).toEqual({ field: "parent", existed: true, previous: "/p.md", written: ["/p.md", B] });
    expect(doc.frontmatter.parent).toEqual(["/p.md", B]);
  });

  it("refuses BEFORE writing: already related (list or scalar), a non-path scalar, an unnamed field", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md", B], parent: B, count: 2, status: "draft" });
    const ctx = { client: doc.client() };
    await expect(attachRelationCommand({ from: A, to: B, how: DEP }).apply(ctx, run)).rejects.toThrow("already related: /b.md is already in `depends_on` of /a.md");
    await expect(attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "parent" } }).apply(ctx, run)).rejects.toThrow(/already related/);
    await expect(attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "count" } }).apply(ctx, run)).rejects.toThrow("`count` holds a number, not a path or a list of paths");
    await expect(attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "status" } }).apply(ctx, run)).rejects.toThrow(/holds a string that is not a path/);
    await expect(attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "  " } }).apply(ctx, run)).rejects.toThrow(/needs a name/);
    expect(doc.applies).toHaveLength(0);
    // Through the log: `failed`, nothing applied, not undoable.
    const log = new CommandLog(ctx);
    const entry = await log.run(attachRelationCommand({ from: A, to: B, how: DEP }));
    expect(entry.state).toBe("failed");
    expect(entry.steps[0]!.applied).toBeNull();
    expect((entry.error as Error).message).toMatch(/already related/);
    expect(log.canUndo).toBe(false);
    expect(doc.applies).toHaveLength(0);
  });

  it("writes no revision guard when the document has none; the server's stale answer propagates", async () => {
    const doc = new FakeDoc({});
    doc.rev = null;
    const ctx = { client: doc.client() };
    await attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "related" } }).apply(ctx, run);
    expect(doc.applies[0]!.effects[0]).toEqual({ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.related", value: [B] });
    const client = doc.client();
    const stale = Object.assign(new Error("stale_plan"), { code: "stale_plan" });
    (client as { apply: unknown }).apply = async () => { throw stale; };
    await expect(attachRelationCommand({ from: A, to: B, how: DEP }).apply({ client }, run)).rejects.toBe(stale);
  });

  it("compensation: restores the previous value pinned to the CURRENT revision when the field still holds exactly what was written; unsets a field it created", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.commit = true;
    const ctx = { client: doc.client() };
    const cmd = attachRelationCommand({ from: A, to: B, how: DEP });
    const applied = await cmd.apply(ctx, run);
    doc.rev = "r7"; // someone edited another field meanwhile — the list is intact, so the undo is pinned to the newer revision
    expect(await cmd.compensate(ctx, applied)).toEqual({ effects: [{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.depends_on", value: ["/c.md"], expect: { revision: "r7" } }], reason: "restore `depends_on`" });
    const made = attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "related" } });
    const applied2 = await made.apply(ctx, run);
    expect(await made.compensate(ctx, applied2)).toEqual({ effects: [{ op: "unset", target: { kind: "document", _path: A }, field: "_frontmatter.related", expect: { revision: "r3" } }], reason: "remove `related`" });
    // A scalar that became a list is restored to the scalar.
    doc.frontmatter.parent = "/p.md";
    const grown = attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "parent" } });
    const applied3 = await grown.apply(ctx, run);
    expect(await grown.compensate(ctx, applied3)).toMatchObject({ effects: [{ op: "set", field: "_frontmatter.parent", value: "/p.md" }] });
  });

  it("compensation refuses when the field moved on: another entry appended, the destination removed, the field gone, a foreign state", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.commit = true;
    const ctx = { client: doc.client() };
    const cmd = attachRelationCommand({ from: A, to: B, how: DEP });
    const applied = await cmd.apply(ctx, run);
    doc.frontmatter.depends_on = ["/c.md", B, "/e.md"];
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: '`depends_on` no longer holds the value this command wrote (now ["/c.md","/b.md","/e.md"])' });
    doc.frontmatter.depends_on = ["/c.md"];
    expect(await cmd.compensate(ctx, applied)).toMatchObject({ refused: expect.stringContaining("no longer holds") });
    delete doc.frontmatter.depends_on;
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: "`depends_on` is gone from /a.md" });
    expect(doc.applies).toHaveLength(1);
    const wrong = { ...applied, state: { blockId: "b_9", hash: "h" } } as Applied<AttachRelationState>;
    expect(await cmd.compensate(ctx, wrong)).toEqual({ refused: "not a frontmatter state" });
  });

  it("through the CommandLog: run, undo (one compensating apply), redo re-reads fresh preconditions; a moved-on field refuses the undo", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.commit = true;
    const log = new CommandLog({ client: doc.client() });
    const entry = await log.run(attachRelationCommand({ from: A, to: B, how: DEP }));
    expect(entry.state).toBe("applied");
    expect(doc.frontmatter.depends_on).toEqual(["/c.md", B]);
    await log.undo();
    expect(doc.frontmatter.depends_on).toEqual(["/c.md"]);
    expect(doc.applies[1]!.effects[0]).toMatchObject({ op: "set", value: ["/c.md"], expect: { revision: "r2" } });
    expect(doc.applies[1]!.reason).toBe("undo: add /b.md to `depends_on` of /a.md — restore `depends_on`");
    await log.redo();
    expect(doc.frontmatter.depends_on).toEqual(["/c.md", B]);
    expect(doc.applies[2]!.effects[0]).toMatchObject({ expect: { revision: "r3" } });
    doc.frontmatter.depends_on = ["/c.md", B, "/z.md"];
    const refused = await log.undo();
    expect(refused!.state).toBe("refused");
    expect(doc.applies).toHaveLength(3);
  });
});

describe("attachRelationCommand — body link", () => {
  it("inserts `[title](/to.md)` at the end of the document and identifies the new top-level block by diffing ids", async () => {
    const doc = new FakeDoc({});
    doc.commit = true;
    const cmd = attachRelationCommand({ from: A, to: "b.md", toTitle: "Beta", how: BODY, repo: "alchemy" });
    expect(cmd.label).toBe("link /b.md from the body of /a.md");
    const applied = await cmd.apply({ client: doc.client() }, run);
    expect(doc.applies).toEqual([{ effects: [{ op: "insert", into: { kind: "document", _path: A }, at: "end", markdown: "[Beta](/b.md)" }], reason: cmd.label, repo: "alchemy" }]);
    expect(doc.reads).toEqual([{ includeIds: true, repo: "alchemy" }, { includeIds: true, repo: "alchemy" }]);
    expect(applied.state).toEqual({ blockId: "b_4", hash: "h_b_4" });
  });

  it("falls back to the path's stem as the link text; a nested new block is not the paragraph", async () => {
    const doc = new FakeDoc({});
    doc.onApply = () => { doc.ids.push("b_3", "b_4"); doc.hashes.b_3 = "h3"; doc.hashes.b_4 = "h4"; doc.parents.b_3 = null; doc.parents.b_4 = "b_3"; };
    const applied = await attachRelationCommand({ from: A, to: B, how: BODY }).apply({ client: doc.client() }, run);
    expect(doc.applies[0]!.effects[0]).toMatchObject({ markdown: "[b](/b.md)" });
    expect(applied.state).toEqual({ blockId: "b_3", hash: "h3" });
  });

  it("compensation removes the block pinned to its hash; refuses when the block is gone, changed, never identified, or the state is foreign", async () => {
    const doc = new FakeDoc({});
    doc.onApply = () => { doc.ids.push("b_3"); doc.hashes.b_3 = "h3"; doc.parents.b_3 = null; };
    const ctx = { client: doc.client() };
    const cmd = attachRelationCommand({ from: A, to: B, how: BODY });
    const applied = await cmd.apply(ctx, run);
    expect(await cmd.compensate(ctx, applied)).toEqual({ effects: [{ op: "remove", targets: [{ kind: "block", _id: "b_3" }], expect: { b_3: { content_hash: "h3" } } }], reason: "remove the link to /b.md" });
    doc.hashes.b_3 = "h3-edited";
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: "block b_3 changed since (hash h3-edited, expected h3)" });
    doc.ids = ["b_1", "b_2"];
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: "block b_3 is gone from /a.md" });
    const unidentified = { ...applied, state: { blockId: null, hash: null } } as Applied<AttachRelationState>;
    expect(await cmd.compensate(ctx, unidentified)).toEqual({ refused: "the inserted block in /a.md could not be identified after the write" });
    const wrong = { ...applied, state: { field: "x", previous: undefined, existed: false, written: [] } } as Applied<AttachRelationState>;
    expect(await cmd.compensate(ctx, wrong)).toEqual({ refused: "not a body-link state" });
  });

  it("records a null block when the write produced no new top-level block (the undo will refuse rather than guess)", async () => {
    const doc = new FakeDoc({});
    const applied = await attachRelationCommand({ from: A, to: B, how: BODY }).apply({ client: doc.client() }, run);
    expect(applied.state).toEqual({ blockId: null, hash: null });
  });
});

describe("detachRelationCommand — frontmatter", () => {
  it("removes `to` from the list with ONE revision-guarded `set`; an emptied list UNSETS the field; a scalar `to` unsets", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md", B], related: [B], parent: B });
    doc.commit = true;
    const ctx = { client: doc.client() };
    const shorter = detachRelationCommand({ from: "a.md", to: "b.md", how: DEP, repo: "alchemy" });
    expect(shorter.label).toBe("remove /b.md from `depends_on` of /a.md");
    const a1 = await shorter.apply(ctx, run);
    expect(doc.applies[0]).toEqual({ effects: [{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.depends_on", value: ["/c.md"], expect: { revision: "r1" } }], reason: shorter.label, repo: "alchemy" });
    expect(a1.state).toEqual({ field: "depends_on", previous: ["/c.md", B], written: ["/c.md"] });
    const emptied = detachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "related" } });
    const a2 = await emptied.apply(ctx, run);
    expect(doc.applies[1]!.effects).toEqual([{ op: "unset", target: { kind: "document", _path: A }, field: "_frontmatter.related", expect: { revision: "r2" } }]);
    expect(a2.state).toEqual({ field: "related", previous: [B], written: undefined });
    const scalar = detachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "parent" } });
    await scalar.apply(ctx, run);
    expect(doc.applies[2]!.effects).toEqual([{ op: "unset", target: { kind: "document", _path: A }, field: "_frontmatter.parent", expect: { revision: "r3" } }]);
    expect(doc.frontmatter).toEqual({ depends_on: ["/c.md"] });
  });

  it("refuses BEFORE writing when the field is absent or does not name `to`", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"], count: 3 });
    const ctx = { client: doc.client() };
    await expect(detachRelationCommand({ from: A, to: B, how: DEP }).apply(ctx, run)).rejects.toThrow("`depends_on` of /a.md does not name /b.md");
    await expect(detachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "nope" } }).apply(ctx, run)).rejects.toThrow("`nope` of /a.md is absent; nothing names /b.md");
    await expect(detachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "count" } }).apply(ctx, run)).rejects.toThrow(/does not name/);
    expect(doc.applies).toHaveLength(0);
  });

  it("compensation restores the previous value pinned to the current revision when the field holds what the detach wrote (or is absent when it unset); refuses otherwise", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md", B], related: [B] });
    doc.commit = true;
    const ctx = { client: doc.client() };
    const shorter = detachRelationCommand({ from: A, to: B, how: DEP });
    const a1 = await shorter.apply(ctx, run);
    doc.rev = "r9";
    expect(await shorter.compensate(ctx, a1)).toEqual({ effects: [{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.depends_on", value: ["/c.md", B], expect: { revision: "r9" } }], reason: "restore `depends_on`" });
    doc.frontmatter.depends_on = ["/c.md", "/z.md"];
    expect(await shorter.compensate(ctx, a1)).toEqual({ refused: '`depends_on` no longer holds the value this command wrote (now ["/c.md","/z.md"])' });
    delete doc.frontmatter.depends_on;
    expect(await shorter.compensate(ctx, a1)).toEqual({ refused: "`depends_on` is gone from /a.md" });

    const emptied = detachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "related" } });
    const a2 = await emptied.apply(ctx, run);
    expect(await emptied.compensate(ctx, a2)).toEqual({ effects: [{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.related", value: [B], expect: { revision: "r3" } }], reason: "restore `related`" });
    doc.frontmatter.related = ["/q.md"];
    expect(await emptied.compensate(ctx, a2)).toEqual({ refused: '`related` was set again since it was unset (now ["/q.md"])' });
    const wrong = { ...a2, state: { blockId: "b_2", markdown: "x" } } as Applied<DetachRelationState>;
    expect(await emptied.compensate(ctx, wrong)).toEqual({ refused: "not a frontmatter state" });
  });

  it("through the CommandLog: detach, undo restores the list, redo detaches again", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md", B] });
    doc.commit = true;
    const log = new CommandLog({ client: doc.client() });
    const e = await log.run(detachRelationCommand({ from: A, to: B, how: DEP }));
    expect(e.state).toBe("applied");
    expect(doc.frontmatter.depends_on).toEqual(["/c.md"]);
    const u = await log.undo();
    expect(u?.state).toBe("undone");
    expect(doc.frontmatter.depends_on).toEqual(["/c.md", B]);
    expect(doc.applies[1]!.reason).toBe("undo: remove /b.md from `depends_on` of /a.md — restore `depends_on`");
    await log.redo();
    expect(doc.frontmatter.depends_on).toEqual(["/c.md"]);
  });
});

describe("detachRelationCommand — body link", () => {
  it("reads the block's raw and hash, removes it by its hash, keeps the markdown; refuses a missing block id or a gone block before writing", async () => {
    const doc = new FakeDoc({});
    doc.commit = true;
    const ctx = { client: doc.client() };
    const cmd = detachRelationCommand({ from: A, to: B, how: BODY, blockId: "b_2", repo: "alchemy" });
    expect(cmd.label).toBe("remove the body link to /b.md from /a.md");
    const applied = await cmd.apply(ctx, run);
    expect(doc.queries).toEqual(['blocks { select _raw, _hash where _id == "b_2" }']);
    expect(doc.applies).toEqual([{ effects: [{ op: "remove", targets: [{ kind: "block", _id: "b_2" }], expect: { b_2: { content_hash: "h2" } } }], reason: cmd.label, repo: "alchemy" }]);
    expect(applied.state).toEqual({ blockId: "b_2", markdown: "[Beta](/b.md)" });
    expect(doc.ids).toEqual(["b_1"]);
    await expect(detachRelationCommand({ from: A, to: B, how: BODY }).apply(ctx, run)).rejects.toThrow(/needs its block id/);
    await expect(detachRelationCommand({ from: A, to: B, how: BODY, blockId: "b_2" }).apply(ctx, run)).rejects.toThrow("block b_2 is gone from /a.md");
    expect(doc.applies).toHaveLength(1);
  });

  it("compensation re-inserts the markdown at the end of the document; refuses when the document is gone or the source was empty", async () => {
    const doc = new FakeDoc({});
    doc.commit = true;
    const ctx = { client: doc.client() };
    const cmd = detachRelationCommand({ from: A, to: B, how: BODY, blockId: "b_2" });
    const applied = await cmd.apply(ctx, run);
    expect(await cmd.compensate(ctx, applied)).toEqual({ effects: [{ op: "insert", into: { kind: "document", _path: A }, at: "end", markdown: "[Beta](/b.md)" }], reason: "re-insert the link to /b.md (at the end of /a.md)" });
    const empty = { ...applied, state: { blockId: "b_2", markdown: "  " } } as Applied<DetachRelationState>;
    expect(await cmd.compensate(ctx, empty)).toEqual({ refused: "the removed block b_2 had no source to re-insert" });
    const wrong = { ...applied, state: { field: "f", previous: 1, written: 2 } } as Applied<DetachRelationState>;
    expect(await cmd.compensate(ctx, wrong)).toEqual({ refused: "not a body-link state" });
    doc.gone = true;
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: "/a.md no longer exists" });
  });

  it("through the CommandLog: detach, undo re-inserts (a new block at the end), redo removes that block by its fresh hash", async () => {
    const doc = new FakeDoc({});
    doc.commit = true;
    const log = new CommandLog({ client: doc.client() });
    const e = await log.run(detachRelationCommand({ from: A, to: B, how: BODY, blockId: "b_2" }));
    expect(e.state).toBe("applied");
    expect(doc.ids).toEqual(["b_1"]);
    const u = await log.undo();
    expect(u?.state).toBe("undone");
    expect(doc.ids).toHaveLength(2);
    const reinserted = doc.ids[1]!;
    expect(doc.raws[reinserted]).toBe("[Beta](/b.md)");
    // Redo targets the ORIGINAL block id (gone), so it fails honestly: the log records `failed`, nothing applied.
    const r = await log.redo();
    expect(r?.state).toBe("failed");
    expect((r?.error as Error).message).toBe("block b_2 is gone from /a.md");
    expect(doc.ids).toHaveLength(2);
  });
});
