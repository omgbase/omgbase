import { describe, expect, it } from "vitest";
import { CommandLog, type CommandClient } from "@omgbase/client";
import { emptyModel, withNeighborhood, type GraphModel } from "../src/lib/graph.ts";
import { expandCommand, modelSwapCommand, pinCommand, pinKey, removeNodeCommand, unpinCommand, type ModelAccessor } from "../src/lib/graph-commands.ts";
import { linkRowsOf } from "../src/lib/links.ts";

const A = "/a.md";

/** A signal stand-in: the page's model box. */
function box(initial: GraphModel): ModelAccessor & { history: GraphModel[] } {
  let value = initial;
  const history: GraphModel[] = [];
  return { history, get: () => value, set: (m) => { value = m; history.push(m); } };
}

const noClient: CommandClient = {
  apply: () => Promise.reject(new Error("no writes in a view command")),
  docsRead: () => Promise.reject(new Error("no reads")),
  query: () => Promise.reject(new Error("no reads")),
  call: () => Promise.reject(new Error("no calls")),
} as unknown as CommandClient;

describe("pin / unpin", () => {
  it("pinCommand is a coalescing `view` command: redo pins, undo restores the previous pin (null = unpinned)", async () => {
    const b = box(emptyModel(A));
    const cmd = pinCommand(b, A, { x: 10, y: 20 }, null);
    expect(cmd.kind).toBe("view");
    expect(cmd.label).toBe(`pin ${A}`);
    expect(cmd.coalesceKey).toBe(`pin:${A}`);
    expect(pinKey("/x.md")).toBe("pin:/x.md");
    await cmd.redo();
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 10, y: 20 });
    await cmd.undo();
    expect(b.get().nodes.get(A)!.pinned).toBeNull();
    const move = pinCommand(b, A, { x: 30, y: 40 }, { x: 10, y: 20 });
    await move.redo();
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 30, y: 40 });
    await move.undo();
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 10, y: 20 });
  });

  it("pins fold into one history entry per node until the log is sealed; undo restores the pre-drag state", async () => {
    const b = box(emptyModel(A));
    const log = new CommandLog({ client: noClient });
    await log.run(pinCommand(b, A, { x: 1, y: 1 }, null));
    await log.run(pinCommand(b, A, { x: 2, y: 2 }, { x: 1, y: 1 }));
    await log.run(pinCommand(b, A, { x: 3, y: 3 }, { x: 2, y: 2 }));
    expect(log.history).toHaveLength(1);
    expect(log.history[0]!.steps).toHaveLength(3);
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 3, y: 3 });
    log.seal();
    await log.run(pinCommand(b, A, { x: 4, y: 4 }, { x: 3, y: 3 }));
    expect(log.history).toHaveLength(2);
    await log.undo();
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 3, y: 3 });
    await log.undo();
    expect(b.get().nodes.get(A)!.pinned).toBeNull();
    await log.redo();
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 3, y: 3 });
  });

  it("unpinCommand clears the pin and restores it on undo; it does not coalesce with the drag", async () => {
    const b = box(emptyModel(A));
    await pinCommand(b, A, { x: 5, y: 6 }, null).redo();
    const cmd = unpinCommand(b, A, { x: 5, y: 6 });
    expect(cmd.kind).toBe("view");
    expect(cmd.label).toBe(`unpin ${A}`);
    expect(cmd.coalesceKey).toBeUndefined();
    await cmd.redo();
    expect(b.get().nodes.get(A)!.pinned).toBeNull();
    await cmd.undo();
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 5, y: 6 });
  });

  it("the pin a command restores is a copy, not the caller's object", async () => {
    const b = box(emptyModel(A));
    const prev = { x: 1, y: 1 };
    const cmd = pinCommand(b, A, { x: 2, y: 2 }, prev);
    prev.x = 99;
    await cmd.redo();
    await cmd.undo();
    expect(b.get().nodes.get(A)!.pinned).toEqual({ x: 1, y: 1 });
  });
});

describe("expand / swap", () => {
  it("expandCommand is a `query` command swapping whole models", async () => {
    const before = emptyModel(A);
    const after = withNeighborhood(before, A, { inbound: [], byName: [], outbound: linkRowsOf([{ _id: "e_1", _path: A, _dst_path: "/b.md", _dst_kind: "document", _provenance: "link", _block_id: "b_1" }]) });
    const b = box(before);
    const cmd = expandCommand(b, A, before, after);
    expect(cmd.kind).toBe("query");
    expect(cmd.label).toBe(`expand ${A}`);
    expect(cmd.coalesceKey).toBeUndefined();
    await cmd.redo();
    expect(b.get()).toBe(after);
    await cmd.undo();
    expect(b.get()).toBe(before);
    const rm = removeNodeCommand(b, "/b.md", after, before);
    expect(rm.kind).toBe("view");
    expect(rm.label).toBe("remove /b.md from the graph");
    const swap = modelSwapCommand(b, "view", "custom", before, after);
    await swap.redo();
    expect(b.get()).toBe(after);
  });

  it("through the log: expand then pin, undo twice returns to the empty model", async () => {
    const before = emptyModel(A);
    const after = withNeighborhood(before, A, { inbound: [], byName: [], outbound: linkRowsOf([{ _id: "e_1", _path: A, _dst_path: "/b.md", _dst_kind: "document", _provenance: "link", _block_id: "b_1" }]) });
    const b = box(before);
    const log = new CommandLog({ client: noClient });
    await log.run(expandCommand(b, A, before, after));
    await log.run(pinCommand(b, "/b.md", { x: 7, y: 7 }, null));
    expect(log.history.map((e) => e.kind)).toEqual(["query", "view"]);
    expect(b.get().nodes.get("/b.md")!.pinned).toEqual({ x: 7, y: 7 });
    await log.undo();
    expect(b.get().nodes.get("/b.md")!.pinned).toBeNull();
    await log.undo();
    expect(b.get()).toBe(before);
  });
});
