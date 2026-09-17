import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { processCheckpoint } from "../../src/sync/checkpoint.js";
import { parseTree, assertFullCoverage } from "../../src/core/parse/tree.js";
import { render } from "../../src/core/parse/render.js";
import { oqxRun } from "../../src/oqx/run.js";
import "../../src/format/index.js"; // registers format adapters (node projection)

// High-level OQX behaviour over a realistic interlinked corpus: an alchemy
// repository of 18 markdown documents under fixtures/alchemy — substances,
// processes, practitioners, texts, and lab notes, with frontmatter, inline
// fields (`key:: value`), wikilinks, markdown links, tasks, tables, code fences,
// and blockquotes.
//
// These are capability demonstrations AND the behavioral acceptance gate for the
// OQX engine (now the external @omgbase/oqx, bound to the store via
// src/oqx-js/): each case is a query a user would plausibly write, asserted
// against the exact documents it must return. Scalar-translator unit coverage
// lives in src/oqx-js/sql/translate.test.ts.

const DIR = fileURLToPath(new URL("./fixtures/alchemy/", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

let store: Store;
let repoId: string;

beforeAll(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "alchemy", DIR);
  // Ingest through processCheckpoint (the real sync path) rather than a bare
  // ingestFile loop, so the authored EDGE graph is extracted — wikilinks and
  // markdown links resolve to doc→doc `references` edges — which the graph-follow
  // demos below (`follow doc.out`/`in`) walk. ingestFile alone leaves `edges`
  // empty. Everything else (docs/blocks/nodes/properties) is identical.
  processCheckpoint(store, repoId, DIR, walk(DIR).map((f) => ({ path: relative(DIR, f) })));
});
afterAll(() => store.close());

/** Run an OQX query, returning hit paths (corpus is small; take them all). */
function paths(src: string): string[] {
  return oqxRun(store, repoId, src, { limit: 100 }).hits.map((h) => h.path);
}
function hits(src: string, limit = 100) {
  return oqxRun(store, repoId, src, { limit });
}

const SUBSTANCES = [
  "substances/mercury.md",
  "substances/philosophers-stone.md",
  "substances/prima-materia.md",
  "substances/salt.md",
  "substances/sulphur.md",
];

describe("alchemy corpus — shape", () => {
  it("ingests the whole repository", () => {
    expect(paths("from docs").length).toBe(18);
  });

  it("projects the node kinds the queries below rely on", () => {
    const kinds = store.db
      .prepare("SELECT DISTINCT kind FROM nodes ORDER BY kind")
      .all() as { kind: string }[];
    expect(kinds.map((k) => k.kind)).toEqual([
      "md:inline_field", "md:link", "md:section", "md:task", "md:wikilink",
    ]);
  });

  // Fixture integrity: every file is markdown the engine represents exactly, so
  // a query result can never be an artefact of a mangled parse.
  it.each(walk(DIR).map((f) => [relative(DIR, f), f] as const))(
    "%s round-trips byte-identically",
    (_name, path) => {
      const src = readFileSync(path, "utf8");
      const tree = parseTree(src);
      expect(assertFullCoverage(tree)).toBe(true);
      expect(render(tree)).toBe(src);
    },
  );
});

describe("alchemy corpus — scalar filtering (CEL reused inside OQX)", () => {
  it("filters on a frontmatter enum", () => {
    expect(paths('from docs where type == "substance"')).toEqual(SUBSTANCES);
  });

  it("list() spans scalar and list frontmatter — mercury's `tags` is a bare scalar", () => {
    // mercury.md has `tags: substance`; the others have `tags: [substance, …]`.
    expect(paths('from docs where "substance" in list(tags)')).toEqual(SUBSTANCES);
  });

  it("compares numbers", () => {
    expect(paths("from docs where era < 1000")).toEqual([
      "practitioners/jabir-ibn-hayyan.md",
      "practitioners/maria-prophetissa.md",
      "texts/emerald-tablet.md",
    ]);
  });

  it("negates a boolean, with absence counting as false", () => {
    expect(paths("from docs where !verified")).toEqual([
      "processes/magnum-opus.md",
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
      "texts/mutus-liber.md",
    ]);
  });

  it("filters on a path prefix via the intrinsic", () => {
    expect(paths('from docs where $path.startsWith("practitioners/")')).toEqual([
      "practitioners/jabir-ibn-hayyan.md",
      "practitioners/maria-prophetissa.md",
      "practitioners/newton.md",
      "practitioners/paracelsus.md",
    ]);
  });

  it("reads inline fields (`key:: value`) through list()", () => {
    // list() spans every cardinality, so this holds both under today's
    // always-list inline properties and after the rework makes a lone
    // occurrence scalar (at which point `element == "fire"` works too).
    expect(paths('from docs where "fire" in list(element)')).toEqual([
      "processes/calcination.md", // `element:: fire`
    ]);
  });

  it("combines several scalar terms", () => {
    expect(paths('from docs where type == "practitioner" && tradition == "western" && era > 1600')).toEqual([
      "practitioners/newton.md",
    ]);
  });
});

// The headline capability: a nested query bounded by the current row's own
// relation, so "documents that contain a matching node" is one expression.
describe("alchemy corpus — correlated node queries", () => {
  const WITH_ANY_TASK = [
    "lab/2026-01-notes.md",
    "lab/2026-02-notes.md",
    "practitioners/jabir-ibn-hayyan.md",
    "practitioners/newton.md",
    "practitioners/paracelsus.md",
    "processes/calcination.md",
    "processes/coagulation.md",
    "processes/dissolution.md",
    "processes/magnum-opus.md",
    "substances/salt.md",
    "texts/mutus-liber.md",
  ];

  it("finds documents that contain a task node", () => {
    expect(paths('from docs where nodes exists { where kind == "md:task" }')).toEqual(WITH_ANY_TASK);
  });

  it("narrows to documents with an OPEN task — salt.md drops out", () => {
    // salt.md carries only a checked supply list. It is the discriminator
    // proving the nested predicate is evaluated per document, not corpus-wide.
    const open = paths('from docs where nodes exists { where kind == "md:task" && !attrs.checked }');
    expect(open).toEqual(WITH_ANY_TASK.filter((p) => p !== "substances/salt.md"));
    expect(open).not.toContain("substances/salt.md");
  });

  it("is correlated, not a global scan — task-free documents never match", () => {
    const any = paths('from docs where nodes exists { where kind == "md:task" }');
    // Seven documents carry no tasks at all; a global (uncorrelated) subquery
    // would have returned every document in the corpus.
    for (const p of [
      "index.md",
      "substances/mercury.md",
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
      "substances/sulphur.md",
      "practitioners/maria-prophetissa.md",
      "texts/emerald-tablet.md",
    ]) {
      expect(any).not.toContain(p);
    }
    expect(any.length).toBe(11);
  });

  it("composes a document-level predicate with a node-level one", () => {
    expect(paths('from docs where type == "lab-note" && nodes exists { where kind == "md:task" && !attrs.checked }')).toEqual([
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
    ]);
  });

  it("enforces the corpus convention: no open bench work on substance pages", () => {
    // Actionable work lives in the lab notebooks; substance pages state open
    // questions as prose. salt.md is the one exception and its list is a
    // fully-checked supply order, not outstanding work.
    expect(paths('from docs where type == "substance" && nodes exists { where kind == "md:task" && !attrs.checked }')).toEqual([]);
    expect(paths('from docs where type == "substance" && nodes exists { where kind == "md:task" }')).toEqual([
      "substances/salt.md",
    ]);
  });

  it("reaches back to the owning document from INSIDE the nested query", () => {
    // Regression guard: an inner `JOIN docs d` here would shadow the outer `d`
    // and make the correlation a tautology, silently matching every document.
    const workingOpen = paths(
      'from docs where nodes exists { where kind == "md:task" && !attrs.checked && doc.layer == "working" }',
    );
    expect(workingOpen).toEqual([
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
      "practitioners/newton.md",
      "processes/coagulation.md",
    ]);
    // every hit really is a working-layer document
    const working = paths('from docs where layer == "working"');
    for (const p of workingOpen) expect(working).toContain(p);
  });

  it("finds documents that link out via wikilinks", () => {
    const linked = paths('from docs where nodes exists { where kind == "md:wikilink" }');
    expect(linked).toContain("index.md");
    expect(linked).toContain("substances/sulphur.md");
    expect(linked).not.toContain("texts/emerald-tablet.md"); // markdown links only
  });

  it("finds documents carrying a named inline field node", () => {
    expect(paths('from docs where nodes exists { where kind == "md:inline_field" && name == "operator" }')).toEqual([
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
    ]);
  });

  it("count { … } in where position means non-empty", () => {
    expect(paths('from docs where nodes count { where kind == "md:task" && !attrs.checked }'))
      .toEqual(paths('from docs where nodes exists { where kind == "md:task" && !attrs.checked }'));
  });
});

describe("alchemy corpus — correlated block queries", () => {
  it("finds documents containing a code fence", () => {
    expect(paths('from docs where blocks exists { where type == "code_fence" }')).toEqual([
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
      "processes/calcination.md",
      "processes/coagulation.md",
      "processes/dissolution.md",
    ]);
  });

  it("finds documents containing a table", () => {
    expect(paths('from docs where blocks exists { where type == "table" }')).toEqual([
      "index.md",
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
      "processes/magnum-opus.md",
      "substances/mercury.md",
    ]);
  });

  it("finds documents quoting a source (blockquote)", () => {
    expect(paths('from docs where blocks exists { where type == "blockquote" }')).toEqual([
      "practitioners/maria-prophetissa.md",
      "practitioners/paracelsus.md",
      "substances/prima-materia.md",
      "texts/emerald-tablet.md",
    ]);
  });

  it("combines a block predicate with a document predicate", () => {
    expect(paths('from docs where type == "process" && blocks exists { where type == "table" }')).toEqual([
      "processes/magnum-opus.md",
    ]);
  });

  it("finds bullet list items under an `Open questions` heading", () => {
    // The reference pages state open questions as prose bullets (block type
    // list_item) under an "Open questions" section. under_heading() scopes to a
    // heading's section by case-insensitive substring.
    const res = hits('from blocks where type == "list_item" && under_heading("Open questions") select text: text');
    expect(res.hits.map((h) => h.path)).toEqual([
      "substances/philosophers-stone.md",
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
      "substances/prima-materia.md",
    ]);
    expect(res.hits.map((h) => h.text)).toContain(
      "The shift from literal to allegorical readings is well documented; what caused it is still disputed.",
    );
  });

  it("distinguishes prose bullets from checkbox items under the same heading text", () => {
    // magnum-opus.md also has an "Open questions" section, but its items are
    // `- [ ]` checkboxes (block type task), not plain list_items — so the
    // list_item filter excludes it. This is the type discriminator, not luck.
    const anyBlock = paths('from docs where blocks exists { where under_heading("Open questions") }');
    expect(anyBlock).toContain("processes/magnum-opus.md"); // it HAS such a section

    const listItems = paths('from docs where blocks exists { where type == "list_item" && under_heading("Open questions") }');
    expect(listItems).toEqual([
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
    ]);
    expect(listItems).not.toContain("processes/magnum-opus.md"); // its items are tasks
  });

  it("matches the heading by case-insensitive substring", () => {
    const full = paths('from blocks where type == "list_item" && under_heading("Open questions")');
    const partial = paths('from blocks where type == "list_item" && under_heading("open")');
    expect(partial).toEqual(full);
  });
});

describe("alchemy corpus — section relations (md:section nodes)", () => {
  it("projects a section node per heading, named by its text", () => {
    // Every heading in the corpus becomes an md:section node; the reference
    // pages carry an "Open questions" section.
    const openQ = paths('from nodes where kind == "md:section" && name == "Open questions"');
    expect(openQ.sort()).toEqual([
      "processes/magnum-opus.md",
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
    ]);
  });

  it("section.blocks navigates the same content as under_heading, via section nodes", () => {
    // The list items OQX finds under an "Open questions" section node (a
    // node→blocks range-containment relation) are exactly those under_heading()
    // finds (a blocks structural fn) — two routes to the same section range.
    const viaSection = hits(
      'from nodes where kind == "md:section" && name == "Open questions" select items: section.blocks collect { where type == "list_item" select t: text }',
    ).hits.flatMap((h) => (h.items as { t: string }[]).map((i) => i.t)).sort();
    const viaHeading = hits(
      'from blocks where type == "list_item" && under_heading("Open questions") select text: text',
    ).hits.map((h) => h.text as string).sort();
    expect(viaSection).toEqual(viaHeading);
    expect(viaSection.length).toBe(4); // the two reference pages, two bullets each
  });

  it("block.section reaches a block's enclosing section (consistent with under_heading)", () => {
    // A list_item under "Open questions" has an enclosing section node of that
    // name — block.section (blocks→nodes) agrees with under_heading.
    const viaSection = paths(
      'from blocks where type == "list_item" && section exists { where name == "Open questions" }',
    ).sort();
    const viaHeading = paths(
      'from blocks where type == "list_item" && under_heading("Open questions")',
    ).sort();
    expect(viaSection).toEqual(viaHeading);
  });
});

describe("alchemy corpus — collect { … } projection", () => {
  it("shapes each lab note's open tasks into a nested list", () => {
    const res = hits(
      'from docs where type == "lab-note" select open: nodes collect { where kind == "md:task" && !attrs.checked select text: value }',
    );
    expect(res.hits.map((h) => h.path)).toEqual(["lab/2026-01-notes.md", "lab/2026-02-notes.md"]);
    expect(res.hits[0]!.open).toEqual([
      { text: "Repeat the series with copper" },
      { text: "Plot mass gain against heating time" },
      { text: "Tabulate the metal sulphides by colour" },
    ]);
    expect(res.hits[1]!.open).toEqual([
      { text: "Assay cycle 1 and cycle 4 crops for iron" },
      { text: "Write the plateau result up for the coagulation note" },
    ]);
  });

  it("projects without filtering — task-free documents still appear, with []", () => {
    const res = hits('from docs where type == "substance" select tasks: nodes collect { where kind == "md:task" }');
    const byPath = new Map(res.hits.map((h) => [h.path, h.tasks as unknown[]]));
    expect([...byPath.keys()]).toEqual(SUBSTANCES); // every substance is a hit
    // only salt.md carries a (checked, supply) list; the rest project []
    expect(byPath.get("substances/salt.md")!.length).toBe(2);
    for (const p of SUBSTANCES.filter((s) => s !== "substances/salt.md")) {
      expect(byPath.get(p)).toEqual([]);
    }
  });

  it("filters and shapes in one query", () => {
    const res = hits(
      'from docs where type == "process" && nodes exists { where kind == "md:task" && !attrs.checked } select open: nodes collect { where kind == "md:task" && !attrs.checked select text: value }',
    );
    expect(res.hits.map((h) => h.path)).toEqual([
      "processes/calcination.md",
      "processes/coagulation.md",
      "processes/dissolution.md",
      "processes/magnum-opus.md",
    ]);
    for (const h of res.hits) expect((h.open as unknown[]).length).toBeGreaterThan(0);
  });

  it("projects a named scalar alongside a collection", () => {
    const res = hits('from docs where type == "lab-note" select era: month, tasks: nodes collect { where kind == "md:task" }');
    expect(res.hits.map((h) => h.era)).toEqual([1, 2]);
    expect((res.hits[0]!.tasks as unknown[]).length).toBe(7); // January
    expect((res.hits[1]!.tasks as unknown[]).length).toBe(4); // February
  });
});

describe("alchemy corpus — shorthand vs longhand clause forms", () => {
  // A query body may spell its clauses explicitly (`where …`, `select …`) OR
  // lean on the implicit-clause shorthand: a LEADING predicate-shaped expression
  // is an implicit `where`, and a leading reference / `name: value` list is an
  // implicit `select`. The two spellings must lower to the same query — these
  // pair a longhand form against its shorthand and assert an identical result
  // (plus a concrete expectation, so a shared bug can't pass as "equal").

  it("nested implicit `where` (leading predicate) equals the explicit `where`", () => {
    const longhand = paths('from docs where nodes exists { where kind == "md:task" }');
    const shorthand = paths('from docs where nodes exists { kind == "md:task" }');
    expect(shorthand).toEqual(longhand);
    expect(shorthand.length).toBe(11); // the 11 documents that carry any task node
    expect(shorthand).toContain("lab/2026-01-notes.md");
  });

  it("top-level implicit `where` equals the explicit `where`", () => {
    const longhand = paths('from docs where type == "substance"');
    const shorthand = paths('from docs type == "substance"');
    expect(shorthand).toEqual(longhand);
    expect(shorthand).toEqual(SUBSTANCES);
  });

  it("a leading `&&` boolean expression is still an implicit `where`", () => {
    const longhand = paths(
      'from docs where type == "lab-note" && nodes exists { where kind == "md:task" && !attrs.checked }',
    );
    const shorthand = paths(
      'from docs type == "lab-note" && nodes exists { kind == "md:task" && !attrs.checked }',
    );
    expect(shorthand).toEqual(longhand);
    expect(shorthand).toEqual(["lab/2026-01-notes.md", "lab/2026-02-notes.md"]);
  });

  it("mixes forms: an implicit `where` + an explicit `select` inside one collect", () => {
    const shape = (src: string) =>
      hits(src).hits.map((h) => ({ path: h.path, open: h.open }));
    const longhand = shape(
      'from docs where type == "lab-note" select open: nodes collect { where kind == "md:task" && !attrs.checked select text: value }',
    );
    const shorthand = shape(
      'from docs type == "lab-note" select open: nodes collect { kind == "md:task" && !attrs.checked select text: value }',
    );
    expect(shorthand).toEqual(longhand);
    expect(shorthand[0]!.open).toEqual([
      { text: "Repeat the series with copper" },
      { text: "Plot mass gain against heating time" },
      { text: "Tabulate the metal sulphides by colour" },
    ]);
  });

  it("the readable both-clauses idiom: a leading projection, then an explicit `where`", () => {
    // `{ value where P }` — projection leads (implicit select, stopping at the
    // `where` keyword), then the explicit filter. This is the sensible implicit
    // shape when a block both projects AND filters (unlike `{ P value }`, where
    // the predicate would swallow the trailing reference).
    const shape = (src: string) =>
      hits(src).hits.map((h) => ({ path: h.path, open: h.open }));
    const longhand = shape(
      'from docs where type == "lab-note" select open: nodes collect { where kind == "md:task" && !attrs.checked select text: value }',
    );
    const projFirst = shape(
      'from docs where type == "lab-note" select open: nodes collect { text: value where kind == "md:task" && !attrs.checked }',
    );
    expect(projFirst).toEqual(longhand);
    expect(projFirst[0]!.open).toEqual([
      { text: "Repeat the series with copper" },
      { text: "Plot mass gain against heating time" },
      { text: "Tabulate the metal sulphides by colour" },
    ]);
  });

  it("an implicit `select` (bare reference) equals the explicit `select` projection", () => {
    // A collect body that is JUST a projection: implicit `{ value }` vs the
    // explicit `{ select value }`. (An implicit select cannot trail a `where`
    // without the `select` keyword to delimit it — the predicate scalar would
    // absorb the bare reference — so the shorthand shines when it stands alone.)
    const shape = (src: string) =>
      hits(src).hits.map((h) => ({ path: h.path, vals: h.vals }));
    const longhand = shape('from docs where type == "lab-note" select vals: nodes collect { select value }');
    const shorthand = shape('from docs where type == "lab-note" select vals: nodes collect { value }');
    expect(shorthand).toEqual(longhand);
    // every node's value projects (no filtering) — the lab notes are non-empty
    expect((shorthand[0]!.vals as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("alchemy corpus — lifts (^name: filter + capture in one expression)", () => {
  // The 10 documents carrying an open task, established by the corpus (see the
  // fixture README): both lab notebooks, three practitioners, all four
  // processes, and mutus-liber. salt has tasks but all CHECKED, so it never
  // appears among open-task results — the discriminator, now via lifts.
  const WITH_OPEN_TASK = [
    "lab/2026-01-notes.md",
    "lab/2026-02-notes.md",
    "practitioners/jabir-ibn-hayyan.md",
    "practitioners/newton.md",
    "practitioners/paracelsus.md",
    "processes/calcination.md",
    "processes/coagulation.md",
    "processes/dissolution.md",
    "processes/magnum-opus.md",
    "texts/mutus-liber.md",
  ];

  it("returns exactly the docs with open work AND carries each doc's open-task texts", () => {
    // One receiver-constrained subquery does double duty: the where-collect
    // filters to docs that HAVE an open task, and ^open lifts those tasks' text
    // into the parent select — no repeated subquery, no post-filter.
    const res = hits(
      'from docs where nodes collect { ^open: value where kind == "md:task" && !attrs.checked } select p: $path, open',
    );
    expect(res.hits.map((h) => h.p).sort()).toEqual(WITH_OPEN_TASK);
    // the January lab note's three open items, captured verbatim
    const jan = res.hits.find((h) => h.p === "lab/2026-01-notes.md")!;
    expect((jan.open as string[]).sort()).toEqual([
      "Plot mass gain against heating time",
      "Repeat the series with copper",
      "Tabulate the metal sulphides by colour",
    ]);
  });

  it("the salt discriminator holds through lifts: any-task lifts salt, open-task excludes it", () => {
    // salt is the ONLY substance with task nodes, and they are all checked.
    const anyTask = hits(
      'from docs where type == "substance" && nodes collect { ^t: value where kind == "md:task" } select p: $path, t',
    );
    expect(anyTask.hits.map((h) => h.p)).toEqual(["substances/salt.md"]);
    expect((anyTask.hits[0]!.t as string[]).sort()).toEqual([
      "Buy more salt of tartar",
      "Replace the leaching filter papers",
    ]);

    // Narrowing the lift's own predicate to OPEN tasks empties salt's set, so
    // the where-collect no longer matches and salt drops out entirely.
    const openTask = paths(
      'from docs where type == "substance" && nodes collect { ^t: value where kind == "md:task" && !attrs.checked }',
    );
    expect(openTask).toEqual([]);
  });

  it("composes a lift with a document-level predicate (processes with open work)", () => {
    const res = paths(
      'from docs where type == "process" && nodes collect { ^todo: value where kind == "md:task" && !attrs.checked }',
    );
    expect(res.sort()).toEqual([
      "processes/calcination.md",
      "processes/coagulation.md",
      "processes/dissolution.md",
      "processes/magnum-opus.md",
    ]);
  });

  it("an unreferenced lift still filters; a renamed reference still resolves", () => {
    // Not selecting the binding → the collect is a pure non-empty filter.
    const filtered = paths(
      'from docs where $path.startsWith("lab/") && nodes collect { ^open: value where kind == "md:task" && !attrs.checked } select $path',
    );
    expect(filtered.sort()).toEqual(["lab/2026-01-notes.md", "lab/2026-02-notes.md"]);
    // Referencing it under a different column name still yields the array.
    const named = hits(
      'from docs where $path == "lab/2026-02-notes.md" && nodes collect { ^open: value where kind == "md:task" && !attrs.checked } select todos: open',
    );
    expect((named.hits[0]!.todos as string[]).sort()).toEqual([
      "Assay cycle 1 and cycle 4 crops for iron",
      "Write the plateau result up for the coagulation note",
    ]);
  });
});

// The join-equivalent surface: a nested query over an EXPLICIT root relation
// (repo.docs / repo.nodes) correlated to a parent binding via the one-scope
// `^name` reference. These express dependent/semi/anti joins and 1:1 lookups
// without a JOIN keyword. Substances and processes carry a `slug`; a wikilink's
// value IS a slug, so links resolve to real documents.
describe("alchemy corpus — correlation & joins (^ outer references)", () => {
  const WITH_WIKILINK = [
    "index.md",
    "lab/2026-01-notes.md",
    "practitioners/jabir-ibn-hayyan.md",
    "practitioners/newton.md",
    "practitioners/paracelsus.md",
    "processes/calcination.md",
    "substances/mercury.md",
    "substances/philosophers-stone.md",
    "substances/prima-materia.md",
    "substances/salt.md",
    "substances/sulphur.md",
  ];

  it("resolves each document's outgoing wikilinks to the documents they name (dependent join)", () => {
    // Lift every wikilink target into `refs`, then join the whole repository:
    // the documents whose slug is one of this row's link targets. One expression
    // does link-extraction AND resolution — a citation/reference graph.
    const res = hits(
      "from docs where nodes collect { ^refs: value where kind == \"md:wikilink\" } " +
        "select p: $path, cites: repo.docs collect { where slug in ^refs select target: $path }",
    );
    expect(res.hits.map((h) => h.p)).toEqual(WITH_WIKILINK); // only docs that link out
    const cites = new Map(
      res.hits.map((h) => [h.p, (h.cites as { target: string }[]).map((c) => c.target).sort()]),
    );
    // index links [[mercury]] [[salt]] [[sulphur]] — all three resolve.
    expect(cites.get("index.md")).toEqual([
      "substances/mercury.md",
      "substances/salt.md",
      "substances/sulphur.md",
    ]);
    // philosophers-stone links [[magnum-opus]] (a process) and [[mercury]] — the
    // join spans document types, correlating only on slug.
    expect(cites.get("substances/philosophers-stone.md")).toEqual([
      "processes/magnum-opus.md",
      "substances/mercury.md",
    ]);
    // prima-materia's only wikilink is [[nigredo]] — a stage with no document, so
    // the correlated set is empty (a dangling reference, surfaced honestly).
    expect(cites.get("substances/prima-materia.md")).toEqual([]);
  });

  it("finds substances actually cited by a wikilink anywhere (correlated semi-join over a global node scan)", () => {
    // For each substance, does ANY wikilink node in the whole repository name its
    // slug? repo.nodes is the explicit global scan; ^slug ties it to this row.
    const cited = paths(
      'from docs where type == "substance" && repo.nodes exists { where kind == "md:wikilink" && value == ^slug } select slug',
    );
    expect(cited).toEqual([
      "substances/mercury.md",
      "substances/salt.md",
      "substances/sulphur.md",
    ]);
  });

  it("finds substances no wikilink points to (correlated anti-join)", () => {
    const uncited = paths(
      'from docs where type == "substance" && !repo.nodes exists { where kind == "md:wikilink" && value == ^slug } select slug',
    );
    // the tria prima are all cited; the two abstractions are named by prose, not links.
    expect(uncited).toEqual([
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
    ]);
  });

  it("pairs each practitioner with their tradition-mates, excluding themselves (self-join)", () => {
    // Two correlations at once: ^tradition matches the tradition, ^me excludes
    // the row itself. A self-join over repo.docs.
    const res = hits(
      "from docs where type == \"practitioner\" " +
        "select me: $path, tradition, peers: repo.docs collect { where type == \"practitioner\" && tradition == ^tradition && $path != ^$path select p: $path }",
    );
    const peers = new Map(
      res.hits.map((h) => [h.me, (h.peers as { p: string }[]).map((p) => p.p).sort()]),
    );
    // western has two practitioners — Newton and Paracelsus — so they pair up.
    expect(peers.get("practitioners/newton.md")).toEqual(["practitioners/paracelsus.md"]);
    expect(peers.get("practitioners/paracelsus.md")).toEqual(["practitioners/newton.md"]);
    // Jabir (islamic) and Maria (alexandrian) are the sole holders of their tradition.
    expect(peers.get("practitioners/jabir-ibn-hayyan.md")).toEqual([]);
    expect(peers.get("practitioners/maria-prophetissa.md")).toEqual([]);
  });

  it("looks up each lab note's subject process as a single correlated record (single)", () => {
    // `subject` names a process slug; slug is unique, so single(...) is a
    // cardinality-checked 1:1 lookup returning one record (not an array).
    const res = hits(
      "from docs where type == \"lab-note\" " +
        "select subject, process: repo.docs single { where slug == ^subject select p: $path, layer }",
    );
    const by = new Map(res.hits.map((h) => [h.path, h.process as { p: string; layer: string }]));
    expect(by.get("lab/2026-01-notes.md")).toEqual({ p: "processes/calcination.md", layer: "canon" });
    expect(by.get("lab/2026-02-notes.md")).toEqual({ p: "processes/coagulation.md", layer: "working" });
  });

  it("first { … } returns a zero-or-one tradition-mate (null when there is none)", () => {
    const res = hits(
      "from docs where type == \"practitioner\" " +
        "select me: $path, tradition, mate: repo.docs first { where type == \"practitioner\" && tradition == ^tradition && $path != ^$path select p: $path }",
    );
    const by = new Map(res.hits.map((h) => [h.me, h.mate as { p: string } | null]));
    expect(by.get("practitioners/newton.md")).toEqual({ p: "practitioners/paracelsus.md" });
    expect(by.get("practitioners/jabir-ibn-hayyan.md")).toBeNull(); // no tradition-mate
  });

  it("same-document correlation needs no root relation (^ against the owning row)", () => {
    // A lab note's subject is calcination; correlate its OWN task nodes against a
    // parent binding — no repo.* scan, just the structural doc.nodes relation.
    const res = hits(
      "from docs where $path == \"lab/2026-01-notes.md\" " +
        "select subject, mentions: nodes collect { where kind == \"md:wikilink\" select tgt: value }",
    );
    // (structural nested collect already covered elsewhere; here it coexists with
    // the correlated `subject` binding in the same select without interference)
    expect(res.hits[0]!.subject).toBe("calcination");
    expect((res.hits[0]!.mentions as { tgt: string }[]).map((m) => m.tgt).sort()).toEqual(["mercury", "salt"]);
  });
});

describe("alchemy corpus — blocks and nodes targets", () => {
  it("selects task blocks constrained by their document's frontmatter", () => {
    const res = hits('from blocks where type == "task" && doc.type == "lab-note"');
    expect(res.hits.length).toBe(11); // 7 in January + 4 in February
    expect(new Set(res.hits.map((h) => h.path))).toEqual(
      new Set(["lab/2026-01-notes.md", "lab/2026-02-notes.md"]),
    );
  });

  it("selects code fences under a path prefix", () => {
    const res = hits('from blocks where type == "code_fence" && $path.startsWith("processes/")');
    expect(res.hits.map((h) => h.path)).toEqual([
      "processes/calcination.md",
      "processes/coagulation.md",
      "processes/dissolution.md",
    ]);
  });

  it("selects nodes with document reach-through", () => {
    const res = hits('from nodes where kind == "md:task" && !attrs.checked && doc.type == "practitioner"');
    // jabir 1, newton 2, paracelsus 1
    expect(res.hits.length).toBe(4);
    expect(new Set(res.hits.map((h) => h.path))).toEqual(
      new Set([
        "practitioners/jabir-ibn-hayyan.md",
        "practitioners/newton.md",
        "practitioners/paracelsus.md",
      ]),
    );
  });

  it("projects node columns", () => {
    const res = hits('from nodes where kind == "md:inline_field" && name == "known_for" select field: name, val: value');
    expect(res.hits.length).toBe(4);
    expect(res.hits.every((h) => h.field === "known_for")).toBe(true);
    // Paracelsus' `known_for:: tria prima`. Asserted by prefix so this holds both
    // under today's single-token value capture ("tria") and after the
    // inline-property rework widens it to the rest of the line ("tria prima").
    expect(res.hits.map((h) => String(h.val)).some((v) => v.startsWith("tria"))).toBe(true);
  });
});

describe("alchemy corpus — text() full-text", () => {
  // Oracle: the raw FTS5 index (a doc matches when any of its blocks does) —
  // OQX's text() on docs must agree with a direct blocks_fts join.
  function ftsDocs(term: string): string[] {
    return (store.db.prepare(
      "SELECT DISTINCT d.path AS path FROM blocks_fts JOIN blocks b ON b.rowid = blocks_fts.rowid " +
        "JOIN docs d ON d.doc_id = b.doc_id WHERE blocks_fts MATCH ? AND b.repo_id = ? AND b.deleted_commit IS NULL",
    ).all(term, repoId) as { path: string }[]).map((r) => r.path).sort();
  }
  for (const term of ["mercury", "calcination", "sulphur"]) {
    it(`docs matching text("${term}") equal the raw FTS index for the term`, () => {
      const oqx = paths(`from docs where text("${term}")`);
      expect(oqx.slice().sort()).toEqual(ftsDocs(term));
      expect(oqx.length).toBeGreaterThan(0);
    });
  }

  it("composes with a scalar predicate (text prunes, then the scalar narrows)", () => {
    const canon = paths('from docs where text("mercury") && layer == "canon"');
    const all = paths('from docs where text("mercury")');
    expect(canon.length).toBeGreaterThan(0);
    expect(canon.every((p) => all.includes(p))).toBe(true);
  });

  it("composes INSIDE a correlated subquery — a per-row full-text task predicate", () => {
    // docs with a TASK node whose text matches (porter stem: "recrystallization"
    // ~ coagulation's "Recrystallize alum" task, and the Feb lab note's
    // "recrystallization cycles" task). The flat query tool has no way to express
    // "a task node matching this text".
    expect(paths('from docs where nodes exists { where kind == "md:task" && text("recrystallization") }'))
      .toEqual(["lab/2026-02-notes.md", "processes/coagulation.md"]);
  });
});

describe("alchemy corpus — order by", () => {
  const P = "practitioners/";
  it("orders the practitioners by era ascending (numeric, not lexical)", () => {
    // eras 250 < 800 < 1530 < 1680 — a lexical sort would misplace 1530/1680.
    expect(paths('from docs where type == "practitioner" order by era asc')).toEqual([
      `${P}maria-prophetissa.md`, `${P}jabir-ibn-hayyan.md`, `${P}paracelsus.md`, `${P}newton.md`,
    ]);
  });

  it("orders descending", () => {
    expect(paths('from docs where type == "practitioner" order by era desc')).toEqual([
      `${P}newton.md`, `${P}paracelsus.md`, `${P}jabir-ibn-hayyan.md`, `${P}maria-prophetissa.md`,
    ]);
  });

  it("repo.first + order by era desc is the latest practitioner (Newton)", () => {
    const r = hits('repo.docs first { where type == "practitioner" order by era desc }');
    expect(r.hits.map((h) => h.path)).toEqual([`${P}newton.md`]);
  });
});

describe("alchemy corpus — top-level consumers (repo.<target> <op>)", () => {
  it("repo.count folds the whole matching set to a number", () => {
    // 18 documents total; 5 are substances.
    expect(hits("repo.docs count { }").count).toBe(18);
    expect(hits('repo.docs count { where type == "substance" }').count).toBe(5);
  });

  it("repo.count of a correlated query counts DOCS, not their matched nodes", () => {
    // docs that contain at least one task node (the lab notes) — a handful of
    // docs, though they hold many tasks between them.
    const docsWithTasks = paths('from docs where nodes exists { where kind == "md:task" }');
    expect(hits('repo.docs count { where nodes exists { where kind == "md:task" } }').count).toBe(docsWithTasks.length);
  });

  it("repo.exists answers presence with a boolean", () => {
    expect(hits('repo.docs exists { where layer == "draft" }').exists).toBe(true);
    expect(hits('repo.docs exists { where layer == "nonexistent" }').exists).toBe(false);
  });

  it("repo.first returns the first document in path order, with projections", () => {
    const r = hits('repo.docs first { select t: type }');
    expect(r.hits.length).toBe(1);
    expect(r.hits[0]!.path).toBe("index.md"); // sorts before every subdirectory
  });

  it("repo.single fetches the sole draft document (mutus-liber)", () => {
    const r = hits('repo.docs single { where layer == "draft" }');
    expect(r.hits.map((h) => h.path)).toEqual(["texts/mutus-liber.md"]);
  });

  it("repo.single fails loudly when the query matches more than one document", () => {
    // 13 documents are canon — single must refuse to pick one.
    expect(() => hits('repo.docs single { where layer == "canon" }')).toThrow(/matched \d+ rows/);
  });
});

describe("alchemy corpus — pagination", () => {
  it("walks the corpus in path order with a keyset cursor", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = oqxRun(store, repoId, "from docs", { limit: 5, ...(cursor ? { cursor } : {}) });
      seen.push(...page.hits.map((h) => h.path));
      cursor = page.cursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against a non-advancing cursor
    } while (cursor);

    expect(pages).toBe(4); // 5 + 5 + 5 + 3
    expect(seen.length).toBe(18);
    expect(new Set(seen).size).toBe(18); // no duplicates across pages
    expect(seen).toEqual([...seen].sort()); // path order preserved
  });

  it("reports truncation honestly", () => {
    const page = hits("from docs", 5);
    expect(page.truncated).toBe(true);
    expect(page.cursor).toBeTruthy();
    const all = hits("from docs", 100);
    expect(all.truncated).toBe(false);
    expect(all.cursor).toBeNull();
  });
});

// Recursive `follow`: a query closed over its row type walks a type-preserving
// relation, decorating each reached occurrence with $depth/$stop/$ordinal. The
// corpus's wikilink + markdown-link graph — extracted to doc→doc `references`
// edges by the processCheckpoint ingest above — is the CITATION GRAPH the
// out/in demos walk; the heading outline and block tree exercise the
// structural relations.
describe("alchemy corpus — distinct (dedup by projection)", () => {
  it("select distinct dedups top-level projections to the value set", () => {
    const all = hits('from docs select type').hits.map((h) => h.type);
    const uniq = hits('from docs select distinct type').hits.map((h) => h.type);
    expect(uniq.length).toBeLessThan(all.length); // duplicates collapsed
    expect(new Set(uniq).size).toBe(uniq.length); // no duplicate values remain
    expect(new Set(uniq)).toEqual(new Set(all)); // same set of values
  });

  it("collect distinct — a document's unique node kinds", () => {
    const h = hits('from docs where $path == "processes/magnum-opus.md" select kinds: nodes collect distinct { select kind }').hits[0]!;
    const kinds = (h.kinds as { kind: string }[]).map((k) => k.kind).sort();
    expect(kinds).toEqual(["md:link", "md:section", "md:task"]); // 16 nodes → 3 kinds
  });

  it("count distinct in where — documents whose nodes span exactly three kinds", () => {
    const three = paths('from docs where nodes count distinct { select kind } == 3');
    expect(three).toContain("processes/magnum-opus.md");
    // the raw (non-distinct) node count is far higher, so `== 3` only holds for distinct kinds
    expect(paths('from docs where nodes count { } == 3')).not.toContain("processes/magnum-opus.md");
  });
});

describe("alchemy corpus — follow: the citation graph (out / in)", () => {
  it("out (distinct) = a note's transitive citation closure", () => {
    // Everything philosophers-stone.md reaches by following references, deduped
    // to nodes. The dense magnum-opus ⇄ prima-materia cycles are walked safely.
    const closure = paths('from docs where $path == "substances/philosophers-stone.md" follow distinct doc.out').sort();
    expect(closure).toEqual([
      "lab/2026-02-notes.md",
      "practitioners/jabir-ibn-hayyan.md",
      "practitioners/newton.md",
      "processes/calcination.md",
      "processes/coagulation.md",
      "processes/dissolution.md",
      "processes/magnum-opus.md",
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
      "texts/emerald-tablet.md",
    ]);
    // it never cites the other tria prima, nor the index — so they are absent
    expect(closure).not.toContain("substances/mercury.md");
    expect(closure).not.toContain("index.md");
  });

  it("in + a post-walk $depth filter = the documents that directly cite a note", () => {
    // Backlinks one hop out: who references magnum-opus? (seed@1, citers@2).
    const citers = paths('from docs where $path == "processes/magnum-opus.md" && $depth == 2 follow doc.in { depth 2 }').sort();
    expect(citers).toEqual([
      "index.md",
      "practitioners/maria-prophetissa.md",
      "practitioners/newton.md",
      "substances/philosophers-stone.md",
      "substances/prima-materia.md",
    ]);
  });

  it("cyclic citations are safe — a revisit is admitted once as $stop == 'cycle'", () => {
    // paracelsus references index, which references paracelsus back. The return
    // to paracelsus is admitted as a single cycle occurrence, not an infinite loop.
    const cyc = paths('from docs where $path == "practitioners/paracelsus.md" && $stop == "cycle" follow doc.out { depth 3 }');
    expect(cyc).toContain("practitioners/paracelsus.md");
    // the whole walk terminates: a bounded number of rows, no runaway.
    const all = hits('from docs where $path == "practitioners/paracelsus.md" follow doc.out { depth 3 }');
    expect(all.hits.length).toBeGreaterThan(0);
    expect(all.hits.length).toBeLessThan(200);
  });

  it("default keeps per-path occurrences; `distinct` collapses to reached nodes", () => {
    const occ = hits('repo.docs count { where $path == "substances/philosophers-stone.md" follow doc.out }').count!;
    const dist = hits('repo.docs count { where $path == "substances/philosophers-stone.md" follow distinct doc.out }').count!;
    expect(dist).toBe(10);
    expect(occ).toBeGreaterThan(dist); // the dense graph reaches nodes by many distinct paths
  });

  it("`frontier` cuts the walk at a class of documents", () => {
    // Explore citations, but treat practitioner biographies as the edge of the
    // walk: they are reported but never expanded through.
    const res = hits('from docs where $path == "index.md" select p: $path, ty: type, s: $stop follow doc.out { frontier type == "practitioner" }');
    const practitioners = res.hits.filter((h) => h.ty === "practitioner");
    expect(practitioners.length).toBeGreaterThan(0);
    expect(practitioners.every((h) => h.s === "frontier")).toBe(true);
  });

  it("`by <expr>` re-keys node identity — walk until a document TYPE repeats", () => {
    // Identity = type, so revisiting any type is a cycle. From a substance the
    // walk reaches a process, then stops the moment a type would repeat.
    const res = hits('from docs where $path == "substances/philosophers-stone.md" select p: $path, s: $stop follow doc.out { by type }');
    const stopByPath = new Map(res.hits.map((h) => [h.p as string, h.s]));
    // prima-materia is a substance — the seed's type — so it is an immediate cycle
    expect(stopByPath.get("substances/prima-materia.md")).toBe("cycle");
    // far smaller than the id-identity closure (10): types repeat almost at once
    expect(res.hits.length).toBeLessThan(10);
  });
});

describe("alchemy corpus — follow: the heading outline & block tree", () => {
  const OPUS_SUBS = ["Open questions", "Operations", "The four stages", "Why colour"];

  it("section.children walks the heading outline one level per hop", () => {
    const res = hits(
      'from nodes where kind == "md:section" && name == "The magnum opus" ' +
        "select n: name, d: $depth, s: $stop follow section.children",
    );
    const root = res.hits.find((h) => h.d === 1)!;
    expect(root.n).toBe("The magnum opus");
    expect(root.s).toBe("interior");
    const subs = res.hits.filter((h) => h.d === 2);
    expect(subs.map((h) => h.n as string).sort()).toEqual(OPUS_SUBS);
    expect(subs.every((h) => h.s === "leaf")).toBe(true); // 2-level outline
  });

  it("a post-walk $leaf filter keeps just the terminal sections", () => {
    const leaves = hits(
      'from nodes where kind == "md:section" && name == "The magnum opus" && $leaf select n: name follow section.children',
    );
    expect(leaves.hits.map((h) => h.n as string).sort()).toEqual(OPUS_SUBS);
  });

  it("$ordinal is a deterministic 1..N rank over the walk (seed first)", () => {
    const res = hits(
      'from nodes where kind == "md:section" && name == "The magnum opus" ' +
        "select n: name, o: $ordinal order by $ordinal follow section.children",
    );
    expect(res.hits.map((h) => h.o)).toEqual([1, 2, 3, 4, 5]);
    expect(res.hits[0]!.n).toBe("The magnum opus");
  });

  it("block.children walks a bullet list down to its items", () => {
    // The "Open questions" sections hold bullet lists; from each list block the
    // walk reaches its list_items / tasks (depth 2).
    const res = hits('from blocks where type == "list" && under_heading("Open questions") select t: type, d: $depth follow block.children');
    expect(res.hits.some((h) => h.t === "list" && h.d === 1)).toBe(true); // the seed lists
    const items = res.hits.filter((h) => h.d === 2);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((h) => h.t === "list_item" || h.t === "task")).toBe(true);
  });

  it("a nested follow-collect projects each document's outline as a subtree", () => {
    const res = hits(
      'from docs where type == "process" ' +
        'select p: $path, outline: nodes collect { where kind == "md:section" && attrs.level == 1 select n: name, d: $depth follow section.children }',
    );
    const mo = res.hits.find((h) => (h.p as string).includes("magnum-opus"))!;
    const outline = mo.outline as { n: string; d: number }[];
    expect(outline.find((o) => o.d === 1)!.n).toBe("The magnum opus");
    expect(outline.filter((o) => o.d === 2).map((o) => o.n).sort()).toEqual(OPUS_SUBS);
  });
});

describe("alchemy corpus — failure modes are loud", () => {
  it("resolves block.nodes end-to-end (nodes.block_id populated by ingest)", () => {
    // block.nodes was formerly marked unavailable; ingest now anchors projected
    // nodes to their block, so a block-grain node query returns real blocks.
    const blocks = paths('from blocks where nodes exists { where kind == "md:wikilink" }');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("rejects collect { … } used as a predicate", () => {
    expect(() => paths('from docs where nodes collect { where kind == "md:task" }')).toThrow(/project/);
  });

  // ADR-013: under the @omgbase/oqx semantics, an unknown navigation resolves to
  // no rows rather than a loud error, and arithmetic is a supported operator
  // (string `+` concatenates) — so these no longer throw. (Both were CEL-era
  // loudness the new engine trades for uniform navigation/arithmetic semantics.)
  it("an unknown navigation from a target yields no rows (no longer a loud error)", () => {
    expect(() => paths('from nodes where section.subsections exists { where kind == "md:section" }')).not.toThrow();
  });

  it("arithmetic in a nested query is evaluated, not rejected", () => {
    expect(() => paths("from docs where nodes exists { where kind + 1 }")).not.toThrow();
  });

  it("rejects a bare identifier that shadows an intrinsic", () => {
    expect(() => paths('from docs where path.startsWith("lab/")')).toThrow(/did you mean the intrinsic/);
  });
});
