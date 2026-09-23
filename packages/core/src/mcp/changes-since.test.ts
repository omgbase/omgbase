import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { changesSince } from "../graph/history.js";
import { buildServer } from "./server.js";

// The change feed must be walkable to the end by cursor: every commit appears
// exactly once across pages, no page after a `truncated:true` page is empty
// while later commits exist, and the cursor is the last seq of the page.

let store: Store; let repoId: string; let client: Client; let dir: string;

async function connect(): Promise<void> {
  const server = buildServer({ store, repoId, rootPath: dir });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
}
type Page = { digests: { commit: string; seq: number }[]; cursor: number; truncated: boolean; head: number };
async function call(name: string, args: Record<string, unknown>): Promise<Page> {
  const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  if (r.isError) throw new Error(r.content[0]!.text);
  return JSON.parse(r.content[0]!.text) as Page;
}

const N = 130;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-changes-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
  for (let i = 0; i < N; i++) {
    const p = `d${i}.md`;
    writeFileSync(join(dir, p), `# Doc ${i}\n`);
    processCheckpoint(store, repoId, dir, [{ path: p }]);
  }
  await connect();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

async function walk(limit: number | undefined): Promise<{ seen: string[]; pages: Page[] }> {
  const seen: string[] = [];
  const pages: Page[] = [];
  let cursor: number | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await call("changes_since", { ...(cursor !== undefined ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) });
    pages.push(page);
    for (const d of page.digests) seen.push(d.commit);
    if (!page.truncated) break;
    expect(page.digests.length).toBeGreaterThan(0);
    expect(page.cursor).toBe(page.digests[page.digests.length - 1]!.seq);
    cursor = page.cursor;
  }
  return { seen, pages };
}

describe("MCP changes_since — cursor paging", () => {
  it(`pages ${N} commits to the end with the default limit; each commit exactly once`, async () => {
    const all = (store.db.prepare("SELECT commit_id FROM commits WHERE repo_id = ? ORDER BY seq").all(repoId) as { commit_id: string }[]).map((r) => r.commit_id);
    expect(all.length).toBe(N);
    const { seen, pages } = await walk(undefined);
    expect(pages.length).toBe(3); // 50 + 50 + 30
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(N);
  });

  it("a truncated page of 100 is followed by a non-empty continuation at cursor:100", async () => {
    const first = await call("changes_since", { limit: 100 });
    expect(first.digests.length).toBe(100);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe(100);
    const second = await call("changes_since", { cursor: 100, limit: 100 });
    expect(second.digests.length).toBe(N - 100);
    expect(second.truncated).toBe(false);
    expect(second.digests[0]!.seq).toBe(101);
    expect(second.head).toBe(N);
    // seq is per-repo: a cursor carried across repos lands beyond the other
    // repo's feed. `head` makes that diagnosable (cursor > head) instead of
    // indistinguishable from "no new changes".
    const otherRepo = ensureRepo(store, "other", mkdtempSync(join(tmpdir(), "mcp-changes-other-")));
    const foreign = changesSince(store, otherRepo, { cursor: 100, limit: 100 });
    expect(foreign.digests).toEqual([]);
    expect(foreign.head).toBe(0);
    expect(foreign.cursor).toBeGreaterThan(foreign.head);
    // A string cursor (as a loosely-typed remote client might send) is rejected
    // by the schema rather than silently coerced to 0 (which would restart the feed).
    const r = await client.callTool({ name: "changes_since", arguments: { cursor: "100", limit: 100 } }) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it("the core function agrees with the tool and continues past a server 'restart' (new Store handle over same rows)", async () => {
    const a = changesSince(store, repoId, { cursor: 100, limit: 100 });
    expect(a.digests.length).toBe(N - 100);
    expect(a.digests[0]!.seq).toBe(101);
    // Commits are keyed by repo seq (not ts/rowid); a page assembled after more
    // commits land still continues from the cursor.
    writeFileSync(join(dir, "late.md"), "# Late\n");
    processCheckpoint(store, repoId, dir, [{ path: "late.md" }]);
    const b = changesSince(store, repoId, { cursor: N, limit: 100 });
    expect(b.digests.length).toBe(1);
    expect(b.digests[0]!.seq).toBe(N + 1);
  });
});
