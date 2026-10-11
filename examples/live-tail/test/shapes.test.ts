import { describe, expect, it } from "vitest";
import { changesOf, digestOf, docVersionsOf, dollarNames, readAtOf, revisionOf, unifiedOf, versionOf } from "../src/lib/shapes.ts";

const rev3 = { $id: "d_a", $path: "/notes/alpha.md", $hash: "aa" };
const rev2 = { doc: "d_a", path: "/notes/alpha.md", contentHash: "aa" };
const want = { doc: "d_a", path: "/notes/alpha.md", contentHash: "aa" };

describe("dollarNames", () => {
  it("is 3.0 and later; unknown, 1.x and 2.x read the old spellings", () => {
    expect(dollarNames("3.0")).toBe(true);
    expect(dollarNames("3.1")).toBe(true);
    expect(dollarNames("2.0")).toBe(false);
    expect(dollarNames("1.x")).toBe(false);
    expect(dollarNames(null)).toBe(false);
  });
});

describe("changes_since", () => {
  it("reads a revision by the server's generation — the same internal shape from both", () => {
    expect(revisionOf("3.0", rev3)).toEqual(want);
    expect(revisionOf("2.0", rev2)).toEqual(want);
    expect(revisionOf(null, rev2)).toEqual(want);
    // The wrong generation finds nothing — the spellings do not overlap.
    expect(revisionOf("3.0", rev2)).toEqual({ doc: "", path: "", contentHash: "" });
  });
  it("a digest keeps its own keys and reads its revisions; a page keeps cursor/truncated/head", () => {
    const d3 = { commit: "c_7", seq: 7, ts: "2026-10-11T01:00:00Z", origin: "api", actor: "agent:mcp", summary: "s", revisions: [rev3] };
    const d2 = { ...d3, revisions: [rev2] };
    const wantDigest = { commit: "c_7", seq: 7, ts: "2026-10-11T01:00:00Z", origin: "api", actor: "agent:mcp", summary: "s", revisions: [want] };
    expect(digestOf("3.0", d3)).toEqual(wantDigest);
    expect(digestOf("2.x", d2)).toEqual(wantDigest);
    expect(digestOf("3.0", { ...d3, actor: null, revisions: [] })).toEqual({ ...wantDigest, actor: null, revisions: [] }); // a deletion or move
    expect(changesOf("3.0", { digests: [d3], cursor: 7, truncated: false, head: 7 })).toEqual({ digests: [wantDigest], cursor: 7, truncated: false, head: 7 });
    expect(changesOf("2.0", { digests: [d2], cursor: 7, truncated: true, head: 9 })).toEqual({ digests: [wantDigest], cursor: 7, truncated: true, head: 9 });
    expect(changesOf("3.0", { cursor: 0, head: 0 })).toEqual({ digests: [], cursor: 0, truncated: false, head: 0 });
  });
});

describe("docs_history", () => {
  const v3 = { rev: "r_2", seq: 2, commit: "c_2", $updated_at: "2026-10-11T01:00:00Z", origin: "observed", actor: null, $hash: "h2", isCurrent: true };
  const v2 = { rev: "r_2", seq: 2, commit: "c_2", ts: "2026-10-11T01:00:00Z", origin: "observed", actor: null, contentHash: "h2", isCurrent: true };
  const wantV = { rev: "r_2", seq: 2, commit: "c_2", ts: "2026-10-11T01:00:00Z", origin: "observed", actor: null, contentHash: "h2", isCurrent: true };
  it("a version: `$updated_at`/`$hash` on 3.0, `ts`/`contentHash` before", () => {
    expect(versionOf("3.0", v3)).toEqual(wantV);
    expect(versionOf("2.0", v2)).toEqual(wantV);
  });
  it("a document: `$id`/`$path` on 3.0, `docId`/`path` before; the versions follow", () => {
    const wantD = { docId: "d_a", path: "/notes/alpha.md", deleted: false, currentRev: "r_2", versions: [wantV] };
    expect(docVersionsOf("3.0", { $id: "d_a", $path: "/notes/alpha.md", deleted: false, currentRev: "r_2", versions: [v3] })).toEqual(wantD);
    expect(docVersionsOf("2.0", { docId: "d_a", path: "/notes/alpha.md", deleted: false, currentRev: "r_2", versions: [v2] })).toEqual(wantD);
    expect(docVersionsOf("3.0", { $id: "d_g", $path: "/gone.md", deleted: true, currentRev: null })).toEqual({ docId: "d_g", path: "/gone.md", deleted: true, currentRev: null, versions: [] });
  });
});

describe("diff_unified / docs_read_at", () => {
  it("the unified diff: `$id`/`$path` vs `doc`/`path`; the diff text is the same", () => {
    const want = { doc: "d_a", path: "/notes/alpha.md", from: "r_1", to: "r_2", diff: "@@ -1 +1 @@\n-a\n+b" };
    expect(unifiedOf("3.0", { $id: "d_a", $path: "/notes/alpha.md", from: "r_1", to: "r_2", diff: want.diff })).toEqual(want);
    expect(unifiedOf("2.0", { doc: "d_a", path: "/notes/alpha.md", from: "r_1", to: "r_2", diff: want.diff })).toEqual(want);
  });
  it("the bytes at a revision: `$raw` on 3.0, `content` before", () => {
    const want = { doc: "d_a", path: "/notes/alpha.md", rev: "r_1", content: "# Alpha\n" };
    expect(readAtOf("3.0", { $id: "d_a", $path: "/notes/alpha.md", rev: "r_1", $raw: "# Alpha\n", renderedHashMatch: true })).toEqual(want);
    expect(readAtOf("2.0", { path: "/notes/alpha.md", docId: "d_a", rev: "r_1", content: "# Alpha\n" })).toEqual(want);
    expect(readAtOf("3.0", { path: "/x.md", docId: "d_a", rev: "r_1", content: "stale shape" }).content).toBe("");
  });
});
