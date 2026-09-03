import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { planImport, importDocs, type MrplexDoc } from "./mrplex.js";

let store: Store;
let repoId: string;

const DOCS: MrplexDoc[] = [
  { path: "projects/omgbase.md", markdown: "---\ntype: /terms/types/project.md\nlayer: proposed\n---\n\n# omgbase\n\nProject hub linking [[architecture-direction]].\n" },
  { path: "concepts/identity.md", markdown: "# Identity\n\nStable block identity across edits.\n\nrelated:: [[omgbase]]\n" },
];

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "worknotes", "/tmp");
});
afterEach(() => store.close());

describe("mrplex importer (7.4)", () => {
  it("dry-run plan reports docs/bytes/paths without writing", () => {
    const plan = planImport(repoId, DOCS);
    expect(plan.docCount).toBe(2);
    expect(plan.totalBytes).toBeGreaterThan(0);
    expect(plan.paths).toEqual(["concepts/identity.md", "projects/omgbase.md"]);
    // nothing written
    expect((store.db.prepare("SELECT count(*) c FROM documents").get() as { c: number }).c).toBe(0);
  });

  it("imports docs as import-origin commits with minted ids + convergence", () => {
    const res = importDocs(store, repoId, DOCS);
    expect(res.allConverged).toBe(true);
    expect(res.imported).toHaveLength(2);

    const commits = store.db.prepare("SELECT DISTINCT origin FROM commits").all() as { origin: string }[];
    expect(commits.map((c) => c.origin)).toEqual(["import"]);

    // frontmatter is queryable + edges extracted (related:: [[omgbase]]).
    const edges = store.db.prepare("SELECT count(*) c FROM edges WHERE to_commit IS NULL").get() as { c: number };
    expect(edges.c).toBeGreaterThanOrEqual(1);
  });

  it("records NO retro-inferred block history — only the import commit (invariant #7)", () => {
    const res = importDocs(store, repoId, DOCS);
    const docId = res.imported[0]!.docId;
    // block_changes for this doc's blocks all point at exactly one commit.
    const commitsPerBlock = store.db.prepare(
      "SELECT block_id, count(DISTINCT commit_id) n FROM block_changes WHERE block_id IN (SELECT block_id FROM blocks WHERE doc_id=?) GROUP BY block_id",
    ).all(docId) as { block_id: string; n: number }[];
    expect(commitsPerBlock.every((r) => r.n === 1)).toBe(true);
    // and the only disposition kind at import is 'inserted' (no edited/moved lineage invented)
    const kinds = new Set((store.db.prepare("SELECT DISTINCT kind FROM dispositions").all() as { kind: string }[]).map((r) => r.kind));
    expect([...kinds]).toEqual(["inserted"]);
  });
});
