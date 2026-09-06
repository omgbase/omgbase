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

describe("docsOutline — frozen wire format (06 §6)", () => {
  it("renders indented alias/type/label lines with section marks", () => {
    const { docId } = ingest(SAMPLE);
    const { text, ids } = docsOutline(store!, docId);
    expect(text).toMatchInlineSnapshot(`
      "b01 h1   Risks  §
      b02 p    Stable block identity is quite difficult to achieve in practice.
      b03 ul
        b04 li   ☐ decide on id write-back
        b05 li   ☑ pick a hash"
    `);
    expect(Object.keys(ids)).toHaveLength(5);
    expect(ids.b01).toMatch(/^b_/);
  });

  it("skeleton resolution omits labels", () => {
    const { docId } = ingest("# H\n\nbody\n");
    const { text } = docsOutline(store!, docId, { resolution: "skeleton" });
    expect(text).toContain("b01 h1");
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

  it("surfaces the document's metadata bag and omits ids by default", () => {
    const { docId } = ingest(WITH_FM);
    const res = docsRead(store!, docId);
    expect(res?.metadata).toEqual({ layer: "canon", title: "Guide" });
    expect(res?.ids).toBeUndefined();
  });

  it("is format-neutral: metadata is the adapter's bag, not markdown frontmatter", () => {
    // A YAML file's metadata is the parsed object it represents (format/yaml.ts
    // extractMetadata), not a frontmatter block — docsRead returns it verbatim.
    const yaml = "database:\n  host: localhost\n  port: 5432\nauth: token\n";
    const { docId } = ingest(yaml, "config.yaml");
    const res = docsRead(store!, docId);
    expect(res?.content).toBe(yaml);
    expect((res?.metadata.database as Record<string, unknown>).host).toBe("localhost");
    expect(res?.metadata.auth).toBe("token");
  });

  it("includes the outline id map when includeIds is set", () => {
    const { docId } = ingest(SAMPLE);
    const res = docsRead(store!, docId, { includeIds: true });
    expect(Object.keys(res!.ids!).length).toBeGreaterThan(0);
    expect(res!.ids!.b01).toMatch(/^b_/);
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
