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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-update-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
  writeFileSync(join(dir, "notes.md"), "# Risks\n\nStable identity is a genuinely hard engineering problem here.\n\nA second paragraph with its own separate content to keep.\n");
  processCheckpoint(store, repoId, dir, [{ path: "notes.md" }]);
  await connect();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("MCP docs_plan_update / docs_update", () => {
  it("docs_plan_update returns an inspectable opset without writing", async () => {
    const before = readFileSync(join(dir, "notes.md"), "utf8");
    const { payload, isError } = await call("docs_plan_update", {
      doc: "notes.md",
      content: "# Risks\n\nStable identity is a genuinely hard engineering problem indeed.\n\nA second paragraph with its own separate content to keep.\n",
    });
    expect(isError).toBe(false);
    const p = payload as { opset: { converges: boolean; ops: unknown[]; summary: { updated: number } }; plan: string };
    expect(p.opset.converges).toBe(true);
    expect(p.opset.summary.updated).toBe(1);
    expect(typeof p.plan).toBe("string");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(before); // nothing written
  });

  it("docs_update commits, preserving the untouched paragraph's id", async () => {
    const kept = (store.db.prepare("SELECT block_id FROM blocks WHERE text LIKE 'A second paragraph%'").get() as { block_id: string }).block_id;
    const { isError } = await call("docs_update", {
      doc: "notes.md",
      content: "# Risks\n\nStable identity is a genuinely hard engineering problem indeed.\n\nA second paragraph with its own separate content to keep.\n",
      reason: "refine risks intro",
    });
    expect(isError).toBe(false);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toContain("hard engineering problem indeed.");
    const keptAfter = (store.db.prepare("SELECT block_id FROM blocks WHERE text LIKE 'A second paragraph%'").get() as { block_id: string }).block_id;
    expect(keptAfter).toBe(kept);
  });

  it("docs_update dry_run previews and writes nothing", async () => {
    const before = readFileSync(join(dir, "notes.md"), "utf8");
    const { payload } = await call("docs_update", {
      doc: "notes.md",
      content: "# Risks\n\nOnly one paragraph remains now after this whole-document update.\n",
      dry_run: true,
    });
    const p = payload as { opset: { converges: boolean }; result: unknown };
    expect(p.opset.converges).toBe(true);
    expect(p.result).toBeNull();
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(before);
  });
});
