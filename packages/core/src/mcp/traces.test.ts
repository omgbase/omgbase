import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { buildServer } from "./server.js";

// Executable trace suite (06 §7, 07 task 6.3). A scripted agent drives the real
// MCP server over an in-memory transport against a fixture vault; each trace
// must complete within its turn budget (turns == tool calls here).

let dir: string;
let store: Store;
let repoId: string;
let client: Client;
let turns = 0;

async function connect(): Promise<void> {
  const server = buildServer({ store, repoId, rootPath: dir });
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "trace", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
}
// Trace assertions read arbitrary JSON tool-result fields. A dynamic accessor
// keeps property reads ergonomic without `any`; each read is cast at the site.
type Json = { [k: string]: unknown };
async function call(name: string, args: Record<string, unknown>): Promise<{ payload: Json; isError: boolean }> {
  turns++;
  const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { payload: JSON.parse(r.content[0]!.text) as Json, isError: r.isError ?? false };
}
const arr = (v: unknown): unknown[] => v as unknown[];
const obj = (v: unknown): Json => v as Json;
function save(path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-trace-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "vault", dir);
  turns = 0;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("trace suite", () => {
  it("T1 — move a decision from Open Questions into Decisions (≤ 2 turns)", async () => {
    save("proj.md", "# Project\n\n## Open Questions\n\nshould identity be engine-local\n\n## Decisions\n\nuse sqlite for storage\n");
    await connect();
    // 1. read to get the block ids inline (no alias table anymore)
    const { payload: read } = await call("docs_read", { _path: "proj.md", include_ids: true });
    const ids = read.ids as string[];
    const qId = ids.find((id) => {
      const row = store.db.prepare("SELECT text FROM blocks WHERE block_id=?").get(id) as { text: string } | undefined;
      return row?.text.startsWith("should identity");
    })!;
    const decHeading = ids.find((id) => {
      const row = store.db.prepare("SELECT text, type FROM blocks WHERE block_id=?").get(id) as { text: string; type: string } | undefined;
      return row?.type === "heading" && row.text === "Decisions";
    })!;
    // 2. apply the move
    const { payload: res } = await call("apply", {
      effects: [{ op: "move", targets: [{ kind: "block", _id: qId }], into: { kind: "section", heading_id: decHeading }, at: "end" }],
      reason: "promote decision",
    });
    expect(res.committed).toBe(true);
    expect(turns).toBeLessThanOrEqual(2);
    const text = readFileSync(join(dir, "proj.md"), "utf8");
    expect(text.indexOf("should identity")).toBeGreaterThan(text.indexOf("## Decisions"));
  });

  it("T2 — complete unchecked tasks under a heading (≤ 2 turns)", async () => {
    save("tasks.md", "# Work\n\n## Launch\n\n- [ ] deploy the service now\n- [ ] write the launch docs\n");
    await connect();
    const { payload: q } = await call("query", { query: 'from blocks where _type == "task" && !_attrs.checked && under_heading("Launch")' });
    const hits = q.hits as { _id: string }[];
    expect(hits.length).toBe(2);
    const { payload: res } = await call("blocks_check", { _ids: hits.map((h) => h._id) });
    expect(res.committed).toBe(true);
    expect(turns).toBeLessThanOrEqual(2);
    expect(readFileSync(join(dir, "tasks.md"), "utf8")).toContain("- [x] deploy");
  });

  it("T3 — what changed (1 turn)", async () => {
    save("a.md", "# A\n");
    save("b.md", "# B\n");
    await connect();
    const { payload } = await call("changes_since", { cursor: 0 });
    expect(arr(payload.digests).length).toBe(2);
    expect(turns).toBe(1);
  });

  it("T4 — which docs reference a doc (1 turn)", async () => {
    save("target.md", "# Target\n");
    save("src.md", "# Src\n\ncites [target](/target.md) in this paragraph\n");
    await connect();
    // Backlinks via OQX `follow _in_links collect { from _doc }`: seed the target, walk incoming edges.
    const { payload } = await call("query", { query: 'from docs where _path == "target.md" follow _in_links collect { from _doc }' });
    expect((arr(payload.hits) as { _path: string }[]).map((h) => h._path)).toContain("/src.md");
    expect(turns).toBe(1);
  });

  it("T8 — plan the retarget, then links_retarget commits (≤ 2 turns)", async () => {
    save("l.md", "# L\n\nsee [old](/old.md) here\n");
    await connect();
    const { payload: preview } = await call("plan", { effects: [{ op: "retarget", repairs: [{ from: "/old.md", to: "/new.md" }] }] });
    const retarget = (preview.preview as { retarget: { hits: unknown[] }[] }).retarget[0]!;
    expect(arr(retarget.hits).length).toBe(1);
    const { payload: applied } = await call("links_retarget", { from_target: "/old.md", to_target: "/new.md" });
    expect(applied.committed).toBe(true);
    expect(arr(applied.hits).length).toBe(1);
    expect(turns).toBeLessThanOrEqual(2);
    expect(readFileSync(join(dir, "l.md"), "utf8")).toContain("/new.md");
  });

  it("conflict carries current truth (retry-from-error)", async () => {
    save("c.md", "# C\n\nbody paragraph to edit\n");
    await connect();
    const bId = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id=(SELECT doc_id FROM docs WHERE path='c.md') AND text LIKE 'body%'").get() as { block_id: string }).block_id;
    const { payload, isError } = await call("apply", {
      effects: [{ op: "set", target: { kind: "block", _id: bId }, field: "markdown", value: "new", expect: { content_hash: "deadbeef" } }],
    });
    expect(isError).toBe(true);
    expect(payload.error).toBe("stale_expectation");
    expect(obj(payload.data).current).toBeTruthy(); // current truth attached
  });
});
