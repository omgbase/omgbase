import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { buildServer } from "./server.js";

// spec/surface §4 (4.0): `docs_update { id?, path?, content, reason? }` is sugar
// for `apply { effects: [set content] }` and returns the Receipt; the plan-only
// call is `plan` over the same effect, whose `preview.identity[<doc>]` carries
// the whole-document planner's annotations (the 3.x `{ opset, plan }` result).

let store: Store; let repoId: string; let client: Client; let dir: string;

async function connect(): Promise<void> {
  const server = buildServer({ store, repoId, rootPath: dir });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
}
function call(name: string, args: Record<string, unknown>): Promise<{ payload: unknown; isError: boolean }> {
  return client.callTool({ name, arguments: args }).then((r) => {
    const res = r as { content: { text: string }[]; isError?: boolean };
    return { payload: JSON.parse(res.content[0]!.text), isError: res.isError ?? false };
  });
}

const DOC = "# Risks\n\nStable identity is a genuinely hard engineering problem here.\n\nA second paragraph with its own separate content to keep.\n";
const EDITED = "# Risks\n\nStable identity is a genuinely hard engineering problem indeed.\n\nA second paragraph with its own separate content to keep.\n";
const setContent = (content: string) => [{ op: "set", target: { kind: "document", path: "notes.md" }, field: "content", value: content }];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-update-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
  writeFileSync(join(dir, "notes.md"), DOC);
  processCheckpoint(store, repoId, dir, [{ path: "notes.md" }]);
  await connect();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("MCP docs_update (set-content sugar, 4.0)", () => {
  it("plan { set content } is the inspectable plan: preview.identity carries the opset's annotations, nothing is written", async () => {
    const { payload, isError } = await call("plan", { effects: setContent(EDITED) });
    expect(isError).toBe(false);
    const p = payload as { effects: { target: { id: string } }[]; opset: { ops: unknown[] }; preview: { identity: Record<string, { matcher_v: string; summary: { updated: number; preserved: number }; ops: { op_index: number; disposition: string; blocks: string[] }[]; diagnostics: string[] }> } };
    const docId = p.effects[0]!.target.id;
    const identity = p.preview.identity[docId]!;
    expect(identity.matcher_v).toMatch(/^m/);
    expect(identity.summary.updated).toBe(1);
    expect(identity.ops.map((o) => o.disposition)).toEqual(["edited"]);
    expect(identity.ops[0]!.op_index).toBe(0);
    expect(p.opset.ops).toHaveLength(1);
    expect(identity.diagnostics).toEqual([]);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(DOC);
  });

  it("docs_update commits as one api commit and returns the Receipt, preserving the untouched paragraph's id", async () => {
    const kept = (store.db.prepare("SELECT block_id FROM blocks WHERE text LIKE 'A second paragraph%'").get() as { block_id: string }).block_id;
    const { payload, isError } = await call("docs_update", { path: "notes.md", content: EDITED, reason: "refine risks intro" });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ plan_id: expect.stringMatching(/^[0-9a-f]{64}$/), commit: expect.stringMatching(/^c_/), revisions: [{ path: "/notes.md" }], new_ids: {}, committed: true });
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(EDITED);
    const keptAfter = (store.db.prepare("SELECT block_id FROM blocks WHERE text LIKE 'A second paragraph%'").get() as { block_id: string }).block_id;
    expect(keptAfter).toBe(kept);
    const commit = store.db.prepare("SELECT reason, actor, ops FROM commits WHERE origin = 'api'").get() as { reason: string; actor: string; ops: string };
    expect(commit.reason).toBe("refine risks intro");
    expect(commit.actor).toBe("agent:mcp");
    expect(commit.ops).toMatch(/"field":"content"/);
  });

  it("content that already equals the document is a plan with nothing to do: no commit, committed: true", async () => {
    const { payload, isError } = await call("docs_update", { path: "notes.md", content: DOC });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ commit: null, revisions: [], new_ids: {}, committed: true });
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });

  it("dry_run is no longer an argument; a missing document is doc_missing; non-convergent content is plan_not_convergent", async () => {
    const missing = await call("docs_update", { path: "nope.md", content: "x" });
    expect(missing.payload).toMatchObject({ error: "doc_missing" });
    const nc = await call("docs_update", { path: "notes.md", content: "\n" + DOC });
    expect(nc.payload).toMatchObject({ error: "plan_not_convergent" });
    expect((nc.payload as { data: Record<string, unknown> }).data.effect_index).toBeUndefined();
  });
});
