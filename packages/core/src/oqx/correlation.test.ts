import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { oqxRun } from "./run.js";
import "../format/index.js"; // register format adapters so nodes are projected

// End-to-end tests for the `^name` one-scope-outward outer reference + the
// explicit root relations (repo.docs/nodes/blocks) + first/single lookups — the
// join-equivalent mechanism (see the OQX correlated-subqueries design note).

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
function run(src: string, opts?: { limit?: number; cursor?: string }) {
  return oqxRun(store, repoId, src, opts ?? {});
}

describe("OQX correlation — scalar ^ref against an explicit root (dependent join)", () => {
  beforeEach(() => {
    ingest("books/alpha.md", "---\nslug: alpha\ntitle: Alpha\n---\n\n# Alpha\n");
    ingest("books/beta.md", "---\nslug: beta\ntitle: Beta\n---\n\n# Beta\n");
    ingest("notes/n1.md", "---\nref: alpha\n---\n\n# note one\n");
    ingest("notes/n2.md", "---\nref: beta\n---\n\n# note two\n");
    ingest("notes/n3.md", "---\nref: ghost\n---\n\n# note three (dangling)\n");
  });

  it("collects the root docs whose slug equals the parent note's bound ref", () => {
    const { hits } = run(
      'from docs where $path.startsWith("notes/") select ref, books: repo.docs collect { where slug == ^ref select p: $path }',
    );
    const by = new Map(hits.map((h) => [h.path, (h.books as { p: string }[]).map((b) => b.p)]));
    expect(by.get("notes/n1.md")).toEqual(["books/alpha.md"]);
    expect(by.get("notes/n2.md")).toEqual(["books/beta.md"]);
    expect(by.get("notes/n3.md")).toEqual([]);
  });

  it("repo.docs exists is a correlated semi-join (only notes with a real book)", () => {
    const { hits } = run(
      'from docs where $path.startsWith("notes/") && repo.docs exists { where slug == ^ref } select ref',
    );
    expect(hits.map((h) => h.path).sort()).toEqual(["notes/n1.md", "notes/n2.md"]);
  });

  it("!repo.docs exists is a correlated anti-join (the dangling note)", () => {
    const { hits } = run(
      'from docs where $path.startsWith("notes/") && !repo.docs exists { where slug == ^ref } select ref',
    );
    expect(hits.map((h) => h.path)).toEqual(["notes/n3.md"]);
  });

  it("a root scan is genuinely global — not constrained to the parent's document", () => {
    const { hits } = run(
      'from docs where $path == "notes/n1.md" select ref, books: repo.docs collect { where slug == ^ref select p: $path }',
    );
    expect((hits[0]!.books as { p: string }[])[0]!.p).toBe("books/alpha.md");
  });
});

describe("OQX correlation — first / single zero-or-one lookups", () => {
  beforeEach(() => {
    ingest("people/ann.md", "---\npid: p1\nname: Ann\n---\n\n# Ann\n");
    ingest("people/bob.md", "---\npid: p2\nname: Bob\n---\n\n# Bob\n");
    ingest("work/t1.md", "---\nowner: p1\n---\n\n# task one\n");
    ingest("work/t2.md", "---\nowner: p2\n---\n\n# task two\n");
    ingest("work/t3.md", "---\nowner: p9\n---\n\n# orphan task\n");
  });

  it("single { … } returns exactly the one correlated record (or null when none)", () => {
    const { hits } = run(
      'from docs where $path.startsWith("work/") select owner, person: repo.docs single { where pid == ^owner select who: name }',
    );
    const by = new Map(hits.map((h) => [h.path, h.person as { who: string } | null]));
    expect(by.get("work/t1.md")).toEqual({ who: "Ann" });
    expect(by.get("work/t2.md")).toEqual({ who: "Bob" });
    expect(by.get("work/t3.md")).toBeNull();
  });

  it("first { … } returns a single record (zero-or-one), deterministically", () => {
    const { hits } = run(
      'from docs where $path == "work/t1.md" select owner, person: repo.docs first { where pid == ^owner select who: name }',
    );
    expect(hits[0]!.person).toEqual({ who: "Ann" });
  });

  it("single { … } fails loudly when the correlation matches more than one row", () => {
    ingest("people/ann2.md", "---\npid: p1\nname: Ann II\n---\n\n# Ann II\n");
    expect(() =>
      run('from docs where $path == "work/t1.md" select owner, person: repo.docs single { where pid == ^owner select who: name }'),
    ).toThrow(/single.*matched 2 rows/);
  });
});

describe("OQX correlation — lift + membership across sibling subqueries", () => {
  beforeEach(() => {
    ingest("cite/one.md", "---\nlayer: draft\n---\n\n# one\n\nSee [[alpha]] and [[beta]].\n");
    ingest("cite/two.md", "---\nlayer: draft\n---\n\n# two\n\nSee [[gamma]].\n");
    ingest("cite/none.md", "---\nlayer: draft\n---\n\n# none\n\njust prose.\n");
    ingest("src/alpha.md", "---\nslug: alpha\n---\n\n# Alpha\n");
    ingest("src/beta.md", "---\nslug: beta\n---\n\n# Beta\n");
    ingest("src/gamma.md", "---\nslug: gamma\n---\n\n# Gamma\n");
  });

  it("lifts the wikilink keys, then correlates root docs by membership in that set", () => {
    const { hits } = run(
      'from docs where nodes collect { ^keys: value where kind == "md:wikilink" } ' +
        "select p: $path, refs: repo.docs collect { where slug in ^keys select rp: $path }",
    );
    const by = new Map(hits.map((h) => [h.p, (h.refs as { rp: string }[]).map((r) => r.rp).sort()]));
    expect([...by.keys()].sort()).toEqual(["cite/one.md", "cite/two.md"]);
    expect(by.get("cite/one.md")).toEqual(["src/alpha.md", "src/beta.md"]);
    expect(by.get("cite/two.md")).toEqual(["src/gamma.md"]);
  });
});

describe("OQX correlation — same-document ^ref (no root relation needed)", () => {
  beforeEach(() => {
    ingest("a.md", "---\nfocus: ship oqx\n---\n\n# work\n\n- [ ] ship oqx\n- [ ] write docs\n");
  });

  it("a nested collect filters its own rows against a parent-bound value", () => {
    const { hits } = run(
      "from docs select focus, hot: nodes collect { where kind == \"md:task\" && value == ^focus select t: value }",
    );
    const hot = hits[0]!.hot as { t: string }[];
    expect(hot.map((h) => h.t)).toEqual(["ship oqx"]);
  });
});

describe("OQX correlation — loud failures", () => {
  beforeEach(() => {
    ingest("a.md", "---\nref: x\n---\n\n# a\n\n- [ ] t\n");
  });

  it("a ^ref with no matching binding one scope out is rejected", () => {
    expect(() =>
      run('from docs select refs: repo.docs collect { where slug == ^nope }'),
    ).toThrow(/no binding \^nope/);
  });

  it("a top-level ^ref (no enclosing scope) is rejected", () => {
    expect(() => run("from docs where ref == ^ref")).toThrow(/no binding \^ref/);
  });

  it("using a scalar binding as a collection (membership) is rejected", () => {
    expect(() =>
      run('from docs select ref, bad: repo.docs collect { where slug in ^ref }'),
    ).toThrow(/scalar binding/);
  });

  it("using a collection binding (a lift) as a scalar is rejected", () => {
    expect(() =>
      run('from docs where nodes collect { ^ks: value where kind == "md:task" } select bad: repo.docs collect { where slug == ^ks }'),
    ).toThrow(/collection binding/);
  });

  it("first/single are rejected in where position", () => {
    expect(() =>
      run('from docs where repo.docs first { where slug == "x" }'),
    ).toThrow(/select-position lookup/);
  });

  it("first/single are rejected nested inside a collect (top-level only, for now)", () => {
    expect(() =>
      run('from docs select outer: repo.docs collect { where slug == "x" select inner: repo.docs first { where slug == "y" } }'),
    ).toThrow(/only supported at the top-level select/);
  });
});
