// The toggle as a command: the shared attach / detach when the field is a list
// of rooted `.md` paths, this demo's form-aware builder otherwise — both re-read
// the owner, pin the write to its revision and refuse an undo over a changed
// field. The fake client below is the four methods `CommandClient` names.
import { describe, expect, it } from "vitest";
import { CommandLog, type ApplyRequest, type CommandClient, type DocsReadResult, type Receipt } from "@omgbase/client";
import { DEFAULT_FORM, ID_FORM, type RefForm } from "../src/lib/edit.ts";
import { describeMutationError, formToggleCommand, prepareToggle, readField, sharedCommandFits, toggleCommand } from "../src/lib/mutations.ts";

const alpha = { id: "d_alpha00", path: "/timeline/alpha.md" };
const beta = { id: "d_beta000", path: "/timeline/beta.md" };
const BARE: RefForm = { kind: "path", rooted: false, md: true };

/** One document whose frontmatter the fake server moves on every apply. */
class FakeDoc {
  rev = "r_1";
  applies: ApplyRequest[] = [];
  reads: { path: string; repo: unknown }[] = [];
  constructor(public frontmatter: Record<string, unknown>) {}
  client(): CommandClient {
    return {
      docsRead: async (loc: { _path?: string }, opts: { repo?: unknown } = {}) => {
        this.reads.push({ path: loc._path ?? "", repo: opts.repo });
        return { _id: alpha.id, _path: alpha.path, rev: this.rev, properties: { frontmatter: { ...this.frontmatter }, inline: {}, computed: {} }, _raw: "" } satisfies DocsReadResult;
      },
      apply: async (req: ApplyRequest) => {
        this.applies.push(req);
        for (const e of req.effects) {
          if (e.op === "set" && e.field.startsWith("_frontmatter.")) this.frontmatter[e.field.slice(13)] = e.value;
          if (e.op === "unset" && e.field.startsWith("_frontmatter.")) delete this.frontmatter[e.field.slice(13)];
        }
        const n = this.applies.length;
        this.rev = `r_${n + 1}`;
        return { plan_id: `p_${n}`, commit: `c_${n}`, revisions: [{ _id: alpha.id, _path: alpha.path, _hash: `H${n}` }], new_ids: {}, committed: true, summary: [] } satisfies Receipt;
      },
      query: () => Promise.reject(new Error("unused")),
      call: () => Promise.reject(new Error("unused")),
    } as unknown as CommandClient;
  }
}

describe("readField / prepareToggle", () => {
  it("reads the owner's field and revision from one docs_read (rooted path, the repo passed through)", async () => {
    const doc = new FakeDoc({ after: ["/timeline/kickoff.md"] });
    const c = doc.client();
    expect(await readField(c, { path: "timeline/alpha.md" }, "after", "notes")).toEqual({ value: ["/timeline/kickoff.md"], existed: true, revision: "r_1" });
    expect(await readField(c, alpha, "before", null)).toEqual({ value: undefined, existed: false, revision: "r_1" });
    expect(doc.reads).toEqual([{ path: "/timeline/alpha.md", repo: "notes" }, { path: "/timeline/alpha.md", repo: null }]);
  });

  it("names the patch against the CURRENT value: a stale belief is a noop, not a wrong write", async () => {
    const doc = new FakeDoc({ after: ["/timeline/beta.md"] });
    const add = await prepareToggle(doc.client(), { owner: alpha, target: beta, field: "after", present: false, form: DEFAULT_FORM, options: { shape: "list", emptyListBehavior: "unset" } });
    expect(add.patch).toEqual({ kind: "noop", reason: "already present" });
    expect(add.revision).toBe("r_1");
    const remove = await prepareToggle(doc.client(), { owner: alpha, target: beta, field: "after", present: true, form: DEFAULT_FORM, options: { shape: "list", emptyListBehavior: "unset" } });
    expect(remove.patch).toEqual({ kind: "unset" });
  });
});

describe("sharedCommandFits", () => {
  it("only a list of rooted .md paths with an emptied list unset is a shared attach / detach", () => {
    expect(sharedCommandFits(DEFAULT_FORM, "list", "unset")).toBe(true);
    expect(sharedCommandFits(DEFAULT_FORM, "scalar", "unset")).toBe(false);
    expect(sharedCommandFits(DEFAULT_FORM, "list", "keep")).toBe(false);
    expect(sharedCommandFits(BARE, "list", "unset")).toBe(false);
    expect(sharedCommandFits(ID_FORM, "list", "unset")).toBe(false);
  });
});

describe("toggleCommand — the shared case", () => {
  it("attach appends the rooted path pinned to the revision, undo restores the previous list, redo re-reads", async () => {
    const doc = new FakeDoc({ after: ["/timeline/kickoff.md"] });
    const log = new CommandLog({ client: doc.client() });
    const entry = await log.run(toggleCommand({ owner: alpha, target: beta, field: "after", present: false, form: DEFAULT_FORM, shape: "list", emptyListBehavior: "unset", repo: "notes" }));
    expect(entry.state).toBe("applied");
    expect(entry.label).toBe("add /timeline/beta.md to `after` of /timeline/alpha.md");
    expect(doc.applies[0]!.effects).toEqual([{ op: "set", target: { kind: "document", _path: "/timeline/alpha.md" }, field: "_frontmatter.after", value: ["/timeline/kickoff.md", "/timeline/beta.md"], expect: { revision: "r_1" } }]);
    expect(doc.applies[0]!.repo).toBe("notes");
    const undone = await log.undo();
    expect(undone?.state).toBe("undone");
    expect(doc.frontmatter.after).toEqual(["/timeline/kickoff.md"]);
    expect(doc.applies[1]!.effects[0]).toMatchObject({ op: "set", value: ["/timeline/kickoff.md"], expect: { revision: "r_2" } });
    const redone = await log.redo();
    expect(redone?.state).toBe("applied");
    expect(doc.frontmatter.after).toEqual(["/timeline/kickoff.md", "/timeline/beta.md"]);
  });

  it("detach removes the path (unset when the list empties) and fails before writing when it is not there", async () => {
    const doc = new FakeDoc({ after: ["/timeline/beta.md"] });
    const log = new CommandLog({ client: doc.client() });
    const entry = await log.run(toggleCommand({ owner: alpha, target: beta, field: "after", present: true, form: DEFAULT_FORM, shape: "list", emptyListBehavior: "unset" }));
    expect(entry.state).toBe("applied");
    expect(entry.label).toBe("remove /timeline/beta.md from `after` of /timeline/alpha.md");
    expect(doc.applies[0]!.effects[0]).toMatchObject({ op: "unset", field: "_frontmatter.after", expect: { revision: "r_1" } });
    expect("after" in doc.frontmatter).toBe(false);
    const again = await log.run(toggleCommand({ owner: alpha, target: beta, field: "after", present: true, form: DEFAULT_FORM, shape: "list", emptyListBehavior: "unset" }));
    expect(again.state).toBe("failed");
    expect(String((again.error as Error).message)).toMatch(/absent; nothing names/);
    expect(doc.applies).toHaveLength(1);
  });
});

describe("formToggleCommand — this demo's own cases", () => {
  it("a bare-path field gets the bare spelling (the shared command would write a rooted one)", async () => {
    const doc = new FakeDoc({ after: ["timeline/kickoff.md"] });
    const log = new CommandLog({ client: doc.client() });
    const entry = await log.run(toggleCommand({ owner: alpha, target: beta, field: "after", present: false, form: BARE, shape: "list", emptyListBehavior: "unset" }));
    expect(entry.state).toBe("applied");
    expect(entry.label).toBe("add /timeline/beta.md to `after` of /timeline/alpha.md (as path.md)");
    expect(doc.frontmatter.after).toEqual(["timeline/kickoff.md", "timeline/beta.md"]);
    expect(doc.applies[0]!.effects[0]).toMatchObject({ expect: { revision: "r_1" } });
  });

  it("a scalar field is replaced, and unset on remove; undo puts the previous scalar back", async () => {
    const doc = new FakeDoc({ owner: "/people/zoe.md" });
    const log = new CommandLog({ client: doc.client() });
    const set = await log.run(formToggleCommand({ owner: alpha, target: { id: "d_yusuf00", path: "/people/yusuf.md" }, field: "owner", present: false, form: DEFAULT_FORM, shape: "scalar", emptyListBehavior: "unset" }));
    expect(set.state).toBe("applied");
    expect(set.label).toMatch(/\(a scalar field\)$/);
    expect(doc.frontmatter.owner).toBe("/people/yusuf.md");
    const undone = await log.undo();
    expect(undone?.state).toBe("undone");
    expect(doc.frontmatter.owner).toBe("/people/zoe.md");
    const remove = await log.run(formToggleCommand({ owner: alpha, target: { id: "d_zoe0000", path: "/people/zoe.md" }, field: "owner", present: true, form: DEFAULT_FORM, shape: "scalar", emptyListBehavior: "unset" }));
    expect(remove.state).toBe("applied");
    expect("owner" in doc.frontmatter).toBe(false);
    await log.undo();
    expect(doc.frontmatter.owner).toBe("/people/zoe.md");
  });

  it("an emptied list kept as [] (the setting), and an id-form field gets ids", async () => {
    const doc = new FakeDoc({ after: [beta.id] });
    const log = new CommandLog({ client: doc.client() });
    const entry = await log.run(toggleCommand({ owner: alpha, target: beta, field: "after", present: true, form: ID_FORM, shape: "list", emptyListBehavior: "keep" }));
    expect(entry.state).toBe("applied");
    expect(doc.frontmatter.after).toEqual([]);
    const add = await log.run(toggleCommand({ owner: alpha, target: beta, field: "after", present: false, form: ID_FORM, shape: "list", emptyListBehavior: "keep" }));
    expect(add.state).toBe("applied");
    expect(doc.frontmatter.after).toEqual([beta.id]);
  });

  it("a stale belief fails before writing; a field a key the write created is unset on undo", async () => {
    const doc = new FakeDoc({});
    const log = new CommandLog({ client: doc.client() });
    const noop = await log.run(formToggleCommand({ owner: alpha, target: beta, field: "after", present: true, form: BARE, shape: "list", emptyListBehavior: "unset" }));
    expect(noop.state).toBe("failed");
    expect((noop.error as Error).message).toMatch(/unchanged — nothing to remove/);
    expect(doc.applies).toHaveLength(0);
    const add = await log.run(formToggleCommand({ owner: alpha, target: beta, field: "after", present: false, form: BARE, shape: "list", emptyListBehavior: "unset" }));
    expect(add.state).toBe("applied");
    expect(doc.frontmatter.after).toEqual(["timeline/beta.md"]);
    await log.undo();
    expect("after" in doc.frontmatter).toBe(false);
  });

  it("undo refuses when the field no longer holds what the write produced — nothing is overwritten", async () => {
    const doc = new FakeDoc({ after: ["timeline/kickoff.md"] });
    const log = new CommandLog({ client: doc.client() });
    await log.run(formToggleCommand({ owner: alpha, target: beta, field: "after", present: false, form: BARE, shape: "list", emptyListBehavior: "unset" }));
    doc.frontmatter.after = ["timeline/kickoff.md", "timeline/beta.md", "timeline/gamma.md"]; // someone else edited
    const undone = await log.undo();
    expect(undone?.state).toBe("refused");
    expect(undone?.refusal).toMatch(/no longer holds the value this command wrote/);
    expect(doc.applies).toHaveLength(1);
  });
});

describe("describeMutationError", () => {
  it("names the gateway allowlist for a refusal, says to retry for a stale revision, passes the rest through", () => {
    expect(describeMutationError(new Error("Tool apply not allowed"))).toMatch(/tool allowlist must include apply/);
    expect(describeMutationError(new Error("MCP error -32601: unknown tool docs_read"), "docs_read")).toMatch(/must include docs_read/);
    expect(describeMutationError(Object.assign(new Error("document d_x is at revision r_2, not r_1; re-plan"), { code: "stale_plan" }))).toMatch(/changed since it was read/);
    expect(describeMutationError(new Error("boom"))).toBe("boom");
  });
});
