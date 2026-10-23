import { describe, expect, it } from "vitest";
import { OmgClient, OmgError, type ApplyRequest, type QueryResult, type Receipt } from "./client.js";
import {
  CommandLog, PartialFailure, frontmatterCommand, localCommand, taskCheckCommand,
  type Applied, type CommandClient, type CommandContext, type LogEvent, type RepositoryCommand,
} from "./commands.js";
import { setBlockAttr } from "./effects.js";
import { FakeServer } from "./fake-server.test-support.js";

/** A client stub: `apply` records requests and answers a receipt; `query` answers block hashes from a mutable map. */
function stubClient(hashes: Record<string, string>, opts: { applyFails?: (req: ApplyRequest) => unknown } = {}) {
  const applied: ApplyRequest[] = [];
  const queries: string[] = [];
  let n = 0;
  const client: CommandClient = {
    async apply(req) {
      const fail = opts.applyFails?.(req);
      if (fail) throw fail;
      applied.push(req);
      // A checked write moves the block's hash, as the engine would.
      for (const e of req.effects) if (e.op === "set" && typeof e.target === "object" && "kind" in e.target && e.target.kind === "block") hashes[e.target._id] = `h_${++n + 10}`;
      const receipt: Receipt = { plan_id: `p_${n}`, commit: `c_${n}`, revisions: [{ _id: "d_1", _path: "/a.md", _hash: `x_${n}` }], new_ids: {}, committed: true, summary: [] };
      return receipt;
    },
    async query(q) {
      queries.push(q);
      const m = /_id == "([^"]+)"/.exec(q);
      const id = m?.[1] ?? "";
      const hits = hashes[id] !== undefined ? [{ _id: id, _path: "/a.md", _hash: hashes[id] }] : [];
      return { hits, truncated: false, cursor: null, consumer: "collect" } satisfies QueryResult;
    },
    docsRead: async () => { throw new Error("not in this stub"); },
    call: async () => { throw new Error("not in this stub"); },
  };
  return { client, applied, queries, hashes };
}

function ticker() {
  let t = 0;
  return () => `t${++t}`;
}

describe("local commands", () => {
  it("run/undo/redo in order, with events and states", async () => {
    const trace: string[] = [];
    const events: string[] = [];
    const log = new CommandLog({ client: stubClient({}).client }, { now: ticker(), nextId: (() => { let i = 0; return () => `id${++i}`; })() });
    log.subscribe((e: LogEvent) => events.push(`${e.type}:${e.entry?.state ?? "-"}`));
    const cmd = (name: string) => localCommand("view", name, () => { trace.push(`+${name}`); }, () => { trace.push(`-${name}`); });
    const a = await log.run(cmd("a"));
    await log.run(cmd("b"));
    expect(a).toMatchObject({ id: "id1", kind: "view", label: "a", at: "t1", state: "applied", coalesceKey: null });
    expect(log.history.map((e) => e.label)).toEqual(["a", "b"]);
    expect(log.canUndo).toBe(true);
    expect(log.canRedo).toBe(false);
    expect(log.nextUndo?.label).toBe("b");

    expect((await log.undo())?.label).toBe("b");
    expect((await log.undo())?.label).toBe("a");
    expect(await log.undo()).toBeNull();
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(true);
    expect(log.nextRedo?.label).toBe("a");
    expect((await log.redo())?.label).toBe("a");
    expect((await log.redo())?.label).toBe("b");
    expect(await log.redo()).toBeNull();
    expect(trace).toEqual(["+a", "+b", "-b", "-a", "+a", "+b"]);
    expect(log.history.map((e) => e.state)).toEqual(["applied", "applied"]);
    expect(events).toEqual(["run:applied", "run:applied", "undo:undone", "undo:undone", "redo:applied", "redo:applied"]);
  });

  it("a new run drops the redo stack; history is capped", async () => {
    const log = new CommandLog({ client: stubClient({}).client }, { limit: 3 });
    const noop = (l: string) => localCommand("query", l, () => undefined, () => undefined);
    await log.run(noop("a"));
    await log.run(noop("b"));
    await log.undo();
    expect(log.canRedo).toBe(true);
    await log.run(noop("c"));
    expect(log.canRedo).toBe(false);
    expect(log.history.map((e) => `${e.label}:${e.state}`)).toEqual(["a:applied", "b:undone", "c:applied"]);
    await log.run(noop("d"));
    await log.run(noop("e"));
    expect(log.history.map((e) => e.label)).toEqual(["c", "d", "e"]);
  });

  it("a redo() that throws marks the entry failed and leaves it off both stacks", async () => {
    const log = new CommandLog({ client: stubClient({}).client });
    let fail = false;
    await log.run(localCommand("view", "flaky", () => { if (fail) throw new Error("boom"); }, () => undefined));
    await log.undo();
    fail = true;
    const e = await log.redo();
    expect(e?.state).toBe("failed");
    expect((e?.error as Error).message).toBe("boom");
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(false);
  });
});

describe("coalescing", () => {
  it("consecutive commands sharing a coalesceKey are one entry; undo reverses every step; a different key or seal() starts a new one", async () => {
    const trace: string[] = [];
    const log = new CommandLog({ client: stubClient({}).client });
    const move = (to: number, key: string) => localCommand("view", `move to ${to}`, () => { trace.push(`→${to}`); }, () => { trace.push(`←${to}`); }, { coalesceKey: key });
    await log.run(move(1, "drag:1"));
    await log.run(move(2, "drag:1"));
    await log.run(move(3, "drag:1"));
    expect(log.history).toHaveLength(1);
    expect(log.history[0]!.steps).toHaveLength(3);
    expect(log.history[0]!.label).toBe("move to 1");
    await log.run(move(4, "drag:2"));
    expect(log.history).toHaveLength(2);
    log.seal();
    await log.run(move(5, "drag:2"));
    expect(log.history).toHaveLength(3);
    await log.undo();
    await log.undo();
    await log.undo();
    expect(trace).toEqual(["→1", "→2", "→3", "→4", "→5", "←5", "←4", "←3", "←2", "←1"]);
    await log.redo();
    expect(trace.slice(-3)).toEqual(["→1", "→2", "→3"]);
    // An entry that was undone (and redone) is sealed: it never coalesces again.
    await log.run(move(6, "drag:1"));
    expect(log.history).toHaveLength(4);
    expect(log.history[3]!.steps).toHaveLength(1);
  });

  it("does not fold across kinds or into a failed entry", async () => {
    const stub = stubClient({ b_1: "h_1" });
    const log = new CommandLog({ client: stub.client });
    await log.run(localCommand("view", "v", () => undefined, () => undefined, { coalesceKey: "k" }));
    await log.run(taskCheckCommand({ blockId: "b_1", checked: true, contentHash: "h_1", coalesceKey: "k" }));
    expect(log.history).toHaveLength(2);
    await log.run(localCommand("view", "boom", () => { throw new Error("no"); }, () => undefined, { coalesceKey: "z" }));
    await log.run(localCommand("view", "after", () => undefined, () => undefined, { coalesceKey: "z" }));
    expect(log.history.map((e) => e.state)).toEqual(["applied", "applied", "failed", "applied"]);
  });
});

describe("repository commands", () => {
  it("apply → applied with receipts and revisions; undo compensates with the CURRENT hash; redo re-reads", async () => {
    const stub = stubClient({ b_1: "h_1" });
    const log = new CommandLog({ client: stub.client });
    const entry = await log.run(taskCheckCommand({ blockId: "b_1", checked: true, contentHash: "h_1" }));
    expect(entry.state).toBe("applied");
    const applied = entry.steps[0]!.applied as Applied<{ before: string; after: string | null; checked: boolean }>;
    expect(applied.receipts).toHaveLength(1);
    expect(applied.revisions).toEqual([{ _id: "d_1", _path: "/a.md", _hash: "x_1" }]);
    expect(applied.state).toEqual({ before: "h_1", after: "h_11", checked: true });
    expect(stub.applied[0]).toEqual({ effects: [setBlockAttr("b_1", "checked", true, { contentHash: "h_1" })], reason: "check task", repo: undefined });

    const undone = await log.undo();
    expect(undone?.state).toBe("undone");
    expect(undone?.compensation?.committed).toBe(true);
    expect(stub.applied[1]!.effects).toEqual([setBlockAttr("b_1", "checked", false, { contentHash: "h_11" })]);
    expect(stub.applied[1]!.reason).toBe("undo: check b_1 — uncheck task");

    const redone = await log.redo();
    expect(redone?.state).toBe("applied");
    // The redo pinned to the hash it read now (the compensation's), not the UI's stale one.
    expect(stub.applied[2]!.effects).toEqual([setBlockAttr("b_1", "checked", true, { contentHash: "h_12" })]);
    expect(stub.queries.filter((q) => q.includes("b_1")).length).toBeGreaterThanOrEqual(3);
  });

  it("compensation refuses when the block changed since: the entry stays applied, state refused, off the undo path", async () => {
    const stub = stubClient({ b_1: "h_1" });
    const events: string[] = [];
    const log = new CommandLog({ client: stub.client });
    log.subscribe((e: LogEvent) => events.push(`${e.type}:${e.entry?.state}`));
    await log.run(taskCheckCommand({ blockId: "b_1", checked: true, contentHash: "h_1" }));
    stub.hashes.b_1 = "h_someone_else"; // another writer edited the block
    const r = await log.undo();
    expect(r?.state).toBe("refused");
    expect(r?.refusal).toMatch(/changed since/);
    expect(stub.applied).toHaveLength(1); // nothing was written
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(false);
    expect(events).toEqual(["run:applied", "undo:refused"]);
    // A block that is gone refuses too.
    const stub2 = stubClient({ b_2: "h" });
    const log2 = new CommandLog({ client: stub2.client });
    await log2.run(taskCheckCommand({ blockId: "b_2", checked: false, contentHash: "h" }));
    delete stub2.hashes.b_2;
    expect((await log2.undo())?.refusal).toMatch(/no longer exists/);
  });

  it("a stale error from the compensating apply is a refusal; any other error leaves the entry applied with the error recorded", async () => {
    let mode: "stale" | "network" | "ok" = "ok";
    const stub = stubClient({ b_1: "h_1" }, { applyFails: (req) => (req.reason?.startsWith("undo") && mode === "stale" ? new OmgError("stale_expectation", "moved", { tool: "apply" }) : req.reason?.startsWith("undo") && mode === "network" ? new TypeError("fetch failed") : undefined) });
    const log = new CommandLog({ client: stub.client });
    await log.run(taskCheckCommand({ blockId: "b_1", checked: true, contentHash: "h_1" }));
    mode = "network";
    const r1 = await log.undo();
    expect(r1?.state).toBe("applied");
    expect((r1?.error as Error).message).toBe("fetch failed");
    expect(log.canUndo).toBe(true); // retry is possible
    mode = "stale";
    const r2 = await log.undo();
    expect(r2?.state).toBe("refused");
    expect(r2?.refusal).toBe("moved");
    expect(log.canUndo).toBe(false);
  });

  it("a run whose apply throws is failed (nothing applied, not undoable); a PartialFailure is partial and undoable over what landed", async () => {
    const stub = stubClient({ b_1: "h_1" }, { applyFails: (req) => (req.reason === "forward" ? new OmgError("stale_expectation", "nope", { tool: "apply" }) : undefined) });
    const log = new CommandLog({ client: stub.client });
    const failing: RepositoryCommand<null> = {
      kind: "repository", label: "f",
      apply: async (ctx) => { const r = await ctx.client.apply({ effects: [], reason: "forward" }); return { receipts: [r], revisions: r.revisions, state: null }; },
      compensate: async () => ({ effects: [], reason: "" }),
    };
    const f = await log.run(failing);
    expect(f.state).toBe("failed");
    expect(f.steps[0]!.applied).toBeNull();
    expect((f.error as OmgError).code).toBe("stale_expectation");
    expect(log.canUndo).toBe(false);

    const progress: number[] = [];
    const ctx: CommandContext = { client: stub.client, report: (p) => progress.push(p.done) };
    const log2 = new CommandLog(ctx);
    const multi: RepositoryCommand<string[]> = {
      kind: "repository", label: "three steps",
      async apply(c) {
        const done: Receipt[] = [];
        const ids = ["b_1", "b_2", "b_3"];
        for (const [i, id] of ids.entries()) {
          if (i === 2) throw new PartialFailure({ receipts: done, revisions: done.flatMap((r) => r.revisions), state: ids.slice(0, i) }, new Error("third failed"));
          done.push(await c.client.apply({ effects: [setBlockAttr(id, "checked", true)], reason: `step ${i}` }));
          c.report?.({ label: "three steps", done: i + 1, total: 3 });
        }
        return { receipts: done, revisions: [], state: ids };
      },
      async compensate(_c, applied) {
        return { effects: applied.state.map((id) => setBlockAttr(id, "checked", false)), reason: "uncheck the ones that landed" };
      },
    };
    const p = await log2.run(multi);
    expect(p.state).toBe("partial");
    expect((p.error as Error).message).toBe("third failed");
    expect(progress).toEqual([1, 2]);
    expect(log2.canUndo).toBe(true);
    const u = await log2.undo();
    expect(u?.state).toBe("undone");
    expect(stub.applied[stub.applied.length - 1]!.effects).toEqual([setBlockAttr("b_1", "checked", false), setBlockAttr("b_2", "checked", false)]);
  });

  it("a coalesced drag undoes as ONE apply over every step's compensation, in reverse, and refuses as a whole", async () => {
    const stub = stubClient({ b_1: "h_1", b_2: "h_2" });
    const log = new CommandLog({ client: stub.client });
    await log.run(taskCheckCommand({ blockId: "b_1", checked: true, contentHash: "h_1", coalesceKey: "sweep" }));
    await log.run(taskCheckCommand({ blockId: "b_2", checked: true, contentHash: "h_2", coalesceKey: "sweep" }));
    expect(log.history).toHaveLength(1);
    expect(log.history[0]!.steps).toHaveLength(2);
    const u = await log.undo();
    expect(u?.state).toBe("undone");
    expect(stub.applied).toHaveLength(3);
    expect(stub.applied[2]!.effects.map((e) => (e as { target: { _id: string } }).target._id)).toEqual(["b_2", "b_1"]);

    const stub2 = stubClient({ b_1: "h_1", b_2: "h_2" });
    const log2 = new CommandLog({ client: stub2.client });
    await log2.run(taskCheckCommand({ blockId: "b_1", checked: true, contentHash: "h_1", coalesceKey: "sweep" }));
    await log2.run(taskCheckCommand({ blockId: "b_2", checked: true, contentHash: "h_2", coalesceKey: "sweep" }));
    stub2.hashes.b_1 = "h_edited";
    const r = await log2.undo();
    expect(r?.state).toBe("refused");
    expect(stub2.applied).toHaveLength(2);
  });

  it("serializes concurrent run/undo calls", async () => {
    const trace: string[] = [];
    const log = new CommandLog({ client: stubClient({}).client });
    const slow = (l: string) => localCommand("view", l, async () => { await new Promise((r) => setTimeout(r, 5)); trace.push(`+${l}`); }, () => { trace.push(`-${l}`); });
    await Promise.all([log.run(slow("a")), log.run(slow("b")), log.undo()]);
    expect(trace).toEqual(["+a", "+b", "-b"]);
  });
});

describe("frontmatterCommand over the fake server", () => {
  it("sets, undoes to the previous value (or absence) pinned to the current revision, refuses when the value moved", async () => {
    const server = new FakeServer();
    const client = new OmgClient({ url: "/mcp", transportFactory: server.transportFactory, repo: "notes" });
    const log = new CommandLog({ client });
    const e = await log.run(frontmatterCommand({ doc: "/plans/today.md", key: "status", value: "done" }));
    expect(e.state).toBe("applied");
    expect(server.doc("/plans/today.md").frontmatter.status).toBe("done");
    const applyCalls = () => server.calls.filter((c) => c.name === "apply");
    expect(applyCalls()[0]!.args).toEqual({ effects: [{ op: "set", target: { kind: "document", _path: "/plans/today.md" }, field: "_frontmatter.status", value: "done", expect: { revision: "r_1" } }], reason: "set status", repo: "notes" });

    const revBeforeUndo = server.doc("/plans/today.md").rev;
    const u = await log.undo();
    expect(u?.state).toBe("undone");
    expect(server.doc("/plans/today.md").frontmatter.status).toBe("open");
    const undoArgs = applyCalls()[1]!.args as { effects: { expect: { revision: string } }[] };
    expect(undoArgs.effects[0]!.expect.revision).toBe(revBeforeUndo);

    // A key that did not exist is unset on undo.
    await log.run(frontmatterCommand({ doc: { _id: "d_2" }, key: "status", value: "soon" }));
    expect(server.doc("/plans/later.md").frontmatter.status).toBe("soon");
    await log.undo();
    expect("status" in server.doc("/plans/later.md").frontmatter).toBe(false);

    // Someone else changed the value: refuse.
    await log.run(frontmatterCommand({ doc: "/plans/today.md", key: "status", value: "done" }));
    server.doc("/plans/today.md").frontmatter.status = "blocked";
    const r = await log.undo();
    expect(r?.state).toBe("refused");
    expect(r?.refusal).toMatch(/no longer holds/);
    expect(server.doc("/plans/today.md").frontmatter.status).toBe("blocked");
    await client.close();
  });

  it("taskCheckCommand over the fake server: the engine's stale guard is honoured end to end", async () => {
    const server = new FakeServer();
    const client = new OmgClient({ url: "/mcp", transportFactory: server.transportFactory });
    const log = new CommandLog({ client });
    const doc = await client.docsRead({ _path: "/plans/today.md" }, { includeIds: true });
    const e = await log.run(taskCheckCommand({ blockId: "b_1", checked: true, contentHash: doc.hashes!.b_1! }));
    expect(e.state).toBe("applied");
    expect(server.block("b_1").block.checked).toBe(true);
    server.touchBlock("b_1", "- [x] write the client, then the tests");
    const r = await log.undo();
    expect(r?.state).toBe("refused");
    expect(server.block("b_1").block.checked).toBe(true);
    // Stale UI hash on a fresh command: the engine refuses, the entry is failed.
    const f = await log.run(taskCheckCommand({ blockId: "b_2", checked: false, contentHash: "h_stale" }));
    expect(f.state).toBe("failed");
    expect((f.error as OmgError).code).toBe("stale_expectation");
    await client.close();
  });
});
