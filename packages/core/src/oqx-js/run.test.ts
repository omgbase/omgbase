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

const docIds = (): string[] => oqxRun(store, repoId, "from docs").hits.map((h) => h._id);

describe("oqxRun bare (spec/surface §1.4, 4.2)", () => {
  it("a bare hit is the projection only — no automatic _id/_path", () => {
    const res = oqxRun(store, repoId, "select _title, kind from docs order by _path", { bare: true });
    expect(res.hits).toEqual([{ _title: "A", kind: "x" }, { _title: "B", kind: "x" }, { _title: "C", kind: "y" }]);
    expect(res.consumer).toBe("collect");
    // the default shape is unchanged
    const enveloped = oqxRun(store, repoId, "select _title, kind from docs order by _path");
    expect(enveloped.hits.map((h) => Object.keys(h))).toEqual([["_id", "_path", "_title", "kind"], ["_id", "_path", "_title", "kind"], ["_id", "_path", "_title", "kind"]]);
  });

  it("first/single return their one hit bare; the scalar consumers ignore the option", () => {
    expect(oqxRun(store, repoId, 'docs first { select _title where kind == "y" }', { bare: true }).hits).toEqual([{ _title: "C" }]);
    expect(oqxRun(store, repoId, 'docs single { select _title where kind == "y" }', { bare: true }).hits).toEqual([{ _title: "C" }]);
    expect(oqxRun(store, repoId, 'docs count { where kind == "x" }', { bare: true })).toMatchObject({ consumer: "count", count: 2, hits: [] });
    expect(oqxRun(store, repoId, 'docs exists { where kind == "x" }', { bare: true })).toMatchObject({ consumer: "exists", exists: true });
    expect(oqxRun(store, repoId, 'docs none { where kind == "z" }', { bare: true })).toMatchObject({ consumer: "none", none: true });
  });

  it("refuses the bare envelope query (no select) and a values projection, before the engine runs", () => {
    expect(() => oqxRun(store, repoId, "from docs", { bare: true })).toThrow(BARE_NEEDS_SELECT_MESSAGE);
    expect(() => oqxRun(store, repoId, 'from docs where kind == "nope"', { bare: true })).toThrow(BARE_NEEDS_SELECT_MESSAGE);
    expect(() => oqxRun(store, repoId, "select _title values from docs", { bare: true })).toThrow(BARE_WITH_VALUES_MESSAGE);
    expect(() => oqxRun(store, repoId, "docs first { select _title values }", { bare: true })).toThrow(BARE_WITH_VALUES_MESSAGE);
    expect(BARE_NEEDS_SELECT_MESSAGE).toBe("`bare` needs a `select` — without a projection a hit is only its envelope");
    expect(BARE_WITH_VALUES_MESSAGE).toBe("`bare` is redundant with `values` — `values` is already the bare-values form; drop one");
    // `bare: false` is the default
    expect(oqxRun(store, repoId, "from docs", { bare: false }).hits).toHaveLength(3);
  });

  it("a projected _id/_path is the attribute under the envelope's key; a bare id/path is the authored key (5.0: nothing is reserved); only an alias spelled as an envelope key collides", () => {
    const [a] = docIds();
    expect(oqxRun(store, repoId, 'select _id from docs where _path == "/a.md"', { bare: true }).hits).toEqual([{ _id: a }]);
    expect(oqxRun(store, repoId, 'select _id, _path from docs where _path == "/a.md"', { bare: true }).hits).toEqual([{ _id: a, _path: "/a.md" }]);
    // the authored `id:` key is the bare `id` (≡ `_data.id`): its own column beside the envelope in either mode
    expect(oqxRun(store, repoId, 'select id from docs where _path == "/a.md"', { bare: true }).hits).toEqual([{ id: "authored-a" }]);
    expect(oqxRun(store, repoId, 'select id from docs where _path == "/a.md"').hits).toEqual([{ _id: a, _path: "/a.md", id: "authored-a" }]);
    expect(oqxRun(store, repoId, 'select authored: _data.id from docs where _path == "/a.md"', { bare: true }).hits).toEqual([{ authored: "authored-a" }]);
    expect(oqxRun(store, repoId, 'select path: kind from docs where _title == "C"', { bare: true }).hits).toEqual([{ path: "y" }]);
    expect(oqxRun(store, repoId, 'select path: kind from docs where _title == "C"').hits).toEqual([{ _id: expect.any(String), _path: "/c.md", path: "y" }]);
    // an alias spelled `_id:`/`_path:` is refused in the default mode; bare has no envelope to collide with
    expect(() => oqxRun(store, repoId, 'select _id: kind from docs where _path == "/a.md"')).toThrow("projection `_id` collides with the hit envelope — alias it (`i: …`)");
    expect(() => oqxRun(store, repoId, 'select _path: kind from docs where _path == "/a.md"')).toThrow("projection `_path` collides with the hit envelope — alias it (`p: …`)");
    expect(oqxRun(store, repoId, 'select _id: kind from docs where _path == "/a.md"', { bare: true }).hits).toEqual([{ _id: "x" }]);
  });

  it("distinct dedups by the whole projection — a projected id counts under bare, collapses under the envelope", () => {
    expect(oqxRun(store, repoId, 'select distinct kind from docs where kind == "x"', { bare: true }).hits).toEqual([{ kind: "x" }]);
    expect(oqxRun(store, repoId, 'select distinct _id, kind from docs where kind == "x"', { bare: true }).hits).toHaveLength(2);
    expect(oqxRun(store, repoId, 'select distinct _id, kind from docs where kind == "x"').hits).toHaveLength(1);
  });

  it("paging is unchanged: identity is kept internally and the envelope stripped last, so truncated/cursor match the enveloped query", () => {
    const enveloped = oqxRun(store, repoId, "select _title from docs", { limit: 2 });
    const bare = oqxRun(store, repoId, "select _title from docs", { limit: 2, bare: true });
    expect(bare.hits).toEqual([{ _title: "A" }, { _title: "B" }]);
    expect(bare.truncated).toBe(true);
    expect(bare.cursor).toBe(enveloped.cursor);
    const next = oqxRun(store, repoId, "select _title from docs", { limit: 2, bare: true, cursor: bare.cursor });
    expect(next.hits).toEqual([{ _title: "C" }]);
    expect(next.truncated).toBe(false);
    // the query's own limit/offset bound the set before the page, as always
    expect(oqxRun(store, repoId, "select _title from docs limit 1 offset 1", { bare: true }).hits).toEqual([{ _title: "B" }]);
  });

  it("nested blocks are values, not hits, and keep their {_id, _path} rendering under bare", () => {
    const res = oqxRun(store, repoId, 'select _title, others: ^docs collect { where kind == "y" } from docs where _path == "/a.md"', { bare: true });
    const [c] = oqxRun(store, repoId, 'from docs where kind == "y"').hits;
    expect(res.hits).toEqual([{ _title: "A", others: [{ _id: c!._id, _path: "/c.md" }] }]);
  });
});
