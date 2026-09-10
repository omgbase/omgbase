import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { docsOutline } from "./outline.js";
import { docsRead } from "./document.js";
import { nodesGet, nodesGetMany } from "./nodes.js";
import { loadDocBlocks } from "./reader.js";

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

  it("round-trips a document with no frontmatter byte-for-byte", () => {
    const { docId } = ingest(SAMPLE);
    expect(docsRead(store!, docId)?.content).toBe(SAMPLE);
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
