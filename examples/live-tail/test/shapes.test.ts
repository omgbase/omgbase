import { describe, expect, it } from "vitest";
import { changesOf, digestOf, docVersionsOf, readAtOf, revisionOf, unifiedOf, versionOf } from "../src/lib/shapes.ts";

// The wire (surface 5.0: `_id`, `_path`, `_hash`, …) and the typed shape the demo keeps (`id`, `path`, `hash`).
const wireRev = { _id: "d_a", _path: "/notes/alpha.md", _hash: "aa" };
const rev = { id: "d_a", path: "/notes/alpha.md", hash: "aa" };

describe("changes_since", () => {
  it("reads a revision `{ _id, _path, _hash }` — or a 4.x server's `{ id, path, hash }`; a missing or mistyped key reads as empty", () => {
    expect(revisionOf(wireRev)).toEqual(rev);
    expect(revisionOf(rev)).toEqual(rev);
    expect(revisionOf({ _path: "/notes/alpha.md", _id: 7 })).toEqual({ id: "", path: "/notes/alpha.md", hash: "" });
  });
  it("a digest keeps its own keys and reads its revisions; a page keeps cursor/truncated/head", () => {
    const d = { commit: "c_7", seq: 7, ts: "2026-10-11T01:00:00Z", origin: "api", actor: "agent:mcp", summary: "s", revisions: [wireRev] };
    const want = { ...d, revisions: [rev] };
    expect(digestOf(d)).toEqual(want);
    expect(digestOf({ ...d, actor: null, revisions: [] })).toEqual({ ...want, actor: null, revisions: [] }); // a deletion or move
    expect(digestOf({ ...d, revisions: "nope" })).toEqual({ ...want, revisions: [] });
    expect(changesOf({ digests: [d], cursor: 7, truncated: false, head: 7 })).toEqual({ digests: [want], cursor: 7, truncated: false, head: 7 });
    expect(changesOf({ digests: [d], cursor: 7, truncated: true, head: 9 })).toEqual({ digests: [want], cursor: 7, truncated: true, head: 9 });
    expect(changesOf({ cursor: 0, head: 0 })).toEqual({ digests: [], cursor: 0, truncated: false, head: 0 });
  });
});

describe("docs_history", () => {
  const wireV = { _rev: "r_2", _seq: 2, _commit: "c_2", _ts: "2026-10-11T01:00:00Z", _origin: "observed", _actor: null, _hash: "h2", _is_current: true, _archived: false };
  const v = { rev: "r_2", seq: 2, commit: "c_2", updated_at: "2026-10-11T01:00:00Z", origin: "observed", actor: null, hash: "h2", isCurrent: true };
  it("a version is a `revisions` row: `{ _rev, _seq, _commit, _ts, _origin, _actor, _hash, _is_current }` — or the 4.x `{ rev, seq, commit, updated_at, origin, actor, hash, isCurrent }`", () => {
    expect(versionOf(wireV)).toEqual(v);
    expect(versionOf(v)).toEqual(v);
    expect(versionOf({ _rev: "r_1" })).toEqual({ rev: "r_1", seq: 0, commit: "", updated_at: "", origin: "", actor: null, hash: "", isCurrent: false });
  });
  it("a document: `{ _id, _path, deleted, currentRev, versions }`", () => {
    const d = { _id: "d_a", _path: "/notes/alpha.md", deleted: false, currentRev: "r_2", versions: [wireV] };
    expect(docVersionsOf(d)).toEqual({ id: "d_a", path: "/notes/alpha.md", deleted: false, currentRev: "r_2", versions: [v] });
    expect(docVersionsOf({ _id: "d_g", _path: "/gone.md", deleted: true, currentRev: null })).toEqual({ id: "d_g", path: "/gone.md", deleted: true, currentRev: null, versions: [] });
    expect(docVersionsOf({ id: "d_g", path: "/gone.md", deleted: true, currentRev: null })).toEqual({ id: "d_g", path: "/gone.md", deleted: true, currentRev: null, versions: [] });
  });
});

describe("docs_diff_unified / docs_read_at", () => {
  it("the unified diff: `{ _id, _path, from, to, diff }`", () => {
    const want = { id: "d_a", path: "/notes/alpha.md", from: "r_1", to: "r_2", diff: "@@ -1 +1 @@\n-a\n+b" };
    expect(unifiedOf({ _id: "d_a", _path: "/notes/alpha.md", from: "r_1", to: "r_2", diff: want.diff })).toEqual(want);
    expect(unifiedOf(want)).toEqual(want); // the 4.x spelling
    expect(unifiedOf({ _id: "d_a", _path: "/notes/alpha.md", from: "r_1", to: "r_2", diff: undefined })).toEqual({ ...want, diff: "" });
  });
  it("the bytes at a revision: `{ _id, _path, rev, _raw }`", () => {
    expect(readAtOf({ _id: "d_a", _path: "/notes/alpha.md", rev: "r_1", _raw: "# Alpha\n", renderedHashMatch: true })).toEqual({ id: "d_a", path: "/notes/alpha.md", rev: "r_1", raw: "# Alpha\n" });
    expect(readAtOf({ id: "d_a", path: "/notes/alpha.md", rev: "r_1", raw: "# Alpha\n" })).toEqual({ id: "d_a", path: "/notes/alpha.md", rev: "r_1", raw: "# Alpha\n" });
    expect(readAtOf({ _path: "/x.md", rev: "r_1" }).raw).toBe("");
  });
});
