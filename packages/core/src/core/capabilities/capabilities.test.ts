import { describe, expect, it } from "vitest";
import { changesSince } from "../store/feed.js";
import { Store } from "../store/store.js";
import { ingestFile } from "../ingest.js";
import { ensureRepo } from "../attach.js";
import { readDocumentAtRevision, docsRead, currentFrontmatterRaw } from "../read/document.js";
import { capabilitiesOf, requireHistory, requireSemantic, semanticOf } from "./registry.js";
import { compositionHasGitProvider, compositionHasHistory, compositionHasSemantic, defaultCapabilities, envCapabilities, envComposition, gitCapabilities, historyCapabilities, semanticCapabilities } from "./default.js";
import { coreCapabilities } from "./core.js";
import { CapabilityUnavailable, SEMANTIC_DISABLED_FIX, SEMANTIC_DISABLED_MESSAGE } from "./errors.js";
import { errorBody } from "../../mcp/errors.js";
import { oqxRun } from "../../oqx-js/run.js";
import { hybridSearch } from "../../search/rrf.js";
import { sizeReport } from "../store/size.js";
import { versionInfo } from "../../version.js";
import { capabilityStates } from "../../sync/capability-state.js";
import { writeRepoSettings, writeWorkspaceSettings } from "../../sync/settings.js";
import { HistoryRecorderImpl } from "./history.js";
import { SemanticProviderImpl } from "./semantic.js";
import { IdClaims } from "./claims.js";
import { mintId } from "../ids.js";

// The seams of modular-core Phase 1: a store opened without naming its
// capabilities runs the defaults; the defaults are the implementations the
// composition layer names; the recorder's reads are the reads the surface
// made before the seam existed; the claims oracle is the mint oracle.

const DOC = "---\ntitle: Seam\n---\n\n# Seam\n\nOne paragraph.\n";

function open(): { store: Store; repoId: string } {
  const store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "seam");
  return { store, repoId };
}

describe("capabilities", () => {
  it("a bare store installs the defaults and binds them to its connection", () => {
    const { store } = open();
    expect(store.capabilities.history).toBeInstanceOf(HistoryRecorderImpl);
    expect(store.capabilities.semantic).toBeInstanceOf(SemanticProviderImpl);
    expect(store.capabilities.claims).toBeInstanceOf(IdClaims);
    expect(capabilitiesOf(store.db)).toBe(store.capabilities);
    expect(requireHistory(store.db)).toBe(store.capabilities.history);
    store.close();
  });

  it("the composition layer's factory is the same set", () => {
    const store = new Store({ path: ":memory:", capabilities: defaultCapabilities });
    expect(store.capabilities.history).toBeInstanceOf(HistoryRecorderImpl);
    expect(capabilitiesOf(store.db)).toBe(store.capabilities);
    store.close();
  });

  it("the recorder's reads are the surface's reads", () => {
    const { store, repoId } = open();
    const r1 = ingestFile(store, repoId, "a.md", DOC, { ts: "2026-01-01T00:00:00.000Z" });
    const r2 = ingestFile(store, repoId, "a.md", DOC.replace("One", "Two"), { ts: "2026-01-02T00:00:00.000Z" });
    const history = requireHistory(store.db);
    expect(history.readAtRevision(r1.docId, r1.revId)).toEqual(readDocumentAtRevision(store, r1.docId, r1.revId));
    expect(history.readAtRevision(r1.docId, r1.revId)?._raw).toBe(DOC);
    // 17.0: the current frontmatter is the doc row's own (`currentFrontmatterRaw(db, docId)`), no longer a recorder read.
    expect(currentFrontmatterRaw(store.db, r2.docId)).toBe("---\ntitle: Seam\n---");
    expect(docsRead(store, r2.docId)?._raw).toBe(DOC.replace("One", "Two"));
    // 17.0 (3c): no current-state read goes through the recorder — `renderedHash`/`priorRenderedHash` are gone (the pending row carries `prior_hash`).
    expect("renderedHash" in history).toBe(false);
    expect("priorRenderedHash" in history).toBe(false);
    expect(history.docsHistory(repoId, { doc: r1.docId }).docs[0]?.versions.map((v) => v._rev)).toEqual([r1.revId, r2.revId]);
    // 3d: the change feed is the core's (`core/store/feed.ts`); the recorder answers a digest's disposition counts.
    expect(changesSince(store, repoId).digests.map((d) => d.commit)).toEqual([r1.commitId, r2.commitId]);
    expect(history.dispositionCounts(r2.commitId)).toEqual(store.db.prepare("SELECT kind, count(*) AS n FROM dispositions WHERE commit_id = ? GROUP BY kind ORDER BY kind").all(r2.commitId));
    expect(history.dispositionCounts("c_nope")).toBeNull();
    expect(history.diffUnified(r1.docId, r1.revId, r2.revId)).toContain("+Two paragraph.");
    const mark = history.markReachable();
    expect(mark.trees.size).toBeGreaterThan(0);
    expect(mark.blobs.size).toBeGreaterThan(0);
    store.close();
  });

  it("the claims capability is the mint oracle: an id a row names is claimed, a fresh one is not", () => {
    const { store, repoId } = open();
    const r = ingestFile(store, repoId, "b.md", DOC);
    const claims = store.capabilities.claims;
    expect(claims.isClaimed("d", r.docId)).toBe(true);
    expect(claims.isClaimed("c", r.commitId)).toBe(true);
    expect(claims.isClaimed("r", r.revId)).toBe(true);
    const block = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ?").get(r.docId) as { block_id: string }).block_id;
    expect(claims.isClaimed("b", block)).toBe(true);
    expect(claims.isClaimed("b", "b_nonesuch")).toBe(false);
    // `mintId` consults the oracle: a minted id is never one the store claims.
    for (let i = 0; i < 20; i++) expect(claims.isClaimed("b", mintId("b"))).toBe(false);
    store.close();
    expect(claims.isClaimed("d", r.docId)).toBe(false); // a closed connection claims nothing
  });

  it("the semantic provider answers the gate and the vector reads over the store's tables", () => {
    const { store, repoId } = open();
    const r = ingestFile(store, repoId, "c.md", DOC);
    const semantic = store.capabilities.semantic!;
    expect(semantic.available(repoId, "m")).toBe(false);
    expect(semantic.docVector(r.docId, "m")).toBeNull();
    const vec = Buffer.from(new Float32Array([1, 0]).buffer);
    store.db.prepare("INSERT INTO doc_embeddings (doc_id, model, input_hash, method, dim, vec) VALUES (?, 'm', zeroblob(32), 'whole', 2, ?)").run(r.docId, vec);
    expect(semantic.available(repoId, "m")).toBe(true);
    expect(semantic.docVector(r.docId, "m")).toEqual(vec);
    const ctx = semantic.blockContexts({ repoId }).ctx({ doc_id: r.docId, path: "c.md", ordinal: 1, type: "paragraph" });
    expect(ctx).toContain("Seam · c.md");
    store.close();
  });
});

// Phase 2: the core-only composition — no semantic module — boots, reads and
// writes; every semantic path answers `capability_unavailable { semantic,
// disabled }`; the manifest is derived from the provider configuration.

describe("the core-only composition (OMGBASE_CAPABILITIES=core)", () => {
  const LONG = "one paragraph with plenty of words so that it comfortably clears the twenty four token minimum needed for embedding eligibility in these tests here now";

  function openCore(): { store: Store; repoId: string } {
    const store = new Store({ path: ":memory:", capabilities: coreCapabilities });
    const repoId = ensureRepo(store, "core");
    return { store, repoId };
  }

  it("envCapabilities: unset/full → the defaults, core → the core-only set, anything else refused", () => {
    expect(envCapabilities({})).toBe(defaultCapabilities);
    expect(envCapabilities({ OMGBASE_CAPABILITIES: "" })).toBe(defaultCapabilities);
    expect(envCapabilities({ OMGBASE_CAPABILITIES: "full" })).toBe(defaultCapabilities);
    expect(envCapabilities({ OMGBASE_CAPABILITIES: "core" })).toBe(coreCapabilities);
    expect(envCapabilities({ OMGBASE_CAPABILITIES: "history" })).toBe(historyCapabilities);
    expect(envCapabilities({ OMGBASE_CAPABILITIES: "semantic" })).toBe(semanticCapabilities);
    expect(envCapabilities({ OMGBASE_CAPABILITIES: "git" })).toBe(gitCapabilities);
    expect(envComposition({ OMGBASE_CAPABILITIES: "git" })).toBe("git");
    expect(compositionHasGitProvider("git")).toBe(true);
    expect(compositionHasGitProvider("full")).toBe(true);
    expect(compositionHasGitProvider("history")).toBe(false);
    expect(compositionHasHistory("git")).toBe(false);
    expect(compositionHasSemantic("git")).toBe(false);
    expect(() => envCapabilities({ OMGBASE_CAPABILITIES: "none" })).toThrow(/not a composition/);
    expect(envComposition({})).toBe("full");
    expect(envComposition({ OMGBASE_CAPABILITIES: "core" })).toBe("core");
  });

  it("boots without either module: no provider, no cosine UDF, no recorder; a repository it creates runs with history disabled and reads/writes work (Phase 4a)", () => {
    const { store, repoId } = openCore();
    expect(store.capabilities.semantic).toBeNull();
    expect(semanticOf(store.db)).toBeNull();
    expect(store.capabilities.history).toBeNull();
    expect(() => requireHistory(store.db)).toThrow(CapabilityUnavailable);
    // The `cosine` SQL function is the semantic bundle's to register.
    expect(() => store.db.prepare("SELECT cosine(zeroblob(8), zeroblob(8))").get()).toThrow(/no such function: cosine/);
    const r1 = ingestFile(store, repoId, "a.md", `# A\n\n${LONG}\n`);
    const r2 = ingestFile(store, repoId, "a.md", `# A\n\n${LONG} edited\n`);
    expect(docsRead(store, r1.docId)?._raw).toContain("edited");
    expect(r2.revId).not.toBe(r1.revId);
    // No history table exists and none was written: the feed alone records the two commits.
    expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('revisions', 'commits', 'blobs')").all()).toEqual([]);
    expect((store.db.prepare("SELECT count(*) c FROM feed").get() as { c: number }).c).toBe(2);
    expect(readDocumentAtRevision(store, r1.docId, r2.revId)).toBeNull();
    expect(capabilityStates(store, repoId)).toEqual({ history: { state: "unavailable", provider: "native", coverage_from: null, writer_requires: false, completeness: "every", remote: null }, semantic: { state: "disabled", model: null } });
    // text() stays the core's.
    expect(oqxRun(store, repoId, 'blocks { where text("paragraph") }').hits.length).toBe(1);
    // The size report walks every table but prints no vector advice.
    expect(sizeReport(store).advice.every((a) => !a.startsWith("embeddings are"))).toBe(true);
    store.close();
  });

  it("every semantic path raises capability_unavailable { semantic, disabled } with the pinned message", () => {
    const { store, repoId } = openCore();
    ingestFile(store, repoId, "a.md", `# A\n\n${LONG}\n`);
    expect(() => requireSemantic(store.db)).toThrow(CapabilityUnavailable);
    // semantic() — filter and order by — on docs and blocks; the target check still comes first.
    for (const q of ['docs { where semantic("x") > 0.5 }', 'blocks { order by semantic("x") desc }', 'docs { select s: semantic("x") }']) {
      let err: unknown;
      try { oqxRun(store, repoId, q); } catch (e) { err = e; }
      expect(err, q).toBeInstanceOf(CapabilityUnavailable);
      expect((err as CapabilityUnavailable).state).toBe("disabled");
    }
    expect(() => oqxRun(store, repoId, 'nodes { where semantic("x") > 0.5 }')).toThrow(/docs and blocks targets/);
    // The fusion ranker's vector leg; FTS-only stays FTS-only.
    expect(() => hybridSearch(store, { repoId, text: "paragraph", vector: { model: "m", vec: new Float32Array([1, 0]) } })).toThrow(CapabilityUnavailable);
    expect(hybridSearch(store, { repoId, text: "paragraph" }).length).toBe(1);
    // The envelope (phase-1-contracts §2.1), byte for byte.
    expect(errorBody(CapabilityUnavailable.semanticDisabled())).toEqual({
      error: "capability_unavailable",
      message: SEMANTIC_DISABLED_MESSAGE,
      data: { capability: "semantic", state: "disabled", fix: SEMANTIC_DISABLED_FIX },
      retriable: false,
    });
    expect(SEMANTIC_DISABLED_MESSAGE).toBe("semantic search is disabled for this repository — configure an embedding provider (omg config set embedding.provider <command|url>) and embed the repository (omg embed drain)");
    expect(errorBody(CapabilityUnavailable.semanticUnavailable("omgbase-embedder", "spawn ENOENT"))).toEqual({
      error: "capability_unavailable",
      message: 'semantic search is unavailable — the configured embedding provider "omgbase-embedder" failed to start: spawn ENOENT',
      data: { capability: "semantic", state: "unavailable", provider: "omgbase-embedder", reason: "spawn ENOENT" },
      retriable: true,
    });
    store.close();
  });

  it("the manifest is derived from the provider configuration, never from vectors (resolution 1)", () => {
    const { store, repoId } = openCore();
    // Core-only: disabled whatever the settings say; history is `unavailable` (no module, Phase 4a).
    writeWorkspaceSettings(store, { embedding: { provider: "omgbase-embedder" } });
    expect(capabilityStates(store, repoId)).toEqual({ history: { state: "unavailable", provider: "native", coverage_from: null, writer_requires: false, completeness: "every", remote: null }, semantic: { state: "disabled", model: null } });
    store.close();

    const full = open();
    expect(capabilityStates(full.store, full.repoId)).toMatchObject({ history: { state: "enabled", writer_requires: true }, semantic: { state: "disabled", model: null } });
    expect(capabilityStates(full.store, full.repoId).history.coverage_from).toMatch(/^\d{4}-/);
    // Vectors alone do not enable it.
    const r = ingestFile(full.store, full.repoId, "c.md", DOC);
    full.store.db.prepare("INSERT INTO doc_embeddings (doc_id, model, input_hash, method, dim, vec) VALUES (?, 'm', zeroblob(32), 'whole', 2, zeroblob(8))").run(r.docId);
    expect(capabilityStates(full.store, full.repoId).semantic.state).toBe("disabled");
    // A configured provider does — at the workspace layer, inherited; a repo override too; a blank one does not.
    writeWorkspaceSettings(full.store, { embedding: { provider: "omgbase-embedder" } });
    expect(capabilityStates(full.store, full.repoId).semantic.state).toBe("enabled");
    expect(capabilityStates(full.store, null).semantic.state).toBe("enabled");
    writeRepoSettings(full.store, full.repoId, { embedding: { provider: "  " } });
    expect(capabilityStates(full.store, full.repoId).semantic.state).toBe("disabled");
    writeRepoSettings(full.store, full.repoId, { embedding: { provider: "http://localhost:9/embed" } });
    // Configured but the host could not start it: unavailable.
    expect(capabilityStates(full.store, full.repoId, { provider: "http://localhost:9/embed", reason: "ECONNREFUSED" }).semantic.state).toBe("unavailable");
    // `version` carries it after `profile`, then `epoch` (6.0) — the literal both engines pin.
    const v = versionInfo(full.store, undefined, "full", capabilityStates(full.store, full.repoId), "ep_x");
    expect(Object.keys(v).slice(-3)).toEqual(["profile", "capabilities", "epoch"]);
    expect(v.epoch).toBe("ep_x");
    expect(versionInfo(null).epoch).toBeNull();
    expect(v.capabilities).toMatchObject({ history: { state: "enabled", writer_requires: true }, semantic: { state: "enabled", model: null } });
    // The wire shape (spec/surface §4 `version`, 6.1): the key order both engines pin.
    expect(Object.keys(v.capabilities.history)).toEqual(["state", "provider", "coverage_from", "writer_requires", "completeness", "remote"]);
    expect(Object.keys(v.capabilities.semantic)).toEqual(["state", "model"]);
    expect(JSON.stringify(versionInfo(null).capabilities)).toBe('{"history":{"state":"disabled","provider":"native","coverage_from":null,"writer_requires":false,"completeness":"every","remote":null},"semantic":{"state":"disabled","model":null}}');
    full.store.close();
  });
});
