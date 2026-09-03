import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { docsOutline } from "./outline.js";
import { nodesGet, nodesGetMany } from "./nodes.js";
import { loadDocBlocks } from "./reader.js";

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function ingest(content: string): { docId: string } {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  const res = ingestFile(store, repoId, "a.md", content);
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
