// Differential conformance (ADR-013) over a MUTATING corpus: a document whose
// `type` property changes across revisions — through both commit paths (the
// observed/checkpoint ingest and the api/docs_update write) — must answer a
// pushed `type ==` conjunct identically whether the planner runs it in SQL or
// the engine runs it in memory, and must never match a superseded value via a
// stale property row. Also pins `startsWith && ==` conjunct splits, where the
// `$path` intrinsic and the `type` property are pushed together.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { processCheckpoint } from "../../src/sync/checkpoint.js";
import { docsUpdate } from "../../src/mutate/plan-update.js";
import { oqxRun } from "../../src/oqx/run.js";
import "../../src/format/index.js";

let dir: string, store: Store, repoId: string;
const PROJECT = "/terms/types/project.md";
const IDEA = "/terms/types/idea.md";

function save(path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}
function paths(q: string, plan?: boolean): string[] {
  const r = oqxRun(store, repoId, q, { limit: 100, ...(plan === false ? { plan: false } : {}) }) as { hits: { path: string }[] };
  return r.hits.map((h) => h.path).sort();
}
function both(q: string): { planned: string[]; memory: string[] } {
  return { planned: paths(q), memory: paths(q, false) };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oqx-rev-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
  // creative/: one project, one idea, one that FLIPS project→idea via the
  // observed path, one that flips via the api path, one list-valued, one with
  // an inline `type::` colliding with frontmatter; plus a doc outside creative/.
  save("creative/proj.md", `---\ntype: ${PROJECT}\n---\n\n# Proj\n\nBody.\n`);
  save("creative/idea.md", `---\ntype: ${IDEA}\n---\n\n# Idea\n\nBody.\n`);
  save("creative/flip-observed.md", `---\ntype: ${PROJECT}\ntitle: Flip O\n---\n\n# Flip O\n\nBody.\n`);
  save("creative/flip-observed.md", `---\ntype: ${IDEA}\ntitle: Flip O\n---\n\n# Flip O\n\nBody.\n`);
  save("creative/flip-api.md", `---\ntype: ${PROJECT}\ntitle: Flip A\n---\n\n# Flip A\n\nBody.\n`);
  const r = docsUpdate(store, { repoId, rootPath: dir, actor: "agent:test" }, "creative/flip-api.md", `---\ntype: ${IDEA}\ntitle: Flip A\n---\n\n# Flip A\n\nBody.\n`);
  if (!r.result?.committed) throw new Error("api flip did not commit");
  save("creative/list.md", `---\ntype:\n  - ${PROJECT}\n  - ${IDEA}\n---\n\n# List\n\nBody.\n`);
  save("creative/list-to-scalar.md", `---\ntype:\n  - ${IDEA}\n  - ${PROJECT}\n---\n\n# LTS\n\nBody.\n`);
  save("creative/list-to-scalar.md", `---\ntype: ${IDEA}\n---\n\n# LTS\n\nBody.\n`);
  save("creative/collide.md", `---\ntype: ${IDEA}\n---\n\n# Collide\n\ntype:: ${PROJECT}\n`);
  save("other/proj.md", `---\ntype: ${PROJECT}\n---\n\n# Other\n\nBody.\n`);
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const QUERIES = [
  `from docs where $path.startsWith("creative/") && type == "${PROJECT}"`,
  `from docs where $path.startsWith("creative/") && type == "${IDEA}"`,
  `from docs where type == "${PROJECT}" && $path.startsWith("creative/")`,
  `from docs where $path.startsWith("creative/") && type != "${PROJECT}"`,
  `from docs where $path == "creative/flip-observed.md" && type == "${PROJECT}"`,
  `from docs where $path == "creative/flip-api.md" && type == "${PROJECT}"`,
  `from docs where $path == "creative/flip-api.md" && type == "${IDEA}"`,
  `select $path, type from docs where $path.startsWith("creative/") && type == "${PROJECT}"`,
  `from docs where $path.startsWith("creative/") && "${PROJECT}" in list(type)`,
  `from docs where type == "${PROJECT}"`,
  `from docs where $path.startsWith("creative/") && frontmatter.type == "${PROJECT}"`,
];

describe("OQX conformance — type changed across revisions (planned == in-memory)", () => {
  for (const q of QUERIES) {
    it(q, () => {
      const planned = oqxRun(store, repoId, q, { limit: 100 });
      const memory = oqxRun(store, repoId, q, { limit: 100, plan: false });
      expect(planned).toEqual(memory);
    });
  }

  it("no stale property rows survive a re-ingest (either commit path)", () => {
    for (const p of ["creative/flip-observed.md", "creative/flip-api.md", "creative/list-to-scalar.md"]) {
      const rows = store.db.prepare("SELECT p.key, p.card, p.ord, p.val_text FROM properties p JOIN docs d ON d.doc_id = p.doc_id WHERE d.path = ? AND p.key = 'type' AND p.deleted_commit IS NULL").all(p) as { val_text: string; card: string }[];
      expect(rows.map((r) => r.val_text)).toEqual([IDEA]);
      expect(rows[0]!.card).toBe("scalar");
    }
  });

  it("a flipped doc matches only its CURRENT type, regardless of the surrounding predicate", () => {
    const wide = both(`from docs where $path.startsWith("creative/") && type == "${PROJECT}"`);
    expect(wide.planned).toEqual(["creative/proj.md"]);
    expect(wide.memory).toEqual(["creative/proj.md"]);
    for (const p of ["creative/flip-observed.md", "creative/flip-api.md", "creative/list-to-scalar.md"]) {
      expect(both(`from docs where $path == "${p}" && type == "${PROJECT}"`)).toEqual({ planned: [], memory: [] });
      expect(both(`from docs where $path == "${p}" && type == "${IDEA}"`)).toEqual({ planned: [p], memory: [p] });
    }
    // The wide and narrowed forms agree doc-by-doc.
    const all = paths('from docs where $path.startsWith("creative/")');
    for (const p of all) {
      const narrow = paths(`from docs where $path == "${p}" && type == "${PROJECT}"`);
      expect(wide.planned.includes(p)).toBe(narrow.length === 1);
    }
  });
});
