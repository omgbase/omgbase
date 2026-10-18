import { describe, it, expect, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { observeBatch } from "../../sync/observe.js";
import { sequentialMinter, setIdMinter } from "../ids.js";
import { readDocumentAtRevision, reconstructContent } from "../read/document.js";
import { diffBlocks } from "../../graph/history.js";
import {
  CHECKPOINT_EVERY, DeltaError, TreeResolver, applyOps, byteLength, encodeBodyDelta, encodeFrontmatterDelta, encodeFrontmatterDeltaRefs,
  isCheckpointSeq, parseFrontmatterBlob, parseNodeText, setCheckpointEvery, splitLines,
} from "./delta.js";

// Delta tree nodes (spec/store §4.1 "Delta nodes", §4.4 "Checkpoints", 16.0):
// the encodings, the resolver, and — the deliverable that decides whether the
// design ships — the MEASUREMENT: new history bytes per revision under the
// 16.0 encoding against the 15.x one (every revision a checkpoint, which
// `setCheckpointEvery(1)` reproduces exactly), on the five scenarios of the
// brief, plus the reconstruct timing over a chain of deltas. The numbers are
// pinned here and copied into spec/store/README.md §10 (Decisions, 16.0).

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  setIdMinter(null);
  setCheckpointEvery(null);
});

function fresh(): { store: Store; repoId: string } {
  setIdMinter(sequentialMinter());
  store = new Store({ path: ":memory:" });
  return { store, repoId: ensureRepo(store, "fixture", null) };
}

/** Bytes of history rows (blobs + tree_nodes) a store holds — what a revision ADDS is the difference across an observe. */
function historyBytes(s: Store): { blobs: number; nodes: number } {
  const blobs = (s.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM blobs").get() as { n: number }).n;
  const nodes = (s.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(entries AS BLOB))), 0) AS n FROM tree_nodes").get() as { n: number }).n;
  return { blobs, nodes };
}

interface Step {
  path: string;
  source: string;
  ts: string;
}

/** Observe each step in order; return the history bytes each revision added (blobs + nodes), first revision included. */
function measure(steps: Step[], checkpointEvery: number | null): { blobs: number; nodes: number; total: number }[] {
  setCheckpointEvery(checkpointEvery);
  const { store: s, repoId } = fresh();
  const out: { blobs: number; nodes: number; total: number }[] = [];
  let before = historyBytes(s);
  for (const st of steps) {
    observeBatch(s, repoId, [{ path: st.path, content: st.source }], st.ts, {});
    const after = historyBytes(s);
    out.push({ blobs: after.blobs - before.blobs, nodes: after.nodes - before.nodes, total: after.blobs - before.blobs + after.nodes - before.nodes });
    before = after;
  }
  s.close();
  store = undefined;
  return out;
}

const T = (i: number): string => `2026-10-17T10:${String(i).padStart(2, "0")}:00.000Z`;

describe("delta encoding", () => {
  it("groups the Myers script into =, ~, + and - ops and applies back exactly", () => {
    const base = ["a", "b", "c", "d"];
    expect(encodeBodyDelta(base, ["a", "b", "c", "d"])).toBe('{"d":[["=",4]]}');
    expect(encodeBodyDelta(base, ["a", "X", "c", "d"])).toBe('{"d":[["=",1],["~",X],["=",2]]}');
    expect(encodeBodyDelta(base, ["a", "b", "c", "d", "e"])).toBe('{"d":[["=",4],["+",e]]}');
    expect(encodeBodyDelta(base, ["a", "c", "d"])).toBe('{"d":[["=",1],["-"],["=",2]]}');
    expect(encodeBodyDelta(base, ["a", "X", "Y", "d"])).toBe('{"d":[["=",1],["~",X],["~",Y],["=",1]]}');
    expect(encodeBodyDelta([], ["a"])).toBe('{"d":[["+",a]]}');
    expect(applyOps([["=", 1], ["~", "X"], ["=", 2]], base)).toEqual(["a", "X", "c", "d"]);
    expect(applyOps([["=", 4], ["+", "e"]], base)).toEqual(["a", "b", "c", "d", "e"]);
    expect(() => applyOps([["=", 3]], base)).toThrow(DeltaError);
    expect(() => applyOps([["=", 5]], base)).toThrow(DeltaError);
  });

  it("frontmatter deltas are over lines with their endings and round-trip", () => {
    const a = "---\ntype: note\nlayer: draft\n---";
    const b = "---\ntype: note\nlayer: working\n---";
    const d = encodeFrontmatterDelta(a, b);
    expect(d).toBe('{"f":[["=",2],["~","layer: working\\n"],["=",1]]}');
    const parsed = parseFrontmatterBlob(d);
    expect(parsed?.form).toBe("delta");
    if (parsed?.form === "delta") expect(applyOps(parsed.ops, splitLines(a)).join("")).toBe(b);
    expect(parseFrontmatterBlob(a)).toEqual({ form: "full", raw: a });
    expect(splitLines("x\r\ny\n")).toEqual(["x\r\n", "y\n", ""]);
  });

  it("tells the two node forms apart by the first byte and rejects anything else", () => {
    expect(parseNodeText("[]")).toEqual({ form: "full", entries: [] });
    expect(parseNodeText('{"d":[["=",2]]}')).toEqual({ form: "delta", ops: [["=", 2]] });
    expect(parseNodeText('{"x":[]}')).toBeNull();
    expect(parseNodeText('{"d":[["=",0]]}')).toBeNull();
    expect(parseNodeText('{"d":[["?",1]]}')).toBeNull();
  });

  it("checkpoints at seq 1, 17, 33, …", () => {
    expect(CHECKPOINT_EVERY).toBe(16);
    expect([1, 2, 16, 17, 18, 33].map(isCheckpointSeq)).toEqual([true, false, false, true, false, true]);
  });
});

describe("delta nodes in the store", () => {
  it("writes a delta root for a one-paragraph edit and resolves every revision byte for byte", () => {
    const { store: s, repoId } = fresh();
    const docs = ["# A\n\nOne.\n\nTwo.\n\nThree.\n", "# A\n\nOne.\n\nTwo, edited.\n\nThree.\n", "# A\n\nOne.\n\nTwo, edited.\n\nThree.\n\nFour.\n"];
    docs.forEach((src, i) => observeBatch(s, repoId, [{ path: "a.md", content: src }], T(i), {}));
    const roots = s.db.prepare("SELECT r.seq, t.entries FROM revisions r JOIN tree_nodes t ON t.hash = r.root_tree ORDER BY r.seq").all() as { seq: number; entries: string }[];
    expect(roots[0]!.entries.startsWith("[")).toBe(true);
    expect(roots[1]!.entries).toMatch(/^\{"d":\[\["=",2\],\["~",/);
    // "Three." was the last block (trivia "\n"); it now carries "\n\n" and is followed by "Four.": one `~`, one `+`.
    expect(roots[2]!.entries).toMatch(/^\{"d":\[\["=",3\],\["~",\["b_3",/);
    expect(roots[2]!.entries).toContain('],["+",[');
    for (let i = 0; i < docs.length; i++) {
      const at = readDocumentAtRevision(s, "d_0", `r_${i}`)!;
      expect(at.raw).toBe(docs[i]);
      expect(at.renderedHashMatch).toBe(true);
    }
    expect(reconstructContent(s.db, "d_0")).toBe(docs[2]);
    // The matcher re-minted the rewritten paragraph (a delete + an insert) and "Four." is new.
    expect(diffBlocks(s, "d_0", "r_0", "r_2").map((e) => e.kind).sort()).toEqual(["added", "added", "removed"]);
  });

  it("a frontmatter-only edit reuses the self-contained root and writes a frontmatter delta", () => {
    const { store: s, repoId } = fresh();
    const fm = (k: string): string => `---\ntype: note\nlayer: ${k}\nstatus: open\nowner: alice\n---\n\n# A\n\nBody.\n`;
    observeBatch(s, repoId, [{ path: "a.md", content: fm("draft") }], T(0), {});
    observeBatch(s, repoId, [{ path: "a.md", content: fm("working") }], T(1), {});
    const revs = s.db.prepare("SELECT root_tree, frontmatter_blob FROM revisions ORDER BY seq").all() as { root_tree: Buffer; frontmatter_blob: Buffer }[];
    expect(revs[0]!.root_tree.equals(revs[1]!.root_tree)).toBe(true);
    const blob = s.db.prepare("SELECT bytes FROM blobs WHERE hash = ?").get(revs[1]!.frontmatter_blob) as { bytes: Buffer };
    expect(blob.bytes.toString("utf8")).toBe('{"f":[["=",2],["~","layer: working\\n"],["=",3]]}');
    expect(reconstructContent(s.db, "d_0")).toBe(fm("working"));
  });

  it("the resolver refuses a delta with no live base", () => {
    const { store: s, repoId } = fresh();
    observeBatch(s, repoId, [{ path: "a.md", content: "# A\n\nOne.\n" }], T(0), {});
    observeBatch(s, repoId, [{ path: "a.md", content: "# A\n\nTwo.\n" }], T(1), {});
    const r1 = s.db.prepare("SELECT root_tree FROM revisions WHERE seq = 2").get() as { root_tree: Buffer };
    // A delta read against a seq that has no predecessor (the fixture device: resolve it as if it were seq 1).
    expect(() => new TreeResolver(s.db).list("d_0", 1, r1.root_tree.toString("hex"), null)).toThrow(DeltaError);
  });
});

// ---- the measurement (spec/store §10, Decisions 16.0) ------------------------------------------

/** (a) six keys, five one-key edits — the 2f7b286 scenario. */
const SIX_KEYS: Step[] = (() => {
  const fm = (layer: string, status: string, owner: string, priority: number, updated: string): string =>
    `---\ntype: note\nlayer: ${layer}\nstatus: ${status}\nowner: ${owner}\npriority: ${priority}\nupdated: ${updated}\n---\n\n# Title\n\nBody.\n`;
  return [
    fm("draft", "open", "alice", 2, "2026-10-17T10:00:00Z"),
    fm("draft", "open", "alice", 2, "2026-10-17T10:01:00Z"),
    fm("draft", "active", "alice", 2, "2026-10-17T10:01:00Z"),
    fm("draft", "active", "alice", 1, "2026-10-17T10:01:00Z"),
    fm("working", "active", "alice", 1, "2026-10-17T10:01:00Z"),
    fm("working", "active", "bob", 1, "2026-10-17T10:01:00Z"),
  ].map((source, i) => ({ path: "a.md", source, ts: T(i) }));
})();

/** (b) a 40-block journal (two headings, 37 paragraphs, a list), five one-line appends to the list. */
const JOURNAL: Step[] = (() => {
  const paras = Array.from({ length: 37 }, (_, i) => `Entry ${i + 1}: something that happened and was written down.\n\n`).join("");
  const logs = ["09:00 started the day", "09:40 first thing done", "10:10 second thing done", "10:35 a decision taken", "12:30 lunch", "15:20 wrapped up"];
  return logs.map((_, i) => ({ path: "journal.md", ts: T(i), source: `# Journal\n\n${paras}## Log\n\n${logs.slice(0, i + 1).map((s) => `- ${s}\n`).join("")}` }));
})();

/** (c) a six-key YAML file, five one-key edits (the YAML adapter: one block per top-level entry). */
const YAML_STATE: Step[] = (() => {
  const y = (layer: string, status: string, owner: string, priority: number, updated: string): string =>
    `type: note\nlayer: ${layer}\nstatus: ${status}\nowner: ${owner}\npriority: ${priority}\nupdated: ${updated}\n`;
  return [
    y("draft", "open", "alice", 2, "2026-10-17T10:00:00Z"),
    y("draft", "open", "alice", 2, "2026-10-17T10:01:00Z"),
    y("draft", "active", "alice", 2, "2026-10-17T10:01:00Z"),
    y("draft", "active", "alice", 1, "2026-10-17T10:01:00Z"),
    y("working", "active", "alice", 1, "2026-10-17T10:01:00Z"),
    y("working", "active", "bob", 1, "2026-10-17T10:01:00Z"),
  ].map((source, i) => ({ path: "state.yaml", source, ts: T(i) }));
})();

/** (d) a ten-paragraph document, twenty one-paragraph edits. */
const CADENCE: Step[] = (() => {
  const src = (edits: number): string => {
    const counts = new Array<number>(10).fill(0);
    for (let i = 1; i <= edits; i++) counts[(i - 1) % 10]!++;
    return `# Ten\n\n${counts.map((c, p) => `Paragraph ${p + 1}${c > 0 ? ` (edit ${c})` : ""}.\n`).join("\n")}`;
  };
  return Array.from({ length: 21 }, (_, i) => ({ path: "ten.md", ts: T(i), source: src(i) }));
})();

function sum(xs: { total: number }[], from = 0): number {
  return xs.slice(from).reduce((n, x) => n + x.total, 0);
}

describe("measurement (spec/store §10, Decisions 16.0)", () => {
  it("(a) six-key frontmatter, five one-key edits: delta vs monolithic, inlined vs blob refs", () => {
    const delta = measure(SIX_KEYS, null);
    const mono = measure(SIX_KEYS, 1);
    // Revision 1 is identical under both (a checkpoint). Afterwards the 15.x
    // store adds the whole frontmatter blob (99–103 B, nothing else: the body
    // root is shared); 16.0 adds one delta blob and no node.
    expect(mono.slice(1).map((x) => x.total)).toEqual([99, 101, 101, 103, 101]);
    expect(delta.slice(1).map((x) => x.nodes)).toEqual([0, 0, 0, 0, 0]);
    expect(delta.slice(1).map((x) => x.total)).toEqual([63, 48, 45, 48, 44]);
    // The blob-reference variant: the same ops with a 64-hex reference per
    // changed line plus the line as its own blob — always larger than inlining
    // for lines under ~64 B, and never shared in practice (a changed line is new).
    const refs = SIX_KEYS.slice(1).map((st, i) => {
      const prev = SIX_KEYS[i]!.source.slice(0, SIX_KEYS[i]!.source.indexOf("\n---") + 4);
      const next = st.source.slice(0, st.source.indexOf("\n---") + 4);
      const r = encodeFrontmatterDeltaRefs(prev, next);
      return byteLength(r.text) + r.newBlobs.reduce((n, b) => n + byteLength(b), 0);
    });
    expect(refs).toEqual([126, 111, 108, 111, 107]);
    expect(sum(delta, 1)).toBeLessThan(sum(mono, 1) / 2);
  });

  it("(b) a 40-block journal, five appends to its last list: root + list deltas vs whole nodes", () => {
    const delta = measure(JOURNAL, null);
    const mono = measure(JOURNAL, 1);
    // 15.x: the whole root (40 entries, ~6.6 KB) and the whole list node every append.
    expect(mono.slice(1).map((x) => x.nodes)).toEqual([6800, 6901, 7002, 7103, 7204]);
    // 16.0: a 257 B root delta (`=39`, `~` the list) and a 122 B list delta (`=n`, `+` the item).
    expect(delta.slice(1).map((x) => x.nodes)).toEqual([379, 379, 379, 379, 379]);
    expect(delta.slice(1).map((x) => x.blobs)).toEqual(mono.slice(1).map((x) => x.blobs));
    // Blobs are identical under both (the list's raw and the new item); nodes
    // are 379 B against ~7 KB — about 14× less history per append all told.
    expect(sum(delta, 1) * 10).toBeLessThan(sum(mono, 1));
  });

  it("(c) a six-key YAML file, five one-key edits: the root is the whole file's entry list", () => {
    const delta = measure(YAML_STATE, null);
    const mono = measure(YAML_STATE, 1);
    // 15.x: six top-level entries → a ~740 B root per revision; 16.0: one `~` entry.
    expect(mono.slice(1).map((x) => x.nodes)).toEqual([738, 738, 738, 738, 739]);
    expect(delta.slice(1).map((x) => x.nodes)).toEqual([145, 152, 154, 151, 152]);
    expect(delta.slice(1).map((x) => x.blobs)).toEqual(mono.slice(1).map((x) => x.blobs));
  });

  it("(d) twenty edits of a ten-paragraph document: one full root per sixteen revisions", () => {
    const delta = measure(CADENCE, null);
    const mono = measure(CADENCE, 1);
    const nodes = delta.map((x) => x.nodes);
    expect(nodes[0]).toBe(1791); // seq 1, a checkpoint
    expect(nodes[16]).toBe(1800); // seq 17, a checkpoint
    for (let i = 1; i <= 20; i++) if (i !== 16) expect(nodes[i], `revision ${i + 1}`).toBeLessThan(200);
    expect(mono.slice(1).every((x) => x.nodes >= 1791)).toBe(true);
    const totalDelta = sum(delta);
    const totalMono = sum(mono);
    // 16.0 over the 21 revisions: two full roots + nineteen deltas, about a fifth of 15.x.
    expect(totalDelta).toBeLessThan(totalMono / 4);
    // Reconstruct timing over the chain: revision 16 is fifteen deltas deep.
    setCheckpointEvery(null);
    const { store: s, repoId } = fresh();
    for (const st of CADENCE) observeBatch(s, repoId, [{ path: st.path, content: st.source }], st.ts, {});
    const time = (rev: string): number => {
      const t0 = performance.now();
      for (let k = 0; k < 20; k++) expect(readDocumentAtRevision(s, "d_0", rev)!.renderedHashMatch).toBe(true);
      return (performance.now() - t0) / 20;
    };
    const deep = time("r_15"); // seq 16: 15 deltas back to seq 1
    const shallow = time("r_16"); // seq 17: a checkpoint
    const current = time("r_20"); // seq 21: 4 deltas back to seq 17
    console.log(`[delta timing] reconstruct at seq 16 (15 deltas): ${deep.toFixed(3)} ms; at seq 17 (checkpoint): ${shallow.toFixed(3)} ms; at seq 21 (4 deltas): ${current.toFixed(3)} ms`);
    expect(deep).toBeLessThan(50);
  });
});
