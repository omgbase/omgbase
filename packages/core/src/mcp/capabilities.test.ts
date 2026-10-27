import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { coreCapabilities } from "../core/capabilities/core.js";
import { SEMANTIC_DISABLED_FIX, SEMANTIC_DISABLED_MESSAGE } from "../core/capabilities/errors.js";
import { writeWorkspaceSettings } from "../sync/settings.js";
import { buildServer, PROVIDER_UNAVAILABLE_MESSAGE, type ServerContext } from "./server.js";

// The surface's semantic gate (modular-core Phase 2; phase-1-contracts §2.1):
// which code a semantic call gets under each composition and host state, and
// what `version` reports. The full composition with no provider keeps the
// spec-pinned `provider_unavailable` (reads::errors, interop); the core-only
// composition answers `capability_unavailable { semantic, disabled }`; a host
// whose configured embedder failed answers `{ …, unavailable }` (retriable).

const LONG = "one paragraph with plenty of words so that it comfortably clears the twenty four token minimum needed for embedding eligibility in these tests here now";

let store: Store | undefined;
let client: Client | undefined;
afterEach(async () => { await client?.close(); client = undefined; store?.close(); store = undefined; });

async function serve(opts: { core?: boolean; ctx?: Partial<ServerContext> } = {}): Promise<(name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, unknown> }>> {
  store = new Store({ path: ":memory:", ...(opts.core ? { capabilities: coreCapabilities } : {}) });
  const repoId = ensureRepo(store, "fixture", null);
  ingestFile(store, repoId, "a.md", `# A\n\n${LONG}\n`);
  const server = buildServer({ store, repoId, ...opts.ctx });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "capabilities-test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return async (name, args = {}) => {
    const r = (await client!.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) as Record<string, unknown> };
  };
}

const SEMANTIC_QUERY = 'docs { where semantic("the great work") > 0.5 }';

describe("the semantic gate at the surface", () => {
  it("full composition, no provider: provider_unavailable (the spec-pinned 3.0 code, the alias of disabled); version says disabled", async () => {
    const call = await serve();
    const q = await call("query", { query: SEMANTIC_QUERY });
    expect(q.isError).toBe(true);
    expect(q.body).toEqual({ error: "provider_unavailable", message: PROVIDER_UNAVAILABLE_MESSAGE, data: { provider: null }, retriable: false });
    const g = await call("graph", { roots: ["a.md"], select: ['semantic("x")'] });
    expect(g.body.error).toBe("provider_unavailable");
    // blocks_resolve with nothing to fuse is FTS-only (its result is the ranked hit list).
    const r = await call("blocks_resolve", { query: "paragraph" });
    expect(r.isError).toBe(false);
    expect((r.body as unknown as unknown[]).length).toBe(1);
    const v = await call("version");
    expect(v.body.capabilities).toEqual({ history: { state: "enabled", provider: "native", coverage_from: expect.any(String), writer_requires: true, completeness: "every" }, semantic: { state: "disabled", model: null } });
    expect(Object.keys(v.body).slice(-3)).toEqual(["profile", "capabilities", "epoch"]);
    expect(v.body.epoch).toMatch(/^ep_/);
  });

  it("full composition, provider configured and loaded: version says enabled", async () => {
    const call = await serve({ ctx: { embedQuery: async () => ({ model: "m", vec: new Float32Array([1, 0]) }), embedProvider: "omgbase-embedder" } });
    writeWorkspaceSettings(store!, { embedding: { provider: "omgbase-embedder" } });
    const v = await call("version");
    expect(v.body.capabilities).toEqual({ history: { state: "enabled", provider: "native", coverage_from: expect.any(String), writer_requires: true, completeness: "every" }, semantic: { state: "enabled", model: null } });
    // Loaded but nothing embedded under the model: the 3.0 "cannot rank" provider_unavailable (spec/surface §4).
    const q = await call("query", { query: SEMANTIC_QUERY });
    expect(q.body.error).toBe("provider_unavailable");
    expect(q.body.data).toEqual({ provider: "omgbase-embedder", model: "m" });
  });

  it("full composition, provider configured but the host could not start it: capability_unavailable { unavailable }, retriable; version says unavailable", async () => {
    const call = await serve({ ctx: { semanticUnavailable: { provider: "omgbase-embedder", reason: "spawn omgbase-embedder ENOENT" } } });
    writeWorkspaceSettings(store!, { embedding: { provider: "omgbase-embedder" } });
    const q = await call("query", { query: SEMANTIC_QUERY });
    expect(q.body).toEqual({
      error: "capability_unavailable",
      message: 'semantic search is unavailable — the configured embedding provider "omgbase-embedder" failed to start: spawn omgbase-embedder ENOENT',
      data: { capability: "semantic", state: "unavailable", provider: "omgbase-embedder", reason: "spawn omgbase-embedder ENOENT" },
      retriable: true,
    });
    const r = await call("blocks_resolve", { query: "paragraph" });
    expect(r.body.error).toBe("capability_unavailable");
    expect((r.body.data as { state: string }).state).toBe("unavailable");
    const v = await call("version");
    expect(v.body.capabilities).toEqual({ history: { state: "enabled", provider: "native", coverage_from: expect.any(String), writer_requires: true, completeness: "every" }, semantic: { state: "unavailable", model: null } });
  });

  it("core-only composition: capability_unavailable { disabled } from query, graph and the resolve leg; reads and FTS unchanged; version says disabled", async () => {
    const call = await serve({ core: true, ctx: { embedQuery: async () => ({ model: "m", vec: new Float32Array([1, 0]) }) } });
    writeWorkspaceSettings(store!, { embedding: { provider: "omgbase-embedder" } }); // configured, yet the module is absent
    const expected = { error: "capability_unavailable", message: SEMANTIC_DISABLED_MESSAGE, data: { capability: "semantic", state: "disabled", fix: SEMANTIC_DISABLED_FIX }, retriable: false };
    expect((await call("query", { query: SEMANTIC_QUERY })).body).toEqual(expected);
    expect((await call("query", { query: 'blocks { order by semantic("x") desc limit 3 }' })).body).toEqual(expected);
    expect((await call("graph", { roots: ["a.md"], select: ['semantic("x")'] })).body).toEqual(expected);
    expect((await call("blocks_resolve", { query: "paragraph" })).body).toEqual(expected);
    // At the TOOL the gate runs before the query does (as the 3.0 provider_unavailable pre-check always did), so a
    // semantic() on nodes is the capability error here; the runner's target check (filter_invalid) is the library path's.
    expect((await call("query", { query: 'nodes { where semantic("x") > 0.5 }' })).body.error).toBe("capability_unavailable");
    // Everything else is the core's.
    expect((await call("query", { query: 'blocks { where text("paragraph") }' })).isError).toBe(false);
    expect((await call("docs_read", { _path: "a.md" })).isError).toBe(false);
    expect((await call("blocks_search", { q: "paragraph" })).isError).toBe(false);
    const v = await call("version");
    // Phase 4a: the core-only composition has no recorder either — `unavailable`; the repository it created runs disabled.
    expect(v.body.capabilities).toEqual({ history: { state: "unavailable", provider: "native", coverage_from: null, writer_requires: false, completeness: "every" }, semantic: { state: "disabled", model: null } });
  });

  it("core-only composition without an embedQuery: blocks_resolve stays FTS-only (nothing to fuse)", async () => {
    const call = await serve({ core: true });
    const r = await call("blocks_resolve", { query: "paragraph" });
    expect(r.isError).toBe(false);
    expect((r.body as unknown as unknown[]).length).toBe(1);
  });
});
