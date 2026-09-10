import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { ingestFile } from "../../src/core/ingest.js";
import { parseTree, assertFullCoverage } from "../../src/core/parse/tree.js";
import { render } from "../../src/core/parse/render.js";
import { oqxRun } from "../../src/oqx/run.js";
import { query } from "../../src/search/query.js";
import { FilterInvalid } from "../../src/search/cel/parser.js";
import "../../src/format/index.js"; // registers format adapters (node projection)

// High-level OQX behaviour over a realistic interlinked corpus: an alchemy
// repository of 18 markdown documents under fixtures/alchemy — substances,
// processes, practitioners, texts, and lab notes, with frontmatter, inline
// fields (`key:: value`), wikilinks, markdown links, tasks, tables, code fences,
// and blockquotes.
//
// These are capability demonstrations, not unit tests: each case is a query a
// user would plausibly write, asserted against the exact documents it must
// return. Unit-level coverage lives in src/oqx/*.test.ts.

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
  for (const file of walk(DIR)) {
    ingestFile(store, repoId, relative(DIR, file), readFileSync(file, "utf8"));
  }
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
      "md:inline_field", "md:link", "md:task", "md:wikilink",
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
    expect(paths('from docs where nodes.exists(where kind == "md:task")')).toEqual(WITH_ANY_TASK);
  });

  it("narrows to documents with an OPEN task — salt.md drops out", () => {
    // salt.md carries only a checked supply list. It is the discriminator
    // proving the nested predicate is evaluated per document, not corpus-wide.
    const open = paths('from docs where nodes.exists(where kind == "md:task" && !attrs.checked)');
    expect(open).toEqual(WITH_ANY_TASK.filter((p) => p !== "substances/salt.md"));
    expect(open).not.toContain("substances/salt.md");
  });

  it("is correlated, not a global scan — task-free documents never match", () => {
    const any = paths('from docs where nodes.exists(where kind == "md:task")');
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
    expect(paths('from docs where type == "lab-note" && nodes.exists(where kind == "md:task" && !attrs.checked)')).toEqual([
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
    ]);
  });

  it("enforces the corpus convention: no open bench work on substance pages", () => {
    // Actionable work lives in the lab notebooks; substance pages state open
    // questions as prose. salt.md is the one exception and its list is a
    // fully-checked supply order, not outstanding work.
    expect(paths('from docs where type == "substance" && nodes.exists(where kind == "md:task" && !attrs.checked)')).toEqual([]);
    expect(paths('from docs where type == "substance" && nodes.exists(where kind == "md:task")')).toEqual([
      "substances/salt.md",
    ]);
  });

  it("reaches back to the owning document from INSIDE the nested query", () => {
    // Regression guard: an inner `JOIN docs d` here would shadow the outer `d`
    // and make the correlation a tautology, silently matching every document.
    const workingOpen = paths(
      'from docs where nodes.exists(where kind == "md:task" && !attrs.checked && doc.layer == "working")',
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
    const linked = paths('from docs where nodes.exists(where kind == "md:wikilink")');
    expect(linked).toContain("index.md");
    expect(linked).toContain("substances/sulphur.md");
    expect(linked).not.toContain("texts/emerald-tablet.md"); // markdown links only
  });

  it("finds documents carrying a named inline field node", () => {
    expect(paths('from docs where nodes.exists(where kind == "md:inline_field" && name == "operator")')).toEqual([
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
    ]);
  });

  it("count() in where position means non-empty", () => {
    expect(paths('from docs where nodes.count(where kind == "md:task" && !attrs.checked)'))
      .toEqual(paths('from docs where nodes.exists(where kind == "md:task" && !attrs.checked)'));
  });
});

describe("alchemy corpus — correlated block queries", () => {
  it("finds documents containing a code fence", () => {
    expect(paths('from docs where blocks.exists(where type == "code_fence")')).toEqual([
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
      "processes/calcination.md",
      "processes/coagulation.md",
      "processes/dissolution.md",
    ]);
  });

  it("finds documents containing a table", () => {
    expect(paths('from docs where blocks.exists(where type == "table")')).toEqual([
      "index.md",
      "lab/2026-01-notes.md",
      "lab/2026-02-notes.md",
      "processes/magnum-opus.md",
      "substances/mercury.md",
    ]);
  });

  it("finds documents quoting a source (blockquote)", () => {
    expect(paths('from docs where blocks.exists(where type == "blockquote")')).toEqual([
      "practitioners/maria-prophetissa.md",
      "practitioners/paracelsus.md",
      "substances/prima-materia.md",
      "texts/emerald-tablet.md",
    ]);
  });

  it("combines a block predicate with a document predicate", () => {
    expect(paths('from docs where type == "process" && blocks.exists(where type == "table")')).toEqual([
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
    const anyBlock = paths('from docs where blocks.exists(where under_heading("Open questions"))');
    expect(anyBlock).toContain("processes/magnum-opus.md"); // it HAS such a section

    const listItems = paths('from docs where blocks.exists(where type == "list_item" && under_heading("Open questions"))');
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

describe("alchemy corpus — collect() projection", () => {
  it("shapes each lab note's open tasks into a nested list", () => {
    const res = hits(
      'from docs where type == "lab-note" select open: nodes.collect(where kind == "md:task" && !attrs.checked select text: value)',
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
    const res = hits('from docs where type == "substance" select tasks: nodes.collect(where kind == "md:task")');
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
      'from docs where type == "process" && nodes.exists(where kind == "md:task" && !attrs.checked) select open: nodes.collect(where kind == "md:task" && !attrs.checked select text: value)',
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
    const res = hits('from docs where type == "lab-note" select era: month, tasks: nodes.collect(where kind == "md:task")');
    expect(res.hits.map((h) => h.era)).toEqual([1, 2]);
    expect((res.hits[0]!.tasks as unknown[]).length).toBe(7); // January
    expect((res.hits[1]!.tasks as unknown[]).length).toBe(4); // February
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

describe("alchemy corpus — parity with the CEL query engine", () => {
  // A pure-scalar OQX query must select exactly what query() selects: OQX hands
  // scalar predicates to the same compiler.
  const cases = [
    ['type == "substance"', 'from docs where type == "substance"'],
    ['"substance" in list(tags)', 'from docs where "substance" in list(tags)'],
    ["era < 1000", "from docs where era < 1000"],
    ["!verified", "from docs where !verified"],
    ['$path.startsWith("lab/")', 'from docs where $path.startsWith("lab/")'],
  ] as const;

  for (const [filter, oqx] of cases) {
    it(`matches query() for: ${filter}`, () => {
      const cel = query(store, repoId, { from: "docs", filter, limit: 100 });
      expect(paths(oqx)).toEqual(cel.hits.map((h) => h.path));
    });
  }
});

describe("alchemy corpus — failure modes are loud", () => {
  it("rejects an unavailable relation instead of returning nothing", () => {
    expect(() => paths('from blocks where nodes.exists(where kind == "md:link")')).toThrow(/unavailable/);
  });

  it("rejects collect() used as a predicate", () => {
    expect(() => paths('from docs where nodes.collect(where kind == "md:task")')).toThrow(/projection/);
  });

  it("rejects a relation that does not exist from the target", () => {
    expect(() => paths('from nodes where blocks.exists(where type == "task")')).toThrow(FilterInvalid);
  });

  it("surfaces CEL errors from inside a nested query", () => {
    expect(() => paths("from docs where nodes.exists(where kind + 1)")).toThrow(/arithmetic/);
  });

  it("rejects a bare identifier that shadows an intrinsic", () => {
    expect(() => paths('from docs where path.startsWith("lab/")')).toThrow(/did you mean the intrinsic/);
  });
});
