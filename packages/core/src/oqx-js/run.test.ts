import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { BARE_NEEDS_SELECT_MESSAGE, BARE_WITH_VALUES_MESSAGE, oqxRun } from "./run.js";

// The runner's `bare` option (spec/surface §1.4, 4.2): the fixtures
// (`query-docs::bare-*`) pin the results over the alchemy corpus; this pins the
// rules at the unit — where the envelope is stripped (last), what is refused
// (before the engine runs), and that the default shape is untouched.
let store: Store;
let repoId: string;
beforeAll(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "bare", "/tmp");
  ingestFile(store, repoId, "a.md", "---\nkind: x\nid: authored-a\n---\n\n# A\n");
  ingestFile(store, repoId, "b.md", "---\nkind: x\n---\n\n# B\n");
  ingestFile(store, repoId, "c.md", "---\nkind: y\n---\n\n# C\n");
});
afterAll(() => store.close());

const docIds = (): string[] => oqxRun(store, repoId, "from docs").hits.map((h) => h.id);

describe("oqxRun bare (spec/surface §1.4, 4.2)", () => {
  it("a bare hit is the projection only — no automatic id/path", () => {
    const res = oqxRun(store, repoId, "select title, kind from docs order by path", { bare: true });
    expect(res.hits).toEqual([{ title: "A", kind: "x" }, { title: "B", kind: "x" }, { title: "C", kind: "y" }]);
    expect(res.consumer).toBe("collect");
    // the default shape is unchanged
    const enveloped = oqxRun(store, repoId, "select title, kind from docs order by path");
    expect(enveloped.hits.map((h) => Object.keys(h))).toEqual([["id", "path", "title", "kind"], ["id", "path", "title", "kind"], ["id", "path", "title", "kind"]]);
  });

  it("first/single return their one hit bare; the scalar consumers ignore the option", () => {
    expect(oqxRun(store, repoId, 'docs first { select title where kind == "y" }', { bare: true }).hits).toEqual([{ title: "C" }]);
    expect(oqxRun(store, repoId, 'docs single { select title where kind == "y" }', { bare: true }).hits).toEqual([{ title: "C" }]);
    expect(oqxRun(store, repoId, 'docs count { where kind == "x" }', { bare: true })).toMatchObject({ consumer: "count", count: 2, hits: [] });
    expect(oqxRun(store, repoId, 'docs exists { where kind == "x" }', { bare: true })).toMatchObject({ consumer: "exists", exists: true });
    expect(oqxRun(store, repoId, 'docs none { where kind == "z" }', { bare: true })).toMatchObject({ consumer: "none", none: true });
  });

  it("refuses the bare envelope query (no select) and a values projection, before the engine runs", () => {
    expect(() => oqxRun(store, repoId, "from docs", { bare: true })).toThrow(BARE_NEEDS_SELECT_MESSAGE);
    expect(() => oqxRun(store, repoId, 'from docs where kind == "nope"', { bare: true })).toThrow(BARE_NEEDS_SELECT_MESSAGE);
    expect(() => oqxRun(store, repoId, "select title values from docs", { bare: true })).toThrow(BARE_WITH_VALUES_MESSAGE);
    expect(() => oqxRun(store, repoId, "docs first { select title values }", { bare: true })).toThrow(BARE_WITH_VALUES_MESSAGE);
    expect(BARE_NEEDS_SELECT_MESSAGE).toBe("`bare` needs a `select` — without a projection a hit is only its envelope");
    expect(BARE_WITH_VALUES_MESSAGE).toBe("`bare` is redundant with `values` — `values` is already the bare-values form; drop one");
    // `bare: false` is the default
    expect(oqxRun(store, repoId, "from docs", { bare: false }).hits).toHaveLength(3);
  });

  it("a projected id/path is the intrinsic under the query's key; data.id stays the authored key; no collision check", () => {
    const [a] = docIds();
    expect(oqxRun(store, repoId, 'select id from docs where path == "/a.md"', { bare: true }).hits).toEqual([{ id: a }]);
    expect(oqxRun(store, repoId, 'select id, path from docs where path == "/a.md"', { bare: true }).hits).toEqual([{ id: a, path: "/a.md" }]);
    expect(oqxRun(store, repoId, 'select authored: data.id from docs where path == "/a.md"', { bare: true }).hits).toEqual([{ authored: "authored-a" }]);
    // the default mode refuses these two; bare has no envelope to collide with
    expect(() => oqxRun(store, repoId, 'select data.id from docs where path == "/a.md"')).toThrow("collides with the hit envelope");
    expect(oqxRun(store, repoId, 'select data.id from docs where path == "/a.md"', { bare: true }).hits).toEqual([{ id: "authored-a" }]);
    expect(oqxRun(store, repoId, 'select path: kind from docs where title == "C"', { bare: true }).hits).toEqual([{ path: "y" }]);
  });

  it("distinct dedups by the whole projection — a projected id counts under bare, collapses under the envelope", () => {
    expect(oqxRun(store, repoId, 'select distinct kind from docs where kind == "x"', { bare: true }).hits).toEqual([{ kind: "x" }]);
    expect(oqxRun(store, repoId, 'select distinct id, kind from docs where kind == "x"', { bare: true }).hits).toHaveLength(2);
    expect(oqxRun(store, repoId, 'select distinct id, kind from docs where kind == "x"').hits).toHaveLength(1);
  });

  it("paging is unchanged: identity is kept internally and the envelope stripped last, so truncated/cursor match the enveloped query", () => {
    const enveloped = oqxRun(store, repoId, "select title from docs", { limit: 2 });
    const bare = oqxRun(store, repoId, "select title from docs", { limit: 2, bare: true });
    expect(bare.hits).toEqual([{ title: "A" }, { title: "B" }]);
    expect(bare.truncated).toBe(true);
    expect(bare.cursor).toBe(enveloped.cursor);
    const next = oqxRun(store, repoId, "select title from docs", { limit: 2, bare: true, cursor: bare.cursor });
    expect(next.hits).toEqual([{ title: "C" }]);
    expect(next.truncated).toBe(false);
    // the query's own limit/offset bound the set before the page, as always
    expect(oqxRun(store, repoId, "select title from docs limit 1 offset 1", { bare: true }).hits).toEqual([{ title: "B" }]);
  });

  it("nested blocks are values, not hits, and keep their {id, path} rendering under bare", () => {
    const res = oqxRun(store, repoId, 'select title, others: ^docs collect { where kind == "y" } from docs where path == "/a.md"', { bare: true });
    const [c] = oqxRun(store, repoId, 'from docs where kind == "y"').hits;
    expect(res.hits).toEqual([{ title: "A", others: [{ id: c!.id, path: "/c.md" }] }]);
  });
});
