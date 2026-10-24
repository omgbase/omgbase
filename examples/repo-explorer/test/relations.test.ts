import { describe, expect, it } from "vitest";
import { CommandLog, type Applied, type ApplyRequest, type CommandClient, type DocsReadResult, type Receipt } from "@omgbase/client";
import { attachRelationCommand, bodyLinkMarkdown, describeRelation, isPathValue, namesDocument, newTopLevelBlocks, nextFieldValue, relationChoices, type RelationChoice, type RelationState } from "../src/lib/relations.ts";

const A = "/a.md", B = "/b.md";

/** A hand-written minimal server: one document whose frontmatter, revision and block list the test moves between calls. */
class FakeDoc {
  frontmatter: Record<string, unknown>;
  rev = "r1";
  ids: string[] = ["b_1", "b_2"];
  hashes: Record<string, string> = { b_1: "h1", b_2: "h2" };
  parents: Record<string, string | null> = { b_1: null, b_2: null };
  applies: ApplyRequest[] = [];
  reads: { includeIds: boolean | undefined; repo: unknown }[] = [];
  /** Side effect to run when an apply lands (the "server" committing it). */
  onApply: (req: ApplyRequest) => void = () => {};
  constructor(frontmatter: Record<string, unknown>) { this.frontmatter = frontmatter; }

  client(): CommandClient {
    return {
      docsRead: async (_loc: unknown, opts: { includeIds?: boolean; repo?: unknown } = {}) => {
        this.reads.push({ includeIds: opts.includeIds, repo: opts.repo });
        const out: DocsReadResult = { _id: "d_a", _path: A, rev: this.rev, properties: { frontmatter: { ...this.frontmatter }, inline: {}, computed: {} }, _raw: "" };
        if (opts.includeIds) { out.ids = [...this.ids]; out.hashes = { ...this.hashes }; out.parents = { ...this.parents }; }
        return out;
      },
      apply: async (req: ApplyRequest) => {
        this.applies.push(req);
        this.onApply(req);
        const n = this.applies.length;
        this.rev = `r${n + 1}`;
        const receipt: Receipt = { plan_id: `p_${n}`, commit: `c_${n}`, revisions: [{ _id: "d_a", _path: A, _hash: `H${n}` }], new_ids: {}, committed: true, summary: [req.reason ?? ""] };
        return receipt;
      },
      query: () => Promise.reject(new Error("unused")),
      call: () => Promise.reject(new Error("unused")),
    } as unknown as CommandClient;
  }

  /** The server applies a frontmatter `set`/`unset` effect for real. */
  commitFrontmatter = (req: ApplyRequest): void => {
    for (const e of req.effects) {
      if (e.op === "set" && e.field.startsWith("_frontmatter.")) this.frontmatter[e.field.slice("_frontmatter.".length)] = e.value;
      if (e.op === "unset" && e.field.startsWith("_frontmatter.")) delete this.frontmatter[e.field.slice("_frontmatter.".length)];
    }
  };
}

const run = { redo: false, previous: null } as const;

describe("relationChoices", () => {
  it("offers every path-valued field with its mode, plus a new field and a body link — never a silent pick", () => {
    const choices = relationChoices({ frontmatter: { title: "A", tags: ["x", "y"], depends_on: ["/c.md", "/d.md"], parent: "/p.md", wiki: ["[[salt]]"], empty: [], mixed: ["/c.md", 3], count: 2 } }, B);
    expect(choices).toEqual([
      { kind: "frontmatter", field: "depends_on", current: ["/c.md", "/d.md"], mode: "append", note: "append to the 2-entry list" },
      { kind: "frontmatter", field: "parent", current: ["/p.md"], mode: "to-list", note: "the field becomes a list: [/p.md, /b.md]" },
      { kind: "frontmatter", field: "parent", current: ["/p.md"], mode: "replace-scalar", note: "replaces /p.md, which is dropped" },
      { kind: "frontmatter", field: "wiki", current: ["[[salt]]"], mode: "append", note: "append to the 1-entry list" },
      { kind: "frontmatter-new", field: "" },
      { kind: "body-link" },
    ]);
  });
  it("leaves out a field that already names the destination (by path or by wikilink)", () => {
    const choices = relationChoices({ frontmatter: { depends_on: ["/b.md"], parent: "[[b]]", other: "/c.md" } }, "b.md");
    expect(choices.map((c) => (c.kind === "frontmatter" ? `${c.field}:${c.mode}` : c.kind))).toEqual(["other:to-list", "other:replace-scalar", "frontmatter-new", "body-link"]);
    expect(relationChoices({ frontmatter: {} }, B)).toEqual([{ kind: "frontmatter-new", field: "" }, { kind: "body-link" }]);
  });
  it("recognises path values", () => {
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
  it("describes each choice in one line", () => {
    expect(describeRelation({ kind: "frontmatter", field: "depends_on", current: ["/c.md", "/d.md"], mode: "append", note: "" }, A, B)).toBe("append /b.md to frontmatter `depends_on` of /a.md (now 3 entries)");
    expect(describeRelation({ kind: "frontmatter", field: "parent", current: ["/p.md"], mode: "to-list", note: "" }, A, B)).toBe("turn frontmatter `parent` of /a.md into a list [/p.md, /b.md]");
    expect(describeRelation({ kind: "frontmatter", field: "parent", current: ["/p.md"], mode: "replace-scalar", note: "" }, A, B)).toBe("replace /p.md with /b.md in frontmatter `parent` of /a.md");
    expect(describeRelation({ kind: "frontmatter-new", field: "related" }, A, B)).toBe("create frontmatter list `related` on /a.md with /b.md");
    expect(describeRelation({ kind: "frontmatter-new", field: "" }, A, B)).toBe("create frontmatter list `<field>` on /a.md with /b.md");
    expect(describeRelation({ kind: "body-link" }, "a.md", "b.md")).toBe("append a link to /b.md at the end of /a.md");
  });
  it("computes the next field value over the CURRENT value, refusing duplicates and a taken new field", () => {
    const append: RelationChoice = { kind: "frontmatter", field: "depends_on", current: [], mode: "append", note: "" };
    expect(nextFieldValue(append, ["/c.md"], true, B)).toEqual(["/c.md", B]);
    expect(nextFieldValue(append, undefined, false, B)).toEqual([B]);
    expect(nextFieldValue({ ...append, mode: "to-list" }, "/p.md", true, B)).toEqual(["/p.md", B]);
    expect(nextFieldValue({ ...append, mode: "to-list" }, ["/p.md"], true, B)).toEqual(["/p.md", B]);
    expect(nextFieldValue({ ...append, mode: "replace-scalar" }, "/p.md", true, B)).toBe(B);
    expect(nextFieldValue({ kind: "frontmatter-new", field: "related" }, undefined, false, B)).toEqual([B]);
    expect(() => nextFieldValue({ kind: "frontmatter-new", field: "related" }, [], true, B)).toThrow(/already exists/);
    expect(() => nextFieldValue(append, ["/b.md"], true, B)).toThrow(/already names/);
    expect(() => nextFieldValue({ ...append, mode: "to-list" }, "[[b]]", true, B)).toThrow(/already names/);
    expect(() => nextFieldValue({ kind: "body-link" }, null, false, B)).toThrow(/not a frontmatter/);
    expect(bodyLinkMarkdown("b.md", "The [B] note")).toBe("[The B note](/b.md)");
    expect(bodyLinkMarkdown(B, null)).toBe("[b](/b.md)");
    expect(bodyLinkMarkdown(B, "  ")).toBe("[b](/b.md)");
    expect(newTopLevelBlocks(["b_1"], ["b_1", "b_2", "b_3"], { b_1: null, b_2: null, b_3: "b_2" })).toEqual(["b_2"]);
  });
});

describe("attachRelationCommand — frontmatter", () => {
  const append: RelationChoice = { kind: "frontmatter", field: "depends_on", current: ["/c.md"], mode: "append", note: "" };

  it("append: re-reads, writes ONE revision-guarded `set` with the list plus the destination, records the state", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.onApply = doc.commitFrontmatter;
    const cmd = attachRelationCommand({ from: "a.md", to: "b.md", how: append, repo: "alchemy" });
    expect(cmd.kind).toBe("repository");
    expect(cmd.label).toBe("append /b.md to frontmatter `depends_on` of /a.md (now 2 entries)");
    const applied = await cmd.apply({ client: doc.client() }, run);
    expect(doc.applies).toEqual([{ effects: [{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.depends_on", value: ["/c.md", B], expect: { revision: "r1" } }], reason: cmd.label, repo: "alchemy" }]);
    expect(doc.reads).toEqual([{ includeIds: undefined, repo: "alchemy" }]);
    expect(applied.state).toEqual({ kind: "frontmatter", field: "depends_on", revision: "r1", previous: ["/c.md"], existed: true, written: ["/c.md", B] });
    expect(applied.revisions).toEqual([{ _id: "d_a", _path: A, _hash: "H1" }]);
  });

  it("new field: `[to]` on a field that did not exist; to-list: the scalar becomes `[current, to]`; replace-scalar: the path alone", async () => {
    const doc = new FakeDoc({ parent: "/p.md" });
    doc.onApply = doc.commitFrontmatter;
    const ctx = { client: doc.client() };
    const fresh = await attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter-new", field: "related" } }).apply(ctx, run);
    expect(doc.applies[0]!.effects).toEqual([{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.related", value: [B], expect: { revision: "r1" } }]);
    expect(doc.applies[0]!.repo).toBeUndefined();
    expect(fresh.state).toMatchObject({ existed: false, previous: undefined, written: [B] });
    await attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter", field: "parent", current: ["/p.md"], mode: "to-list", note: "" } }).apply(ctx, run);
    expect(doc.applies[1]!.effects).toEqual([{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.parent", value: ["/p.md", B], expect: { revision: "r2" } }]);
    doc.frontmatter.parent = "/p.md";
    await attachRelationCommand({ from: A, to: "/q.md", how: { kind: "frontmatter", field: "parent", current: ["/p.md"], mode: "replace-scalar", note: "" } }).apply(ctx, run);
    expect(doc.applies[2]!.effects).toEqual([{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.parent", value: "/q.md", expect: { revision: "r3" } }]);
  });

  it("writes no revision guard when the document has none, and refuses an unnamed new field or a taken one before writing", async () => {
    const doc = new FakeDoc({});
    doc.rev = null as unknown as string;
    const ctx = { client: doc.client() };
    await attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter-new", field: "related" } }).apply(ctx, run);
    expect(doc.applies[0]!.effects[0]).toEqual({ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.related", value: [B] });
    await expect(attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter-new", field: "" } }).apply(ctx, run)).rejects.toThrow(/needs a name/);
    doc.frontmatter.taken = ["/c.md"];
    await expect(attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter-new", field: "taken" } }).apply(ctx, run)).rejects.toThrow(/already exists/);
    expect(doc.applies).toHaveLength(1);
  });

  it("the guard is the revision read at write time: the server's stale answer propagates, nothing is retried", async () => {
    const doc = new FakeDoc({ depends_on: [] });
    const client = doc.client();
    const stale = Object.assign(new Error("stale_plan"), { code: "stale_plan" });
    (client as { apply: unknown }).apply = async () => { throw stale; };
    await expect(attachRelationCommand({ from: A, to: B, how: append }).apply({ client }, run)).rejects.toBe(stale);
  });

  it("compensation: restores the previous value pinned to the CURRENT revision when the field still holds exactly what was written", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.onApply = doc.commitFrontmatter;
    const ctx = { client: doc.client() };
    const cmd = attachRelationCommand({ from: A, to: B, how: append });
    const applied = await cmd.apply(ctx, run);
    expect(doc.frontmatter.depends_on).toEqual(["/c.md", B]);
    doc.rev = "r7"; // someone edited another field meanwhile — the list is intact, so the undo is pinned to the newer revision
    const c = await cmd.compensate(ctx, applied);
    expect(c).toEqual({ effects: [{ op: "set", target: { kind: "document", _path: A }, field: "_frontmatter.depends_on", value: ["/c.md"], expect: { revision: "r7" } }], reason: "restore `depends_on`" });
  });

  it("compensation unsets a field the command created", async () => {
    const doc = new FakeDoc({});
    doc.onApply = doc.commitFrontmatter;
    const ctx = { client: doc.client() };
    const cmd = attachRelationCommand({ from: A, to: B, how: { kind: "frontmatter-new", field: "related" } });
    const applied = await cmd.apply(ctx, run);
    expect(await cmd.compensate(ctx, applied)).toEqual({ effects: [{ op: "unset", target: { kind: "document", _path: A }, field: "_frontmatter.related", expect: { revision: "r2" } }], reason: "remove `related`" });
  });

  it("compensation refuses when the field moved on: another entry appended, the destination removed, the field gone", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.onApply = doc.commitFrontmatter;
    const ctx = { client: doc.client() };
    const cmd = attachRelationCommand({ from: A, to: B, how: append });
    const applied = await cmd.apply(ctx, run);
    doc.frontmatter.depends_on = ["/c.md", B, "/e.md"];
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: '`depends_on` no longer holds the value this command wrote (now ["/c.md","/b.md","/e.md"])' });
    doc.frontmatter.depends_on = ["/c.md"];
    expect(await cmd.compensate(ctx, applied)).toMatchObject({ refused: expect.stringContaining("no longer holds") });
    delete doc.frontmatter.depends_on;
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: "`depends_on` is gone from /a.md" });
    expect(doc.applies).toHaveLength(1);
    const wrong = { ...applied, state: { kind: "body-link", blockId: "b_9", hash: "h", markdown: "" } } as Applied<RelationState>;
    expect(await cmd.compensate(ctx, wrong)).toEqual({ refused: "not a frontmatter state" });
  });

  it("through the CommandLog: run, undo (one compensating apply), redo re-reads fresh preconditions", async () => {
    const doc = new FakeDoc({ depends_on: ["/c.md"] });
    doc.onApply = doc.commitFrontmatter;
    const log = new CommandLog({ client: doc.client() });
    const entry = await log.run(attachRelationCommand({ from: A, to: B, how: append }));
    expect(entry.state).toBe("applied");
    expect(doc.frontmatter.depends_on).toEqual(["/c.md", B]);
    await log.undo();
    expect(doc.frontmatter.depends_on).toEqual(["/c.md"]);
    expect(doc.applies[1]!.effects[0]).toMatchObject({ op: "set", value: ["/c.md"], expect: { revision: "r2" } });
    expect(doc.applies[1]!.reason).toMatch(/^undo: append \/b\.md to frontmatter `depends_on` of \/a\.md \(now 2 entries\) — restore `depends_on`$/);
    await log.redo();
    expect(doc.frontmatter.depends_on).toEqual(["/c.md", B]);
    expect(doc.applies[2]!.effects[0]).toMatchObject({ expect: { revision: "r3" } });
    // The world moves on under the applied entry: undo is refused, the entry stays applied.
    doc.frontmatter.depends_on = ["/c.md", B, "/z.md"];
    const refused = await log.undo();
    expect(refused!.state).toBe("refused");
    expect(doc.applies).toHaveLength(3);
  });
});

describe("attachRelationCommand — body link", () => {
  function linkDoc(): FakeDoc {
    const doc = new FakeDoc({});
    doc.onApply = (req) => {
      const e = req.effects[0]!;
      if (e.op !== "insert") return;
      doc.ids.push("b_3");
      doc.hashes.b_3 = "h3";
      doc.parents.b_3 = null;
    };
    return doc;
  }

  it("inserts `[title](/to.md)` at the end of the document and identifies the new top-level block by diffing ids", async () => {
    const doc = linkDoc();
    const cmd = attachRelationCommand({ from: A, to: "b.md", toTitle: "Beta", how: { kind: "body-link" }, repo: "alchemy" });
    expect(cmd.label).toBe("append a link to /b.md at the end of /a.md");
    const applied = await cmd.apply({ client: doc.client() }, run);
    expect(doc.applies).toEqual([{ effects: [{ op: "insert", into: { kind: "document", _path: A }, at: "end", markdown: "[Beta](/b.md)" }], reason: cmd.label, repo: "alchemy" }]);
    expect(doc.reads).toEqual([{ includeIds: true, repo: "alchemy" }, { includeIds: true, repo: "alchemy" }]);
    expect(applied.state).toEqual({ kind: "body-link", blockId: "b_3", hash: "h3", markdown: "[Beta](/b.md)" });
  });

  it("falls back to the path's stem as the link text; a nested new block is not the paragraph", async () => {
    const doc = linkDoc();
    doc.onApply = () => { doc.ids.push("b_3", "b_4"); doc.hashes.b_3 = "h3"; doc.hashes.b_4 = "h4"; doc.parents.b_3 = null; doc.parents.b_4 = "b_3"; };
    const applied = await attachRelationCommand({ from: A, to: B, how: { kind: "body-link" } }).apply({ client: doc.client() }, run);
    expect(doc.applies[0]!.effects[0]).toMatchObject({ markdown: "[b](/b.md)" });
    expect(applied.state).toMatchObject({ blockId: "b_3", hash: "h3" });
  });

  it("compensation removes the block pinned to its hash; refuses when the block is gone, changed, or was never identified", async () => {
    const doc = linkDoc();
    const ctx = { client: doc.client() };
    const cmd = attachRelationCommand({ from: A, to: B, how: { kind: "body-link" } });
    const applied = await cmd.apply(ctx, run);
    expect(await cmd.compensate(ctx, applied)).toEqual({ effects: [{ op: "remove", targets: [{ kind: "block", _id: "b_3" }], expect: { b_3: { content_hash: "h3" } } }], reason: "remove the link to /b.md" });
    doc.hashes.b_3 = "h3-edited";
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: "block b_3 changed since (hash h3-edited, expected h3)" });
    doc.ids = ["b_1", "b_2"];
    expect(await cmd.compensate(ctx, applied)).toEqual({ refused: "block b_3 is gone from /a.md" });
    const unidentified = { ...applied, state: { ...applied.state, blockId: null, hash: null } } as Applied<RelationState>;
    expect(await cmd.compensate(ctx, unidentified)).toEqual({ refused: "the inserted block in /a.md could not be identified after the write" });
    const wrong = { ...applied, state: { kind: "frontmatter", field: "x", revision: null, previous: undefined, existed: false, written: [] } } as Applied<RelationState>;
    expect(await cmd.compensate(ctx, wrong)).toEqual({ refused: "not a body-link state" });
  });

  it("records a null block when the write produced no new top-level block (the undo will refuse rather than guess)", async () => {
    const doc = new FakeDoc({});
    const applied = await attachRelationCommand({ from: A, to: B, how: { kind: "body-link" } }).apply({ client: doc.client() }, run);
    expect(applied.state).toEqual({ kind: "body-link", blockId: null, hash: null, markdown: "[b](/b.md)" });
  });
});
