import { describe, expect, it } from "vitest";
import { changesOf, digestOf, docVersionsOf, readAtOf, revisionOf, unifiedOf, versionOf } from "../src/lib/shapes.ts";

const rev = { id: "d_a", path: "/notes/alpha.md", hash: "aa" };

describe("changes_since", () => {
  it("reads a revision `{ id, path, hash }`; a missing or mistyped key reads as empty", () => {
    expect(revisionOf(rev)).toEqual(rev);
    expect(revisionOf({ path: "/notes/alpha.md", id: 7 })).toEqual({ id: "", path: "/notes/alpha.md", hash: "" });
  });
  it("a digest keeps its own keys and reads its revisions; a page keeps cursor/truncated/head", () => {
    const d = { commit: "c_7", seq: 7, ts: "2026-10-11T01:00:00Z", origin: "api", actor: "agent:mcp", summary: "s", revisions: [rev] };
    expect(digestOf(d)).toEqual(d);
    expect(digestOf({ ...d, actor: null, revisions: [] })).toEqual({ ...d, actor: null, revisions: [] }); // a deletion or move
    expect(digestOf({ ...d, revisions: "nope" })).toEqual({ ...d, revisions: [] });
    expect(changesOf({ digests: [d], cursor: 7, truncated: false, head: 7 })).toEqual({ digests: [d], cursor: 7, truncated: false, head: 7 });
    expect(changesOf({ digests: [d], cursor: 7, truncated: true, head: 9 })).toEqual({ digests: [d], cursor: 7, truncated: true, head: 9 });
    expect(changesOf({ cursor: 0, head: 0 })).toEqual({ digests: [], cursor: 0, truncated: false, head: 0 });
  });
});

describe("docs_history", () => {
  const v = { rev: "r_2", seq: 2, commit: "c_2", updated_at: "2026-10-11T01:00:00Z", origin: "observed", actor: null, hash: "h2", isCurrent: true };
  it("a version: `{ rev, seq, commit, updated_at, origin, actor, hash, isCurrent }`", () => {
    expect(versionOf(v)).toEqual(v);
    expect(versionOf({ rev: "r_1" })).toEqual({ rev: "r_1", seq: 0, commit: "", updated_at: "", origin: "", actor: null, hash: "", isCurrent: false });
  });
  it("a document: `{ id, path, deleted, currentRev, versions }`", () => {
    const d = { id: "d_a", path: "/notes/alpha.md", deleted: false, currentRev: "r_2", versions: [v] };
    expect(docVersionsOf(d)).toEqual(d);
    expect(docVersionsOf({ id: "d_g", path: "/gone.md", deleted: true, currentRev: null })).toEqual({ id: "d_g", path: "/gone.md", deleted: true, currentRev: null, versions: [] });
  });
});

describe("docs_diff_unified / docs_read_at", () => {
  it("the unified diff: `{ id, path, from, to, diff }`", () => {
    const want = { id: "d_a", path: "/notes/alpha.md", from: "r_1", to: "r_2", diff: "@@ -1 +1 @@\n-a\n+b" };
    expect(unifiedOf(want)).toEqual(want);
    expect(unifiedOf({ ...want, diff: undefined })).toEqual({ ...want, diff: "" });
  });
  it("the bytes at a revision: `{ id, path, rev, raw }`", () => {
    expect(readAtOf({ id: "d_a", path: "/notes/alpha.md", rev: "r_1", raw: "# Alpha\n", renderedHashMatch: true })).toEqual({ id: "d_a", path: "/notes/alpha.md", rev: "r_1", raw: "# Alpha\n" });
    expect(readAtOf({ path: "/x.md", rev: "r_1" }).raw).toBe("");
  });
});
