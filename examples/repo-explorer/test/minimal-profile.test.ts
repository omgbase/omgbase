// The claim the README makes — every feature works on `omg mcp --tools minimal`
// — as a test: run each feature's data path against a scripted server that
// lists exactly the ten minimal tools and refuses every other name, and assert
// the tools it was asked for.
import { describe, expect, it } from "vitest";
import { fetchSyntax, runConsole } from "../src/lib/console.ts";
import { fetchDocument, fetchDocumentAt } from "../src/lib/document.ts";
import { fetchChanges } from "../src/lib/feed.ts";
import { fetchDeleted, fetchRevisions } from "../src/lib/history.ts";
import { fetchLinks, resolveWikilink } from "../src/lib/links.ts";
import { MINIMAL_TOOLS } from "../src/lib/tools.ts";
import { fetchLevel } from "../src/lib/tree.ts";
import { executePlan, planEffects, setFrontmatterEffect } from "../src/lib/writes.ts";
import { ScriptedCaller, page } from "./scripted.ts";

function minimalServer(): ScriptedCaller {
  return new ScriptedCaller({
    docs_tree: () => ({ prefix: "/", depth: 1, total: { docs: 1, blocks: 2 }, entries: [{ id: "d_7", path: "/calc.md", kind: "doc", docs: 1, blocks: 2, updated_at: null }], truncated: false, cursor: null }),
    docs_read: (a) => (a.at ? { id: "d_7", path: "/calc.md", rev: a.at, raw: "# Old\n", renderedHashMatch: true } : { id: "d_7", path: "/calc.md", rev: "r_7", properties: { frontmatter: {}, inline: {}, computed: {} }, raw: "# New\n", ids: ["b_1"], hashes: {}, parents: { b_1: null } }),
    query: (a) => {
      const q = String(a.query);
      if (q.startsWith("select rev,")) return page([{ id: "r_7", path: "/calc.md", rev: "r_7", seq: 1, ts: "t", origin: "observed", actor: null, reason: null, hash: "h", is_current: true, doc_id: "d_7" }]);
      if (q.includes("from links")) return page([]);
      return page([{ id: "d_7", path: "/calc.md" }]);
    },
    query_syntax: () => ({ syntax: "# query" }),
    changes_since: () => ({ digests: [], cursor: 1, truncated: false, head: 1 }),
    plan: () => ({ plan_id: "p1", preview: { revisions: [{ id: "d_7", path: "/calc.md", hash: "h2" }], summary: ["set frontmatter.k = 1 in /calc.md"], diffs: {} } }),
    execute: () => ({ plan_id: "p1", commit: "c_1", revisions: [], new_ids: {}, committed: true, summary: [] }),
    version: () => ({ specs: { surface: "4.7" }, profile: "minimal" }),
  });
}

describe("every feature over exactly the minimal ten", () => {
  it("tree, document, links, console + syntax, history + time travel, deleted list, feed, writes", async () => {
    const s = minimalServer();
    await fetchLevel(s, "/", null);                                   // 1. the tree
    const doc = await fetchDocument(s, { path: "/calc.md" }, null);   // 2. the document (include_ids)
    await fetchLinks(s, doc.path, null);                              // 3. backlinks + outlinks
    await resolveWikilink(s, "salt", null);                           //    a [[wikilink]]
    await runConsole(s, "from docs", {});                             // 4. the console
    await fetchSyntax(s);                                             //    the syntax drawer
    const revs = await fetchRevisions(s, doc.id, null);               // 5. history
    await fetchDocumentAt(s, { id: doc.id }, revs[0]!.rev, null);     //    time travel
    await fetchDeleted(s, null);                                      //    deleted documents
    await fetchChanges(s, null, null, 1);                             // 6. the live feed
    const plan = await planEffects(s, [setFrontmatterEffect(doc.path, "k", 1)], null); // 7. writes
    await executePlan(s, plan, null);
    const used = new Set(s.names());
    for (const name of used) expect(MINIMAL_TOOLS).toContain(name);
    expect([...used].sort()).toEqual(["changes_since", "docs_read", "docs_tree", "execute", "plan", "query", "query_syntax"]);
    // `blocks_resolve`, `apply` and `version` are the three minimal tools the data paths do not need (version is the page's gate).
  });
  it("the scripted server refuses what the real minimal server refuses", async () => {
    const s = minimalServer();
    for (const name of ["repos", "docs_history", "docs_diff_unified", "docs_read_at", "docs_set_meta", "docs_list"]) {
      await expect(s.call(name, {})).rejects.toMatchObject({ code: "unknown_tool" });
    }
  });
});
