import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { planUpdate, applyOpset, docsUpdate } from "./plan-update.js";
import { renderOpsetPlan, serializeOpset, parseOpset } from "./opset.js";

let dir: string; let store: Store; let repoId: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omgbase-plan-")); store = new Store({ path: ":memory:" }); repoId = ensureRepo(store, "t", dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function seed(path: string, content: string): string {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path = ?").get(path) as { doc_id: string }).doc_id;
}
function ids(docId: string): Map<string, string> {
  const rows = store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = ? ORDER BY ordinal").all(docId) as { block_id: string; text: string }[];
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.text, r.block_id);
  return m;
}
function fileOf(path: string): string { return readFileSync(join(dir, path), "utf8"); }
function ctx() { return { repoId, rootPath: dir, actor: "agent:test" }; }

describe("planUpdate — whole-document reconciliation opset", () => {
  it("identical content plans nothing and converges", () => {
    const content = "# Title\n\nAlpha.\n\nBravo.\n";
    seed("a.md", content);
    const opset = planUpdate(store, repoId, dir, "a.md", content);
    expect(opset.converges).toBe(true);
    expect(opset.ops.length).toBe(0);
    expect(opset.summary.preserved).toBe(3);
  });

  it("edits one paragraph, preserving all block ids", () => {
    const alpha = "Alpha is a reasonably long paragraph about the first topic in this note.";
    const alphaEdited = "Alpha is a reasonably long paragraph about the first subject in this note.";
    const before = `# Title\n\n${alpha}\n\nBravo paragraph with its own distinct content here.\n`;
    const docId = seed("a.md", before);
    const idBefore = ids(docId);
    const { opset, result } = docsUpdate(store, ctx(), "a.md", `# Title\n\n${alphaEdited}\n\nBravo paragraph with its own distinct content here.\n`);
    expect(opset.converges).toBe(true);
    expect(result!.committed).toBe(true);
    expect(fileOf("a.md")).toBe(`# Title\n\n${alphaEdited}\n\nBravo paragraph with its own distinct content here.\n`);
    const idAfter = ids(docId);
    // Title + Bravo ids unchanged; the edited paragraph keeps its id too.
    expect(idAfter.get("Title")).toBe(idBefore.get("Title"));
    expect(idAfter.get("Bravo paragraph with its own distinct content here.")).toBe(idBefore.get("Bravo paragraph with its own distinct content here."));
    expect(idAfter.get(alphaEdited)).toBe(idBefore.get(alpha));
    expect(opset.summary.updated).toBe(1);
  });

  it("inserts a new paragraph in the middle", () => {
    const docId = seed("a.md", "# Title\n\nAlpha.\n\nBravo.\n");
    const before = ids(docId);
    const { opset } = docsUpdate(store, ctx(), "a.md", "# Title\n\nAlpha.\n\nMiddle new.\n\nBravo.\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# Title\n\nAlpha.\n\nMiddle new.\n\nBravo.\n");
    const after = ids(docId);
    expect(after.get("Alpha.")).toBe(before.get("Alpha."));
    expect(after.get("Bravo.")).toBe(before.get("Bravo."));
    expect(after.has("Middle new.")).toBe(true);
    expect(opset.summary.created).toBe(1);
  });

  it("removes a paragraph", () => {
    const docId = seed("a.md", "# Title\n\nAlpha.\n\nBravo.\n\nGamma.\n");
    const before = ids(docId);
    const { opset } = docsUpdate(store, ctx(), "a.md", "# Title\n\nAlpha.\n\nGamma.\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# Title\n\nAlpha.\n\nGamma.\n");
    const after = ids(docId);
    expect(after.get("Gamma.")).toBe(before.get("Gamma."));
    expect(opset.summary.removed).toBe(1);
  });

  it("reorders paragraphs, preserving ids (move re-tiles trivia)", () => {
    const docId = seed("a.md", "# Title\n\nAlpha.\n\nBravo.\n");
    const before = ids(docId);
    const { opset } = docsUpdate(store, ctx(), "a.md", "# Title\n\nBravo.\n\nAlpha.\n");
    console.log(renderOpsetPlan(opset));
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# Title\n\nBravo.\n\nAlpha.\n");
    const after = ids(docId);
    expect(after.get("Alpha.")).toBe(before.get("Alpha."));
    expect(after.get("Bravo.")).toBe(before.get("Bravo."));
    expect(opset.summary.moved).toBeGreaterThanOrEqual(1);
  });

  it("changes frontmatter", () => {
    const docId = seed("a.md", "---\ntitle: Old\n---\n\n# Title\n\nAlpha.\n");
    const before = ids(docId);
    const { opset } = docsUpdate(store, ctx(), "a.md", "---\ntitle: New\n---\n\n# Title\n\nAlpha.\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("---\ntitle: New\n---\n\n# Title\n\nAlpha.\n");
    // body ids preserved
    expect(ids(docId).get("Alpha.")).toBe(before.get("Alpha."));
    // property updated
    const t = store.db.prepare("SELECT val_text FROM properties WHERE doc_id = ? AND key = 'title'").get(docId) as { val_text: string } | undefined;
    expect(t?.val_text).toBe("New");
  });

  it("rejects a stale plan", () => {
    seed("a.md", "# Title\n\nAlpha.\n");
    const opset = planUpdate(store, repoId, dir, "a.md", "# Title\n\nAlpha edited.\n");
    // someone else changes the doc first
    docsUpdate(store, ctx(), "a.md", "# Title\n\nInterloper.\n");
    let code = "";
    try { applyOpset(store, { repoId, rootPath: dir, opset, origin: { actor: "t" } }); }
    catch (e) { code = (e as { code?: string }).code ?? ""; }
    expect(code).toBe("stale_plan");
  });

  it("dry_run returns the opset and commits nothing", () => {
    seed("a.md", "# Title\n\nAlpha long enough paragraph to reconcile cleanly here.\n");
    const before = fileOf("a.md");
    const { opset, result } = docsUpdate(store, ctx(), "a.md", "# Title\n\nAlpha long enough paragraph to reconcile cleanly now.\n", { dryRun: true });
    expect(result).toBeNull();
    expect(opset.converges).toBe(true);
    expect(opset.ops.length).toBeGreaterThan(0);
    expect(fileOf("a.md")).toBe(before); // unchanged
  });

  it("serializes and human-renders the opset", () => {
    seed("a.md", "# Heading one paragraph long enough for a stable match here.\n\nBody.\n");
    const opset = planUpdate(store, repoId, dir, "a.md", "# Heading one paragraph long enough for a stable match now.\n\nBody.\n");
    const round = parseOpset(serializeOpset(opset));
    expect(round.ops).toEqual(opset.ops);
    expect(round.precondition).toEqual(opset.precondition);
    const text = renderOpsetPlan(opset);
    expect(text).toMatch(/UPDATE|MOVE|INSERT|REMOVE/);
    expect(text).toMatch(/preserved:/);
  });

  it("edits a heading (high overlap), preserving its id and body", () => {
    const docId = seed("a.md", "# Weekly Engineering Sync Notes\n\nBody paragraph that stays put across the edit.\n");
    const before = ids(docId);
    const oldHeadingId = before.get("Weekly Engineering Sync Notes");
    const { opset } = docsUpdate(store, ctx(), "a.md", "# Weekly Engineering Sync Notes And Actions\n\nBody paragraph that stays put across the edit.\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# Weekly Engineering Sync Notes And Actions\n\nBody paragraph that stays put across the edit.\n");
    const after = ids(docId);
    expect(after.get("Weekly Engineering Sync Notes And Actions")).toBe(oldHeadingId); // heading id carried
    expect(after.get("Body paragraph that stays put across the edit.")).toBe(before.get("Body paragraph that stays put across the edit."));
  });

  it("updates a list as a unit (list id preserved), converging exactly", () => {
    const docId = seed("a.md", "# Title\n\n- one\n- two\n- three\n");
    const listBefore = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND type = 'list'").get(docId) as { block_id: string }).block_id;
    const { opset } = docsUpdate(store, ctx(), "a.md", "# Title\n\n- one\n- two changed\n- three\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# Title\n\n- one\n- two changed\n- three\n");
    const listAfter = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND type = 'list'").get(docId) as { block_id: string }).block_id;
    expect(listAfter).toBe(listBefore); // the list block keeps its id
  });

  function itemId(docId: string, text: string): string | undefined {
    const r = store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND type IN ('list_item','task') AND text = ?").get(docId, text) as { block_id: string } | undefined;
    return r?.block_id;
  }

  it("preserves sibling list-item ids when one item's text is edited", () => {
    const docId = seed("a.md", "# T\n\n- alpha item text here\n- bravo item text here\n- gamma item text here\n");
    const alphaId = itemId(docId, "alpha item text here");
    const gammaId = itemId(docId, "gamma item text here");
    const { opset } = docsUpdate(store, ctx(), "a.md", "# T\n\n- alpha item text here\n- bravo item text CHANGED\n- gamma item text here\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# T\n\n- alpha item text here\n- bravo item text CHANGED\n- gamma item text here\n");
    // untouched siblings keep their ids (nested identity preserved)
    expect(itemId(docId, "alpha item text here")).toBe(alphaId);
    expect(itemId(docId, "gamma item text here")).toBe(gammaId);
  });

  it("preserves ALL list-item ids across a pure reorder", () => {
    const docId = seed("a.md", "# T\n\n- alpha item text here\n- bravo item text here\n- gamma item text here\n");
    const a = itemId(docId, "alpha item text here");
    const b = itemId(docId, "bravo item text here");
    const g = itemId(docId, "gamma item text here");
    const { opset } = docsUpdate(store, ctx(), "a.md", "# T\n\n- gamma item text here\n- alpha item text here\n- bravo item text here\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# T\n\n- gamma item text here\n- alpha item text here\n- bravo item text here\n");
    // every item keeps its id despite the reorder
    expect(itemId(docId, "alpha item text here")).toBe(a);
    expect(itemId(docId, "bravo item text here")).toBe(b);
    expect(itemId(docId, "gamma item text here")).toBe(g);
  });

  it("preserves surviving item ids when an item is inserted and another removed", () => {
    const docId = seed("a.md", "# T\n\n- alpha item text here\n- bravo item text here\n- gamma item text here\n");
    const a = itemId(docId, "alpha item text here");
    const g = itemId(docId, "gamma item text here");
    const { opset } = docsUpdate(store, ctx(), "a.md", "# T\n\n- alpha item text here\n- delta brand new item here\n- gamma item text here\n");
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe("# T\n\n- alpha item text here\n- delta brand new item here\n- gamma item text here\n");
    expect(itemId(docId, "alpha item text here")).toBe(a);
    expect(itemId(docId, "gamma item text here")).toBe(g);
    expect(itemId(docId, "delta brand new item here")).toMatch(/^b_/); // new item minted
  });

  it("handles a combined edit + insert + remove + reorder in one update", () => {
    const p1 = "First substantial paragraph that will be edited in place here.";
    const p1b = "First substantial paragraph that will be edited in place now.";
    const p2 = "Second substantial paragraph that survives and later reorders.";
    const p3 = "Third substantial paragraph destined for removal in this pass.";
    const docId = seed("a.md", `# Title\n\n${p1}\n\n${p2}\n\n${p3}\n`);
    const before = ids(docId);
    // edit p1, remove p3, add a new para, and put p2 before p1
    const next = `# Title\n\n${p2}\n\n${p1b}\n\nBrand new fourth paragraph appended to the end here.\n`;
    const { opset } = docsUpdate(store, ctx(), "a.md", next);
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe(next);
    const after = ids(docId);
    expect(after.get(p2)).toBe(before.get(p2));
    expect(after.get(p1b)).toBe(before.get(p1));
    expect(after.has("Brand new fourth paragraph appended to the end here.")).toBe(true);
    expect(opset.summary.removed).toBe(1);
    expect(opset.summary.created).toBe(1);
  });

  it("is deterministic in op shape and dispositions", () => {
    seed("a.md", "# Title\n\nAlpha.\n\nBravo.\n");
    const a = planUpdate(store, repoId, dir, "a.md", "# Title\n\nAlpha edited.\n\nBravo.\n");
    const b = planUpdate(store, repoId, dir, "a.md", "# Title\n\nAlpha edited.\n\nBravo.\n");
    expect(a.ops.map((o) => [o.op.op, o.disposition, o.blocks])).toEqual(b.ops.map((o) => [o.op.op, o.disposition, o.blocks]));
  });
});

describe("planUpdate — byte-exact convergence on ordinary Markdown constructs", () => {
  const fm = "---\ntitle: Folded\nsources:\n  - >-\n    A long folded source description that\n    continues on a second line\n  - plain second source\n---\n";
  it("folded multi-line YAML list entry + blockquote under an H3 (edit elsewhere)", () => {
    const before = `${fm}\n# Title\n\nIntro paragraph with enough words to be carried across the edit.\n\n### Section heading\n> A quoted line directly under the heading.\n> Second quoted line.\n\nClosing paragraph with distinct content of its own.\n`;
    const after = `${fm}\n# Title\n\nIntro paragraph with enough words to be carried across the edit, revised.\n\n### Section heading\n> A quoted line directly under the heading.\n> Second quoted line.\n\nClosing paragraph with distinct content of its own.\n`;
    seed("a.md", before);
    const opset = planUpdate(store, repoId, dir, "a.md", after);
    expect(opset.diagnostics).toEqual([]);
    expect(opset.converges).toBe(true);
    const { result } = docsUpdate(store, ctx(), "a.md", after);
    expect(result!.committed).toBe(true);
    expect(fileOf("a.md")).toBe(after);
  });

  it("Markdown table (edit elsewhere)", () => {
    const table = "| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| bravo | 2 |\n";
    const before = `# Title\n\nIntro paragraph with enough words to be carried across the edit.\n\n${table}\nClosing paragraph with distinct content of its own.\n`;
    const after = `# Title\n\nIntro paragraph with enough words to be carried across the edit, revised.\n\n${table}\nClosing paragraph with distinct content of its own.\n`;
    seed("a.md", before);
    const opset = planUpdate(store, repoId, dir, "a.md", after);
    expect(opset.diagnostics).toEqual([]);
    expect(opset.converges).toBe(true);
    const { result } = docsUpdate(store, ctx(), "a.md", after);
    expect(result!.committed).toBe(true);
    expect(fileOf("a.md")).toBe(after);
  });

  // The constructs below used to fail BOTH lowerings (plan_not_convergent): a
  // freshly parsed block was marked dirty, so the splice renderer rebuilt
  // blockquotes/tables from their children — dropping `> ` markers and the
  // table delimiter row. Fresh raw is now authoritative (rendered verbatim).
  it("edits the text inside a blockquote under an H3 (container update, byte-exact)", () => {
    const before = `# Title\n\nIntro paragraph with enough words to be carried across the edit.\n\n### Section heading\n> A quoted line here with some words in it.\n\nClosing paragraph with distinct content of its own.\n`;
    const after = before.replace("some words in it.", "some words in it, changed.");
    const docId = seed("a.md", before);
    const idBefore = ids(docId);
    const opset = planUpdate(store, repoId, dir, "a.md", after);
    expect(opset.diagnostics).toEqual([]);
    expect(opset.converges).toBe(true);
    const { result } = docsUpdate(store, ctx(), "a.md", after);
    expect(result!.committed).toBe(true);
    expect(fileOf("a.md")).toBe(after);
    expect(ids(docId).get("Section heading")).toBe(idBefore.get("Section heading"));
  });

  it("replaces every row of a table (no carried children, byte-exact)", () => {
    const before = "# Title\n\nIntro paragraph with enough words to be carried across the edit.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nClosing paragraph with distinct content of its own.\n";
    const after = "# Title\n\nIntro paragraph with enough words to be carried across the edit.\n\n| c | d |\n|---|---|\n| 3 | 4 |\n\nClosing paragraph with distinct content of its own.\n";
    seed("a.md", before);
    const opset = planUpdate(store, repoId, dir, "a.md", after);
    expect(opset.diagnostics).toEqual([]);
    expect(opset.converges).toBe(true);
    docsUpdate(store, ctx(), "a.md", after);
    expect(fileOf("a.md")).toBe(after);
  });

  it("edits a line GFM folds into the preceding table / blockquote (lazy continuation)", () => {
    // What reads as "a paragraph after the table" is, without a blank line, a
    // table row; likewise a lazy line after `> quoted` belongs to the quote.
    const t1 = "# T\n\nIntro paragraph with enough words to be carried across the edit.\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\nClosing paragraph with distinct content of its own.\n";
    seed("a.md", t1);
    const t2 = t1.replace("of its own.", "of its own, edited here.");
    const o1 = planUpdate(store, repoId, dir, "a.md", t2);
    expect(o1.converges).toBe(true);
    docsUpdate(store, ctx(), "a.md", t2);
    expect(fileOf("a.md")).toBe(t2);

    const b1 = "# T\n\nIntro paragraph with enough words to be carried across the edit.\n\n### Sec\n> quoted\nClosing paragraph with distinct content of its own.\n";
    seed("b.md", b1);
    const b2 = b1.replace("of its own.", "of its own, edited here.");
    const o2 = planUpdate(store, repoId, dir, "b.md", b2);
    expect(o2.converges).toBe(true);
    docsUpdate(store, ctx(), "b.md", b2);
    expect(fileOf("b.md")).toBe(b2);
  });

  it("keeps a tight heading→blockquote seam when the quote is re-minted (anchor retiled)", () => {
    // A short quote's edit is not carried (small-block policy) → remove+insert.
    // opInsert heals the seam to a blank line; the planner must retile the
    // anchoring heading back to the proposed "\n" — with identity preserved.
    const before = "# T\n\nIntro paragraph with enough words to be carried across the edit.\n\n### Sec\n> short\n\nClosing paragraph with distinct content of its own.\n";
    const after = before.replace("> short", "> shorter");
    const docId = seed("a.md", before);
    const idBefore = ids(docId);
    const opset = planUpdate(store, repoId, dir, "a.md", after);
    expect(opset.diagnostics).toEqual([]);
    expect(opset.converges).toBe(true);
    docsUpdate(store, ctx(), "a.md", after);
    expect(fileOf("a.md")).toBe(after);
    expect(ids(docId).get("Sec")).toBe(idBefore.get("Sec"));
  });

  it("converts a paragraph into a blockquote and back without duplicating bytes", () => {
    // The reconciler carries the paragraph INTO the new quote's child position;
    // the op layer cannot express that (insert mints), so the old top-level
    // block must still be removed — else its bytes would appear twice.
    const para = "# T\n\nIntro paragraph with enough words to be carried across the edit.\n\n### Sec\nquoted text here\n\nClosing paragraph with distinct content of its own.\n";
    const quote = para.replace("\nquoted text here", "\n> quoted text here");
    seed("a.md", para);
    const o1 = planUpdate(store, repoId, dir, "a.md", quote);
    expect(o1.diagnostics).toEqual([]);
    docsUpdate(store, ctx(), "a.md", quote);
    expect(fileOf("a.md")).toBe(quote);
    const o2 = planUpdate(store, repoId, dir, "a.md", para);
    expect(o2.diagnostics).toEqual([]);
    docsUpdate(store, ctx(), "a.md", para);
    expect(fileOf("a.md")).toBe(para);
  });

  it("a non-convergent plan names the first divergent byte and block", () => {
    // Leading trivia (bytes before the first block) is not expressible via the
    // ops — the documented non-convergent case. The diagnostic must say where.
    seed("a.md", "# Title\n\nAlpha paragraph with several words.\n");
    const opset = planUpdate(store, repoId, dir, "a.md", "\n# Title\n\nAlpha paragraph with several words.\n");
    expect(opset.converges).toBe(false);
    const last = opset.diagnostics[opset.diagnostics.length - 1]!;
    expect(last).toMatch(/first divergence at byte 0 in leading trivia/);
    expect(() => applyOpset(store, { repoId, rootPath: dir, opset, origin: { actor: "t" } })).toThrow(/plan_not_convergent|first divergence at byte 0/);
  });

  it("blockquote directly under an H3 with no blank line (edit elsewhere)", () => {
    const before = `# Title\n\nIntro paragraph with enough words to be carried across the edit.\n\n### Section heading\n> A quoted line directly under the heading.\n\nClosing paragraph with distinct content of its own.\n`;
    const after = `# Title\n\nIntro paragraph with enough words to be carried across the edit, revised.\n\n### Section heading\n> A quoted line directly under the heading.\n\nClosing paragraph with distinct content of its own.\n`;
    seed("a.md", before);
    const opset = planUpdate(store, repoId, dir, "a.md", after);
    expect(opset.diagnostics).toEqual([]);
    expect(opset.converges).toBe(true);
    expect(fileOf("a.md")).toBe(before);
    const { result } = docsUpdate(store, ctx(), "a.md", after);
    expect(result!.committed).toBe(true);
    expect(fileOf("a.md")).toBe(after);
  });
});
