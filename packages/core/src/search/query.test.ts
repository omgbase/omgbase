import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { query } from "./query.js";
import { FilterInvalid } from "./cel/parser.js";
import { parseFilter } from "./cel/parser.js";
import { compile } from "./cel/compile.js";
import { EmbeddingWorker, contextPrefix, type EmbeddingProvider, type EmbedTask } from "./embeddings.js";
import { sha256 } from "../core/hash.js";

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

function ingest(path: string, content: string): void {
  ingestFile(store, repoId, path, content);
}

describe("query — documents target", () => {
  beforeEach(() => {
    ingest("guides/a.md", "---\nlayer: working\ntags: [pricing, saas]\n---\n\n# A\n\nbody\n");
    ingest("guides/b.md", "---\nlayer: draft\ntags: docs\n---\n\n# B\n\nbody\n");
    ingest("notes/c.md", "---\nlayer: canon\n---\n\n# C\n\nbody\n");
  });

  it("filters by frontmatter scalar (layer == working)", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: 'layer == "working"' });
    expect(hits.map((h) => h.path)).toEqual(["guides/a.md"]);
  });

  it("filters by path prefix", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: '$path.startsWith("guides/")' });
    expect(hits.map((h) => h.path).sort()).toEqual(["guides/a.md", "guides/b.md"]);
  });

  it("list() membership matches scalar or list frontmatter", () => {
    const pricing = query(store, repoId, { from: "documents", filter: '"pricing" in list(tags)' });
    expect(pricing.hits.map((h) => h.path)).toEqual(["guides/a.md"]);
    const docs = query(store, repoId, { from: "documents", filter: '"docs" in list(tags)' });
    expect(docs.hits.map((h) => h.path)).toEqual(["guides/b.md"]);
  });

  it("size(list()) works", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: "size(list(tags)) > 1" });
    expect(hits.map((h) => h.path)).toEqual(["guides/a.md"]);
  });

  it("boolean combinations (&&, ||, !)", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: 'layer == "working" || layer == "canon"' });
    expect(hits.map((h) => h.path).sort()).toEqual(["guides/a.md", "notes/c.md"]);
  });

  it("select projects frontmatter keys onto hits (no hydration round-trip)", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: 'layer == "working"', select: ["layer", "tags"] });
    expect(hits).toEqual([{ id: hits[0]!.id, path: "guides/a.md", layer: "working", tags: ["pricing", "saas"] }]);
  });

  it("select omits absent keys (CEL absence semantics)", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: 'layer == "canon"', select: ["layer", "tags"] });
    expect(hits[0]).toEqual({ id: hits[0]!.id, path: "notes/c.md", layer: "canon" }); // no tags key
  });

  it("empty select stays lean {id, path}", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: 'layer == "working"', select: [] });
    expect(Object.keys(hits[0]!).sort()).toEqual(["id", "path"]);
  });
});

describe("query — blocks target", () => {
  beforeEach(() => {
    ingest("tasks.md", "# Launch\n\n- [ ] deploy the service\n- [x] write docs\n\n## Other\n\n- [ ] unrelated\n");
    ingest("code.md", "# Examples\n\n```ts\nconst a = 1;\n```\n\n```py\nx = 1\n```\n");
  });

  it("filters by block type and attrs (unchecked tasks)", () => {
    const { hits } = query(store, repoId, { from: "blocks", filter: "type == \"task\" && !attrs.checked" });
    expect(hits.length).toBe(2); // deploy + unrelated
  });

  it("under_heading scopes to a section (incl. subsections)", () => {
    // "Other" (h2) nests under "Launch" (h1), so both unchecked tasks are under Launch.
    const launch = query(store, repoId, { from: "blocks", filter: 'type == "task" && !attrs.checked && under_heading("Launch")' });
    expect(launch.hits.length).toBe(2);
    // "Other" is a leaf subsection — only its own unchecked task.
    const other = query(store, repoId, { from: "blocks", filter: 'type == "task" && !attrs.checked && under_heading("Other")' });
    expect(other.hits.length).toBe(1);
  });

  it("code fences by lang under a heading", () => {
    const { hits } = query(store, repoId, { from: "blocks", filter: 'type == "code_fence" && attrs.lang == "ts" && under_heading("Examples")' });
    expect(hits.length).toBe(1);
  });

  it("within(path) scopes to a document", () => {
    const { hits } = query(store, repoId, { from: "blocks", filter: 'within("tasks.md") && type == "heading"' });
    expect(hits.length).toBe(2);
  });

  it("select projects block type + attrs and doc frontmatter", () => {
    const { hits } = query(store, repoId, {
      from: "blocks",
      filter: 'type == "task" && !attrs.checked && within("tasks.md")',
      select: ["type", "attrs.checked", "$ordinal"],
    });
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect(h.type).toBe("task");
      expect(typeof h.ordinal).toBe("number");
    }
  });

  it("$content_hash on blocks is the block's own raw hash, not the doc hash", () => {
    const { hits } = query(store, repoId, {
      from: "blocks",
      filter: 'type == "heading" && within("tasks.md") && text == "Launch"',
      select: ["$content_hash"],
    });
    expect(hits.length).toBe(1);
    const blockId = hits[0]!.id;
    // Ground truth: the block's stored raw_hash — the value update/split CAS on.
    const rawHash = (store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ?").get(blockId) as { h: string }).h;
    expect(hits[0]!.$content_hash).toBe(rawHash);
    // And it must NOT be the containing document's file_hash.
    const docId = (store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ?").get(blockId) as { doc_id: string }).doc_id;
    const docHash = (store.db.prepare("SELECT lower(hex(file_hash)) h FROM documents WHERE doc_id = ?").get(docId) as { h: string }).h;
    expect(hits[0]!.$content_hash).not.toBe(docHash);
  });

  it("$content_hash on documents is the file hash", () => {
    const { hits } = query(store, repoId, { from: "documents", filter: '$path == "tasks.md"', select: ["$content_hash"] });
    expect(hits.length).toBe(1);
    const docHash = (store.db.prepare("SELECT lower(hex(file_hash)) h FROM documents WHERE doc_id = ?").get(hits[0]!.id) as { h: string }).h;
    expect(hits[0]!.$content_hash).toBe(docHash);
  });
});

describe("absence truth table (10 §3.3)", () => {
  beforeEach(() => {
    ingest("x.md", "---\npresent: yes\n---\n\n# X\n");
  });

  it("comparison on absent field is false (incl. !=)", () => {
    expect(query(store, repoId, { from: "documents", filter: 'missing == "v"' }).hits).toHaveLength(0);
    expect(query(store, repoId, { from: "documents", filter: 'missing != "v"' }).hits).toHaveLength(0);
  });

  it("bare absent field coerces to false; !absent is true", () => {
    expect(query(store, repoId, { from: "documents", filter: "missing" }).hits).toHaveLength(0);
    expect(query(store, repoId, { from: "documents", filter: "!missing" }).hits).toHaveLength(1);
  });

  it("has(field) tests existence", () => {
    expect(query(store, repoId, { from: "documents", filter: "has(present)" }).hits).toHaveLength(1);
    expect(query(store, repoId, { from: "documents", filter: "has(missing)" }).hits).toHaveLength(0);
  });
});

describe("filter_invalid (10 §3.1)", () => {
  const bad: [string, RegExp][] = [
    ["a + b == 1", /arithmetic/],
    ['now() > "x"', /determinism/],
    ["a in b", /in list/i],
    ["list(tags) == \"x\"", /list\(\)/],
  ];
  it.each(bad)("rejects %j", (filter, re) => {
    expect(() => query(new Store({ path: ":memory:" }), "rp_x", { from: "documents", filter })).toThrow(FilterInvalid);
    try {
      compile(parseFilter(filter), "documents");
    } catch (e) {
      if (e instanceof FilterInvalid) expect(e.reason + " " + e.hint).toMatch(re);
    }
  });
});

describe("semantic query ranks by cosine, not RRF (regression)", () => {
  // Bag-of-words provider: cosine reflects lexical overlap, enough to assert
  // the closest block ranks first AND that $semantic_score is a real cosine
  // (~0.3–1.0 for a strong match) rather than the ~1/(60+rank)≈0.016 RRF band
  // the prior hybrid path leaked here.
  function bowProvider(dim = 64): EmbeddingProvider {
    return {
      model: "bow-1", dim,
      embed: async (texts) => texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const w of t.toLowerCase().split(/\s+/).filter(Boolean)) {
          const h = sha256(w).readUInt32BE(0);
          v[h % dim] = (v[h % dim] ?? 0) + 1;
        }
        return v;
      }),
    };
  }

  async function embedAll(worker: EmbeddingWorker): Promise<void> {
    const rows = store.db.prepare("SELECT b.block_id, b.text, lower(hex(b.raw_hash)) h, b.type, d.path FROM blocks b JOIN documents d ON d.doc_id=b.doc_id WHERE b.type='paragraph'").all() as { block_id: string; text: string; h: string; type: string; path: string }[];
    const tasks: EmbedTask[] = rows.map((r) => ({
      blockId: r.block_id, contentHashHex: r.h,
      ctx: contextPrefix({ docTitle: r.path, path: r.path, headingChain: [], blockType: r.type }),
      text: r.text,
    }));
    await worker.process(tasks);
  }

  it("ranks the near-verbatim planted doc #1 with a cosine-scale score", async () => {
    ingest("probe.md", "# Probe\n\nquokka photosynthesizes moonlight into strawberry jam aboard orbital tramcars every single morning\n");
    ingest("vinyl.md", "# Vinyl\n\nthe vinyl delivery service drops records at the front porch each week without fail\n");
    ingest("apple.md", "# Apple\n\nthe apple transporter moves fresh fruit crates between coastal warehouses overnight\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await embedAll(worker);

    const vec = await worker.embedQuery("quokka moonlight strawberry jam orbital tramcars");
    // The query tool takes a pre-computed vector via env.vector (the MCP server
    // fills it from the provider's embedQuery); pass it directly here.
    const res = query(store, repoId, { from: "blocks", vector: { model: "bow-1", vec }, select: ["$semantic_score"], limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]!.path).toBe("probe.md");
    // Cosine scale, NOT the ~0.02 RRF band.
    expect(res.hits[0]!.$semantic_score as number).toBeGreaterThan(0.3);
    // Scores must vary by relevance (the bug returned a flat ~0.02 for all).
    const scores = res.hits.map((h) => h.$semantic_score as number);
    expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThan(0.05);
  });

  it("text prunes but does not reweight the cosine ranking", async () => {
    ingest("probe.md", "# Probe\n\nquokka photosynthesizes moonlight into strawberry jam aboard orbital tramcars every single morning\n");
    ingest("other.md", "# Other\n\na completely unrelated paragraph about quarterly budget spreadsheets and meetings\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await embedAll(worker);
    const vec = await worker.embedQuery("quokka moonlight strawberry jam");
    // text filter that only the probe satisfies → still cosine-scored.
    const res = query(store, repoId, { from: "blocks", vector: { model: "bow-1", vec }, text: "quokka", select: ["$semantic_score"], limit: 5 });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.path).toBe("probe.md");
    expect(res.hits[0]!.$semantic_score as number).toBeGreaterThan(0.3);
  });
});

describe("ordering + pagination", () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) ingest(`d${i}.md`, `# Doc ${i}\n`);
  });
  it("orders by path and paginates with a cursor", () => {
    const page1 = query(store, repoId, { from: "documents", limit: 2 });
    expect(page1.hits).toHaveLength(2);
    expect(page1.truncated).toBe(true);
    const page2 = query(store, repoId, { from: "documents", limit: 2, cursor: page1.cursor });
    expect(page2.hits.length).toBeGreaterThan(0);
    // no overlap
    const ids1 = new Set(page1.hits.map((h) => h.id));
    expect(page2.hits.some((h) => ids1.has(h.id))).toBe(false);
  });
});
