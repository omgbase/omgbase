import { describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { ingestFile } from "../ingest.js";
import { ensureRepo } from "../attach.js";
import { readDocumentAtRevision, docsRead } from "../read/document.js";
import { capabilitiesOf, requireHistory } from "./registry.js";
import { defaultCapabilities } from "./default.js";
import { HistoryRecorderImpl } from "./history.js";
import { SemanticProviderImpl } from "./semantic.js";
import { TableUnionClaims } from "./claims.js";
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
    expect(store.capabilities.claims).toBeInstanceOf(TableUnionClaims);
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
    expect(history.currentFrontmatterRaw(r2.revId)).toBe("---\ntitle: Seam\n---");
    expect(docsRead(store, r2.docId)?._raw).toBe(DOC.replace("One", "Two"));
    expect(history.renderedHash(r2.revId)?.toString("hex")).toBe(docsRead(store, r2.docId) && (store.db.prepare("SELECT lower(hex(file_hash)) h FROM docs WHERE doc_id = ?").get(r2.docId) as { h: string }).h);
    expect(history.priorRenderedHash(r2.revId)).toEqual(history.renderedHash(r1.revId));
    expect(history.priorRenderedHash(r1.revId)).toBeNull();
    expect(history.docsHistory(repoId, { doc: r1.docId }).docs[0]?.versions.map((v) => v._rev)).toEqual([r1.revId, r2.revId]);
    expect(history.changesSince(repoId).digests.map((d) => d.commit)).toEqual([r1.commitId, r2.commitId]);
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
