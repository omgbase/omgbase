import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { docsOutline } from "./outline.js";
import { docsRead, docsReadMany, MANY_DOCS_CAP, readDocumentAtRevision } from "./document.js";
import { nodesGet, nodesGetMany } from "./nodes.js";
import { loadDocBlocks, findDocByRef } from "./reader.js";
import { sha256 } from "../hash.js";

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function ingest(content: string, path = "a.md"): { docId: string } {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  const res = ingestFile(store, repoId, path, content);
  return { docId: res.docId };
}

const SAMPLE = "# Risks\n\nStable block identity is quite difficult to achieve in practice.\n\n- [ ] decide on id write-back\n- [x] pick a hash\n";

describe("docsOutline — wire format (06 §6)", () => {
  it("renders indented id/type/label lines with full block ids inline", () => {
    const { docId } = ingest(SAMPLE);
    const { text } = docsOutline(store!, docId);
    // Strip the per-run block ids so the shape is snapshot-stable.
    const shape = text.replace(/b_[0-9a-z]+/g, "b_ID");
    expect(shape).toMatchInlineSnapshot(`
      "b_ID h1   Risks  §
      b_ID p    Stable block identity is quite difficult to achieve in practice.
      b_ID ul
        b_ID li   ☐ decide on id write-back
        b_ID li   ☑ pick a hash"
    `);
    expect(text.split("\n")).toHaveLength(5);
    for (const line of text.split("\n")) expect(line.trimStart()).toMatch(/^b_[0-9a-z]+ /);
  });

  it("skeleton resolution omits labels", () => {
    const { docId } = ingest("# H\n\nbody\n");
    const { text } = docsOutline(store!, docId, { resolution: "skeleton" });
    expect(text).toMatch(/^b_[0-9a-z]+ h1/m);
    expect(text).not.toContain("body");
  });

  it("truncates on budget and flags it", () => {
    const { docId } = ingest("# H\n\n" + "para\n\n".repeat(40));
    const { truncated } = docsOutline(store!, docId, { budgetTokens: 5 });
    expect(truncated).toBe(true);
  });
});

describe("docsRead — whole-document read", () => {
  const WITH_FM = "---\nlayer: canon\ntitle: Guide\n---\n\n# Risks\n\nStable identity is hard.\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";

  it("returns the complete file bytes verbatim (fences, tables, frontmatter)", () => {
    const { docId } = ingest(WITH_FM);
    const res = docsRead(store!, docId);
    expect(res?.content).toBe(WITH_FM);
    expect(res?.path).toBe("a.md");
    expect(res?.rev).toMatch(/^r/);
  });

  it("surfaces properties grouped by source and omits ids by default", () => {
    const { docId } = ingest(WITH_FM);
    const res = docsRead(store!, docId);
    expect(res?.properties.frontmatter).toEqual({ layer: "canon", title: "Guide" });
    expect(res?.ids).toBeUndefined();
  });

  it("is format-neutral: properties come from the adapter's metadata, dotted", () => {
    // A YAML file's metadata is the parsed object it represents (format/yaml.ts
    // extractMetadata); it flattens into frontmatter-source property rows.
    const yaml = "database:\n  host: localhost\n  port: 5432\nauth: token\n";
    const { docId } = ingest(yaml, "config.yaml");
    const res = docsRead(store!, docId);
    expect(res?.content).toBe(yaml);
    const fm = res!.properties.frontmatter!;
    expect(fm["database.host"]).toBe("localhost");
    expect(fm["auth"]).toBe("token");
  });

  it("includes the block ids in order when includeIds is set", () => {
    const { docId } = ingest(SAMPLE);
    const res = docsRead(store!, docId, { includeIds: true });
    expect(res!.ids!.length).toBeGreaterThan(0);
    expect(res!.ids![0]).toMatch(/^b_/);
  });

  it("includeIds also returns a {id → content hash} map for CAS pinning", () => {
    const { docId } = ingest(SAMPLE);
    const res = docsRead(store!, docId, { includeIds: true });
    // One hash entry per id, keyed by the same ids, each a raw-hash hex string.
    expect(Object.keys(res!.hashes!).sort()).toEqual([...res!.ids!].sort());
    for (const id of res!.ids!) expect(res!.hashes![id]).toMatch(/^[0-9a-f]{64}$/);
    // The value is exactly the block's raw hash the apply kernel expects.
    const first = res!.ids![0]!;
    const rawHash = (store!.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ?").get(first) as { h: string }).h;
    expect(res!.hashes![first]).toBe(rawHash);
  });

  it("round-trips a document with no frontmatter byte-for-byte", () => {
    const { docId } = ingest(SAMPLE);
    expect(docsRead(store!, docId)?.content).toBe(SAMPLE);
  });
});

describe("docsReadMany — batch whole-document read", () => {
  // A dedicated multi-doc store: the top-level `ingest` helper makes a fresh
  // store per call, but the batch reader needs several docs in ONE repo.
  function ingestMany(docs: { path: string; content: string }[]): { repoId: string } {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "t", "/tmp");
    for (const d of docs) ingestFile(store, repoId, d.path, d.content);
    return { repoId };
  }

  it("hydrates several docs by path in one call, same shape as docsRead", () => {
    const { repoId } = ingestMany([
      { path: "a.md", content: "# A\n\nalpha body\n" },
      { path: "b.md", content: "---\nlayer: canon\n---\n\n# B\n\nbeta body\n" },
    ]);
    const res = docsReadMany(store!, repoId, ["a.md", "b.md"]);
    expect(res.errors).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
    expect(res.items[0]!.content).toBe("# A\n\nalpha body\n");
    expect(res.items[1]!.properties.frontmatter).toEqual({ layer: "canon" });
  });

  it("accepts doc ids too (id-or-path symmetry) and honors include_ids", () => {
    const { repoId } = ingestMany([{ path: "a.md", content: "# A\n\nalpha body\n" }]);
    const docId = (store!.db.prepare("SELECT doc_id FROM docs WHERE path='a.md'").get() as { doc_id: string }).doc_id;
    const res = docsReadMany(store!, repoId, [docId], { includeIds: true });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.docId).toBe(docId);
    expect(res.items[0]!.ids!.length).toBeGreaterThan(0);
    expect(res.items[0]!.ids![0]).toMatch(/^b_/);
  });

  it("puts unresolvable refs in errors without failing the call", () => {
    const { repoId } = ingestMany([{ path: "a.md", content: "# A\n\nalpha body\n" }]);
    const res = docsReadMany(store!, repoId, ["a.md", "missing.md", "d_0000000"]);
    expect(res.items.map((i) => i.path)).toEqual(["a.md"]);
    expect(res.errors).toEqual([
      { ref: "missing.md", error: "doc_not_found" },
      { ref: "d_0000000", error: "doc_not_found" },
    ]);
  });

  it("collapses duplicate refs first-seen (one item per ref)", () => {
    const { repoId } = ingestMany([
      { path: "a.md", content: "# A\n\nalpha body\n" },
      { path: "b.md", content: "# B\n\nbeta body\n" },
    ]);
    const res = docsReadMany(store!, repoId, ["a.md", "b.md", "a.md", "a.md"]);
    expect(res.items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
  });

  it("caps the ref list and flags truncation", () => {
    const { repoId } = ingestMany([{ path: "a.md", content: "# A\n\nalpha body\n" }]);
    // One real doc plus enough distinct misses to exceed the cap.
    const refs = ["a.md", ...Array.from({ length: MANY_DOCS_CAP }, (_, i) => `miss-${i}.md`)];
    const res = docsReadMany(store!, repoId, refs);
    expect(res.truncated).toBe(true);
    // Only MANY_DOCS_CAP refs are considered — the last miss is dropped.
    expect(res.items.length + res.errors.length).toBe(MANY_DOCS_CAP);
  });

  it("stops early under a token budget and flags truncation", () => {
    const big = "# Big\n\n" + Array.from({ length: 40 }, (_, i) => `paragraph number ${i} with a fair amount of words here`).join("\n\n") + "\n";
    const { repoId } = ingestMany([
      { path: "a.md", content: big },
      { path: "b.md", content: big },
      { path: "c.md", content: big },
    ]);
    const res = docsReadMany(store!, repoId, ["a.md", "b.md", "c.md"], { budgetTokens: 20 });
    expect(res.truncated).toBe(true);
    expect(res.items.length).toBeLessThan(3);
  });
});

describe("nodesGet — resolution ladder", () => {
  it("full resolution returns raw + text + attrs + placement", () => {
    const { docId } = ingest(SAMPLE);
    const roots = loadDocBlocks(store!, docId);
    const heading = roots[0]!;
    const node = nodesGet(store!, docId, heading.blockId, { resolution: "full" });
    expect(node?.raw).toBe("# Risks");
    expect(node?.text).toBe("Risks");
    expect(node?.attrs?.level).toBe(1);
    expect(node?.placement?.depth).toBe(0);
  });

  it("raw resolution returns exact source bytes", () => {
    const { docId } = ingest(SAMPLE);
    const roots = loadDocBlocks(store!, docId);
    const para = roots[1]!;
    const node = nodesGet(store!, docId, para.blockId, { resolution: "raw" });
    expect(node?.raw).toBe("Stable block identity is quite difficult to achieve in practice.");
  });

  it("raw/full resolutions expose the block's content_hash (the CAS value)", () => {
    const { docId } = ingest(SAMPLE);
    const roots = loadDocBlocks(store!, docId);
    const para = roots[1]!;
    const rawNode = nodesGet(store!, docId, para.blockId, { resolution: "raw" });
    const fullNode = nodesGet(store!, docId, para.blockId, { resolution: "full" });
    expect(rawNode?.content_hash).toBe(para.rawHashHex);
    expect(fullNode?.content_hash).toBe(para.rawHashHex);
    // Lean resolutions stay lean — no hash.
    expect(nodesGet(store!, docId, para.blockId, { resolution: "text" })?.content_hash).toBeUndefined();
  });

  it("returns null for unknown block", () => {
    const { docId } = ingest("# H\n");
    expect(nodesGet(store!, docId, "b_missing")).toBeNull();
  });
});

describe("nodesGetMany", () => {
  it("fetches multiple blocks and caps at 100 ids", () => {
    const { docId } = ingest(SAMPLE);
    const roots = loadDocBlocks(store!, docId);
    const ids = roots.map((r) => r.blockId);
    const res = nodesGetMany(store!, docId, ids, { resolution: "text" });
    expect(res.nodes.length).toBe(ids.length);
    expect(res.truncated).toBe(false);
  });

  it("flags truncation when more than 100 ids requested", () => {
    const { docId } = ingest("# H\n");
    const many = Array.from({ length: 101 }, (_, i) => `b_${i}`);
    const res = nodesGetMany(store!, docId, many);
    expect(res.truncated).toBe(true);
  });
});

describe("readDocumentAtRevision — whole-doc time travel", () => {
  // Re-ingest the same path repeatedly to build a revision chain. We keep the
  // leading trivia and frontmatter separator IDENTICAL across revisions so the
  // rendered_hash equality holds even for the earliest revision (see the
  // fidelity caveat in document.ts — doc-level trivia is not per-revision).
  function ingestRevs(path: string, contents: string[]): { docId: string; revs: string[]; hashes: Buffer[] } {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "t", "/tmp");
    let docId = "";
    const revs: string[] = [];
    const hashes: Buffer[] = [];
    for (const c of contents) {
      const res = ingestFile(store, repoId, path, c);
      docId = res.docId;
      const row = store.db.prepare("SELECT current_rev FROM docs WHERE doc_id = ?").get(docId) as { current_rev: string };
      const revRow = store.db.prepare("SELECT rendered_hash FROM revisions WHERE rev_id = ?").get(row.current_rev) as { rendered_hash: Buffer };
      revs.push(row.current_rev);
      hashes.push(revRow.rendered_hash);
    }
    return { docId, revs, hashes };
  }

  const V1 = "---\nlayer: working\n---\n\n# Guide\n\nThe original first paragraph, kept long enough to persist.\n";
  const V2 = "---\nlayer: working\n---\n\n# Guide\n\nThe original first paragraph, kept long enough to persist.\n\nA second paragraph appears in revision two here.\n";
  const V3 = "---\nlayer: working\n---\n\n# Guide\n\nThe first paragraph is rewritten in revision three entirely.\n\nA second paragraph appears in revision two here.\n";

  it("reconstructs the earliest revision byte-for-byte with a matching rendered_hash", () => {
    const { docId, revs, hashes } = ingestRevs("guide.md", [V1, V2, V3]);
    const res = readDocumentAtRevision(store!, docId, revs[0]!);
    expect(res).not.toBeNull();
    expect(res!.content).toBe(V1);
    expect(res!.renderedHashMatch).toBe(true);
    expect(sha256(res!.content).equals(hashes[0]!)).toBe(true);
  });

  it("reconstructs a middle revision byte-for-byte", () => {
    const { docId, revs } = ingestRevs("guide.md", [V1, V2, V3]);
    const res = readDocumentAtRevision(store!, docId, revs[1]!);
    expect(res!.content).toBe(V2);
    expect(res!.renderedHashMatch).toBe(true);
  });

  it("the current revision matches docsRead(...).content exactly", () => {
    const { docId, revs } = ingestRevs("guide.md", [V1, V2, V3]);
    const current = docsRead(store!, docId)!;
    const at = readDocumentAtRevision(store!, docId, revs[2]!)!;
    expect(at.content).toBe(current.content);
    expect(at.content).toBe(V3);
    expect(at.renderedHashMatch).toBe(true);
  });

  it("reconstructs nested container blocks (list with children) faithfully", () => {
    const nestedV1 = "# Tasks\n\n- parent one\n  - child a\n  - child b\n- parent two\n";
    const nestedV2 = nestedV1 + "\n> a trailing blockquote\n> spanning two lines\n";
    const { docId, revs } = ingestRevs("tasks.md", [nestedV1, nestedV2]);
    const res = readDocumentAtRevision(store!, docId, revs[0]!)!;
    expect(res.content).toBe(nestedV1);
    // The top-level-only walk still yields the nested children verbatim.
    expect(res.content).toContain("  - child a");
    expect(res.content).toContain("  - child b");
    expect(res.renderedHashMatch).toBe(true);
  });

  it("returns null for an unknown revision id", () => {
    const { docId } = ingestRevs("guide.md", [V1]);
    expect(readDocumentAtRevision(store!, docId, "r_does_not_exist")).toBeNull();
  });

  it("returns null when the revision belongs to a DIFFERENT document", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "t", "/tmp");
    const a = ingestFile(store, repoId, "a.md", V1).docId;
    ingestFile(store, repoId, "b.md", V2);
    const bRev = (store.db.prepare("SELECT current_rev FROM docs WHERE path = 'b.md'").get() as { current_rev: string }).current_rev;
    // b's revision id is real, but not a revision of document a.
    expect(readDocumentAtRevision(store, a, bRev)).toBeNull();
  });

  it("carries current properties flagged propertiesAreCurrent", () => {
    const { docId, revs } = ingestRevs("guide.md", [V1, V2]);
    const res = readDocumentAtRevision(store!, docId, revs[0]!)!;
    expect(res.propertiesAreCurrent).toBe(true);
    expect(res.properties.frontmatter).toEqual({ layer: "working" });
  });
});

describe("findDocByRef — the shared id-or-path resolver", () => {
  it("resolves a d_ id, a path, and returns null for the unresolvable", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "t", "/tmp");
    const docId = ingestFile(store, repoId, "guide.md", "# G\n\nbody\n").docId;

    // by id
    expect(findDocByRef(store, repoId, docId)?.docId).toBe(docId);
    // by path
    const byPath = findDocByRef(store, repoId, "guide.md");
    expect(byPath?.docId).toBe(docId);
    expect(byPath?.path).toBe("guide.md");
    // unresolvable path
    expect(findDocByRef(store, repoId, "missing.md")).toBeNull();
  });

  it("a d_-shaped id that doesn't exist returns null (no path fallthrough)", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "t", "/tmp");
    ingestFile(store, repoId, "guide.md", "# G\n\nbody\n");
    // Valid d_ shape, no such doc — must NOT be reinterpreted as a path.
    expect(findDocByRef(store, repoId, "d_0000000")).toBeNull();
  });
});
