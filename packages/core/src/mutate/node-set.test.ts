import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { apply } from "./apply.js";
import { nodeSet, editablePropsFor } from "./macros.js";
import { MutationError } from "./tree.js";
import "../format/index.js";

let store: Store | undefined;
let dir: string | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function setup(file: string, content: string): { store: Store; repoId: string; root: string } {
  dir = mkdtempSync(join(tmpdir(), "omg-nodeset-"));
  writeFileSync(join(dir, file), content);
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", dir);
  ingestFile(store, repoId, file, content);
  return { store, repoId, root: dir };
}

function nodeIdByKindValue(store: Store, kind: string, value: string): string {
  const row = store.db.prepare("SELECT node_id FROM nodes WHERE kind = ? AND value = ?").get(kind, value) as { node_id: string } | undefined;
  if (!row) throw new Error(`no ${kind} node with value ${value}`);
  return row.node_id;
}

describe("nodeSet — surgical node-property edits via block update", () => {
  it("edits the text of ONE link among several in a paragraph, leaving the rest byte-exact", () => {
    const { store, repoId, root } = setup("a.md", "# Doc\n\nSee [a](/x.md) then [b](/y.md) here.\n");
    const nodeId = nodeIdByKindValue(store, "md:link", "/y.md"); // the second link

    const ops = nodeSet(store, nodeId, "name", "Bee");
    apply(store, { repoId, rootPath: root, ops, origin: { actor: "test", reason: "node_set" } });

    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# Doc\n\nSee [a](/x.md) then [Bee](/y.md) here.\n");
  });

  it("retargets a link's destination (value) at its exact span", () => {
    const { store, repoId, root } = setup("a.md", "# Doc\n\nSee [a](/x.md) and [a](/y.md).\n");
    // Two links share the text "a"; target /x.md is the first.
    const nodeId = nodeIdByKindValue(store, "md:link", "/x.md");
    const ops = nodeSet(store, nodeId, "value", "/z.md");
    apply(store, { repoId, rootPath: root, ops, origin: { actor: "test", reason: "node_set" } });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# Doc\n\nSee [a](/z.md) and [a](/y.md).\n");
  });

  it("edits a link that follows non-ASCII text (stored spans are bytes, sliced as code units)", () => {
    // `Café` (é = 2 bytes) and `🚀` (4 bytes, 2 code units) precede the links,
    // so byte offsets and string indices disagree; the edit must still land on
    // the exact occurrence, byte for byte.
    const { store, repoId, root } = setup("a.md", "# Doc\n\nCafé 🚀 [a](/x.md) et [b](/y.md) — fin.\n");
    const nodeId = nodeIdByKindValue(store, "md:link", "/y.md");
    const span = store.db.prepare("SELECT span_start, span_end FROM nodes WHERE node_id = ?").get(nodeId) as { span_start: number; span_end: number };
    const raw = "Café 🚀 [a](/x.md) et [b](/y.md) — fin.";
    const bytes = Buffer.from(raw, "utf8");
    expect(bytes.subarray(span.span_start, span.span_end).toString("utf8")).toBe("[b](/y.md)");
    expect(span.span_start).toBe(Buffer.byteLength("Café 🚀 [a](/x.md) et ", "utf8"));

    const ops = nodeSet(store, nodeId, "name", "Bee");
    apply(store, { repoId, rootPath: root, ops, origin: { actor: "test", reason: "node_set" } });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# Doc\n\nCafé 🚀 [a](/x.md) et [Bee](/y.md) — fin.\n");

    // And the retarget editor, on the first link (before it: 2-byte + 4-byte characters).
    const first = nodeIdByKindValue(store, "md:link", "/x.md");
    apply(store, { repoId, rootPath: root, ops: nodeSet(store, first, "value", "/z.md"), origin: { actor: "test" } });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# Doc\n\nCafé 🚀 [a](/z.md) et [Bee](/y.md) — fin.\n");
  });

  it("sets a task's checked attribute", () => {
    const { store, repoId, root } = setup("t.md", "- [ ] ship it\n");
    const nodeId = nodeIdByKindValue(store, "md:task", "ship it");
    const ops = nodeSet(store, nodeId, "checked", "true");
    apply(store, { repoId, rootPath: root, ops, origin: { actor: "test", reason: "node_set" } });
    expect(readFileSync(join(root, "t.md"), "utf8")).toBe("- [x] ship it\n");
  });

  it("throws node_not_editable for an unregistered property, listing what IS editable", () => {
    const { store } = setup("a.md", "# Doc\n\nSee [a](/x.md).\n");
    const nodeId = nodeIdByKindValue(store, "md:link", "/x.md");
    try {
      nodeSet(store, nodeId, "color", "blue");
      throw new Error("expected node_not_editable");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      expect((e as MutationError).code).toBe("node_not_editable");
      expect((e as MutationError).data).toMatchObject({ editable: ["name", "value"] });
    }
  });

  it("block AND node ids survive an edit (intent path carries identity)", () => {
    const { store, repoId, root } = setup("a.md", "# Doc\n\nSee [a](/x.md) then [b](/y.md) here.\n");
    const nodeBefore = store.db.prepare("SELECT node_id, block_id FROM nodes WHERE value = '/y.md'").get() as { node_id: string; block_id: string };
    const paraBefore = store.db.prepare("SELECT block_id FROM blocks WHERE type = 'paragraph'").get() as { block_id: string };

    apply(store, { repoId, rootPath: root, ops: nodeSet(store, nodeBefore.node_id, "name", "Bee"), origin: { actor: "test" } });

    const paraAfter = store.db.prepare("SELECT block_id FROM blocks WHERE type = 'paragraph'").all() as { block_id: string }[];
    const nodeAfter = store.db.prepare("SELECT node_id FROM nodes WHERE value = '/y.md'").get() as { node_id: string } | undefined;
    // The edited paragraph keeps its block id (not re-minted by a reconcile).
    expect(paraAfter.length).toBe(1);
    expect(paraAfter[0]!.block_id).toBe(paraBefore.block_id);
    // The node id — derived from (doc, block, kind, ordinal) — therefore survives.
    expect(nodeAfter?.node_id).toBe(nodeBefore.node_id);

    // And the SAME node id is still editable a second time (was impossible when
    // apply re-reconciled its own writes and re-minted).
    const ops2 = nodeSet(store, nodeAfter!.node_id, "value", "/z.md");
    apply(store, { repoId, rootPath: root, ops: ops2, origin: { actor: "test" } });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# Doc\n\nSee [a](/x.md) then [Bee](/z.md) here.\n");
  });

  it("editablePropsFor reports the registered props per kind", () => {
    expect(editablePropsFor("markdown", "md:link").sort()).toEqual(["name", "value"]);
    expect(editablePropsFor("markdown", "md:task")).toEqual(["checked"]);
    expect(editablePropsFor("markdown", "md:anchor")).toEqual([]); // no editor registered
  });
});
