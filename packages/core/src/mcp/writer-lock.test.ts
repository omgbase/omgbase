import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { freshnessSweep, rebuildFileStats } from "../sync/freshness.js";
import { writerLockFree, writerLockHeld, type WriterLockOptions } from "../sync/writer-lock.js";
import { buildServer, WRITE_TOOLS } from "./server.js";

// The tool-boundary writer lock (spec/sync §7): with `omgbaseDir` in the
// context every write tool takes the workspace writer lock for its whole call
// and releases it afterwards, a read never touches it, and a lock a live
// foreign holder keeps surfaces as the tool's error envelope — the behaviour of
// the Rust host (`crates/omgbase/src/mcp.rs`,
// `write_tools_take_and_release_the_writer_lock`).

const SEED = "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n";

let root: string | undefined;
let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A real workspace: a working tree with the seed file, its `.omgbase/` dir, a store, and a connected server. */
async function workspace(opts: { writerLock?: WriterLockOptions; onMutation?: () => void } = {}): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<{ payload: Record<string, unknown>; isError: boolean }>; omgbaseDir: string; repoId: string; store: Store; root: string }> {
  root = mkdtempSync(join(tmpdir(), "omg-mcp-lock-"));
  const omgbaseDir = join(root, ".omgbase");
  writeFileSync(join(root, "notes.md"), SEED);
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", root);
  ingestFile(store, repoId, "notes.md", SEED);
  const server = buildServer({ store, repoId, rootPath: root, omgbaseDir, ...opts });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { payload: JSON.parse(r.content[0]!.text) as Record<string, unknown>, isError: r.isError ?? false };
  };
  return { call, omgbaseDir, repoId, store, root };
}

describe("MCP write tools under the workspace writer lock", () => {
  it("WRITE_TOOLS is the Rust catalog's `is_write_tool` list, and every name is a registered tool", async () => {
    // Mirrors crates/omgbase-surface/src/catalog.rs — change both or neither.
    expect([...WRITE_TOOLS].sort()).toEqual([
      "apply", "blocks_insert", "blocks_update", "blocks_move", "blocks_remove", "blocks_split", "blocks_merge", "blocks_check",
      "nodes_set", "blocks_append", "docs_append", "links_retarget", "links_repair",
      "docs_create", "docs_move", "docs_delete", "docs_set_meta", "docs_update",
      "observe", "observe_many", "observe_delete",
    ].sort());
    store = new Store({ path: ":memory:" });
    const server = buildServer({ store, repoId: ensureRepo(store, "t", null) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const w of WRITE_TOOLS) expect(names, `${w} is not a registered tool`).toContain(w);
    for (const r of ["docs_read", "docs_list", "query", "links_stale", "changes_since", "version"]) expect(WRITE_TOOLS.has(r)).toBe(false);
  });

  it("a write tool takes the lock for the whole call and releases it afterwards", async () => {
    let seen: { held: boolean; file: boolean } | null = null;
    const ws = await workspace({
      // `onMutation` fires on the response path INSIDE the handler, i.e. inside the lock.
      onMutation: () => { seen = { held: writerLockHeld(ws.omgbaseDir), file: existsSync(join(ws.omgbaseDir, "writer.lock")) }; },
    });
    expect(writerLockHeld(ws.omgbaseDir)).toBe(false);
    const { payload, isError } = await ws.call("docs_create", { path: "a.md", markdown: "# A\n" });
    expect(isError).toBe(false);
    expect(payload.path).toBe("/a.md");
    expect(seen).toEqual({ held: true, file: true });
    expect(writerLockHeld(ws.omgbaseDir)).toBe(false);
    expect(writerLockFree(ws.omgbaseDir)).toBe(true);
    expect(existsSync(join(ws.omgbaseDir, "writer.lock"))).toBe(false);
    // The kernel's inner lock (apply's commit phase) re-enters the tool's: one
    // acquire, and the same outcome for a block-level write.
    seen = null;
    const r2 = await ws.call("docs_append", { path: "notes.md", text: "more\n" });
    expect(r2.isError).toBe(false);
    expect(seen).toEqual({ held: true, file: true });
    expect(existsSync(join(ws.omgbaseDir, "writer.lock"))).toBe(false);
  });

  it("a failing write releases the lock too (a sourceless-style failure inside the handler)", async () => {
    const ws = await workspace();
    const { payload, isError } = await ws.call("docs_create", { path: "notes.md", markdown: "# x\n" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("path_taken");
    expect(writerLockFree(ws.omgbaseDir)).toBe(true);
    expect(existsSync(join(ws.omgbaseDir, "writer.lock"))).toBe(false);
  });

  it("a read tool never touches the lock directory", async () => {
    const ws = await workspace();
    expect(existsSync(ws.omgbaseDir)).toBe(false); // nothing has created it yet
    const { isError } = await ws.call("docs_list", {});
    expect(isError).toBe(false);
    const q = await ws.call("query", { query: "from docs" });
    expect(q.isError).toBe(false);
    expect(existsSync(ws.omgbaseDir)).toBe(false); // a write would mkdir it for the lock file
  });

  it("the MCP write path records the freshness stat cache like the CLI path (omgbaseDir reaches the kernel)", async () => {
    const ws = await workspace();
    rebuildFileStats(ws.store, ws.repoId, ws.root);
    const stats = () => (ws.store.db.prepare("SELECT path FROM file_stats WHERE repo_id = ? ORDER BY path").all(ws.repoId) as { path: string }[]).map((r) => r.path);
    expect(stats()).toEqual(["notes.md"]);
    expect((await ws.call("docs_create", { path: "b.md", markdown: "# B\n" })).isError).toBe(false);
    expect((await ws.call("docs_set_meta", { path: "notes.md", set: { status: "active" } })).isError).toBe(false);
    expect((await ws.call("docs_move", { path: "b.md", to_path: "c.md" })).isError).toBe(false);
    expect(stats()).toEqual(["c.md", "notes.md"]); // the moved path's old row is gone, the new one recorded
    // The sweep that follows sees the engine's own writes as fresh: nothing to re-ingest.
    const swept = freshnessSweep(ws.store, ws.repoId, ws.root);
    expect(swept.changed).toBe(false);
    expect(swept.ingested).toEqual([]);
    expect(swept.candidates).toBe(0);
  });

  it("a lock held by a live foreign holder surfaces as the error envelope — `repo_not_found`, the Rust host's `SurfaceError::other`", async () => {
    const ws = await workspace({ writerLock: { timeoutMs: 80, pollMs: 10 } });
    // A record naming a live pid cannot be stolen; written by hand it is not in
    // this process's re-entrancy set, so it is "another process".
    mkdirSync(ws.omgbaseDir, { recursive: true });
    writeFileSync(join(ws.omgbaseDir, "writer.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));

    const { payload, isError } = await ws.call("docs_create", { path: "blocked.md", markdown: "# B\n" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("repo_not_found");
    expect(payload.message).toMatch(/^could not acquire writer lock .*writer\.lock \(held by pid \d+\)$/); // the Rust host's exact text
    expect(payload.retriable).toBe(false);
    expect(existsSync(join(ws.root, "blocked.md"))).toBe(false); // nothing was written while blocked

    // A dry run is a write for the lock's purposes (Rust `is_write_tool`): it waits too.
    const dry = await ws.call("docs_create", { path: "blocked.md", markdown: "# B\n", dry_run: true });
    expect(dry.isError).toBe(true);
    expect(dry.payload.error).toBe("repo_not_found");
    expect(dry.payload.message).toMatch(/^could not acquire writer lock/);

    // Reads are unaffected by the held lock.
    const read = await ws.call("docs_read", { path: "notes.md" });
    expect(read.isError).toBe(false);

    // The foreign holder's record is left alone (never stolen) …
    expect(writerLockFree(ws.omgbaseDir)).toBe(false);
    // … and once it goes away the same call succeeds.
    rmSync(join(ws.omgbaseDir, "writer.lock"));
    const ok = await ws.call("docs_create", { path: "blocked.md", markdown: "# B\n" });
    expect(ok.isError).toBe(false);
    expect(existsSync(join(ws.root, "blocked.md"))).toBe(true);
    expect(existsSync(join(ws.omgbaseDir, "writer.lock"))).toBe(false);
  });
});
