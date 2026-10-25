import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Embedding CLI surface over the external stdio provider seam. Uses the
// deterministic fake embedder fixture (no model download) so the whole
// status → drain → semantic-query path is exercised fast and offline.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");
const FAKE = resolve(HERE, "..", "..", "core", "test", "fixtures", "fake-embedder.mjs");

let dir: string;
let vault: string;

function omg(args: string[], input?: string): string {
  return execFileSync("node", [BIN, "-C", vault, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...(input !== undefined ? { input } : {}),
  });
}
function omgFails(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync("node", [BIN, "-C", vault, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-embed-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    join(vault, "arch.md"),
    "# Architecture\n\nThe engine serializes all state changes through one append-only commit log per repository backed by an embedded SQLite database in write-ahead-logging mode for durability and concurrency.\n",
  );
  writeFileSync(
    join(vault, "cook.md"),
    "# Recipes\n\nTo make a proper risotto you toast the arborio rice in butter then add warm stock one ladle at a time stirring until each addition is absorbed before adding more.\n",
  );
  // --no-embedder: start with NO provider so the "no provider configured" block
  // is deterministic regardless of whether omgbase-embedder is on the test host.
  execFileSync("node", [BIN, "init", vault, "--yes", "--no-embedder"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  execFileSync("node", [BIN, "-C", vault, "source", "add", ".", "-y"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("embed with no provider configured", () => {
  it("status reports no provider (exit 0)", () => {
    const res = JSON.parse(omg(["embed", "status", "--json"])) as { provider: string | null };
    expect(res.provider).toBeNull();
  });

  it("oqx semantic() without a provider → provider_unavailable, exit 1", () => {
    const { code, stderr } = omgFails(["query", 'from blocks where semantic("durability") > 0', "--json"]);
    expect(code).toBe(1);
    expect(stderr).toContain("provider_unavailable");
  });
});

describe("embed via external stdio provider (fake embedder)", () => {
  beforeEach(() => {
    omg(["config", "set", "embedding.provider", `node ${FAKE}`]);
  });

  it("status → drain → status reflects the queue draining", () => {
    const before = JSON.parse(omg(["embed", "status", "--json"])) as { provider: string; queued: number; embeddable: number; docs: number; docsQueued: number };
    expect(before.embeddable).toBeGreaterThanOrEqual(2);
    expect(before.queued).toBe(before.embeddable);
    // Doc-grain queue is reported and non-empty before draining.
    expect(before.docsQueued).toBe(before.docs);
    expect(before.docs).toBeGreaterThanOrEqual(1);

    // Drain embeds both grains; `embedded` folds in the doc vectors, so it's the
    // block queue plus the doc queue (each doc = one whole-doc or pooled vector).
    const drained = JSON.parse(omg(["embed", "drain", "--json"])) as { embedded: number };
    expect(drained.embedded).toBe(before.embeddable + before.docsQueued);

    const after = JSON.parse(omg(["embed", "status", "--json"])) as { queued: number; docsQueued: number };
    expect(after.queued).toBe(0);
    expect(after.docsQueued).toBe(0);
  });

  it("oqx order by semantic() returns ranked hits after draining", () => {
    omg(["embed", "drain"]);
    const res = JSON.parse(omg(["query", 'from blocks order by semantic("database durability and crash safety") desc', "--json"])) as { hits: { path: string }[] };
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("find works with a provider configured (hybrid)", () => {
    omg(["embed", "drain"]);
    const ids = omg(["find", "risotto rice cooking", "-1"]).trim();
    expect(ids).toMatch(/^b_/);
  });

  it("switching models invalidates the index: the drain rescans, the old model's vectors go, and --prune has nothing left to reclaim", () => {
    // Embed under the default fake model, then re-run under a different model
    // name (as a model swap would). The indexer's watermark records the index
    // identity (model, dims, chunking); a drain under another identity is a
    // rescan that deletes the old identity's rows before re-embedding
    // (modular-core Phase 2) — `--prune` is no longer needed for a model swap.
    const first = JSON.parse(omg(["embed", "drain", "--json"])) as { mode: string; processed_seq: number | null; head: number | null; pruned: { blocks: number; docs: number } };
    expect(first.mode).toBe("bootstrap");
    expect(first.processed_seq).toBe(first.head);
    const swapped = { ...process.env, NO_COLOR: "1", OMGBASE_EMBEDDER_MODEL: "fake-other" };
    const run = (args: string[]): string => execFileSync("node", [BIN, "-C", vault, ...args], { encoding: "utf8", env: swapped });

    const status = JSON.parse(run(["embed", "status", "--json"])) as { foreignBlocks: number; foreignDocs: number; watermark: { identity: { model: string } | null; fresh: boolean | null } };
    expect(status.foreignBlocks).toBeGreaterThanOrEqual(2);
    expect(status.foreignDocs).toBeGreaterThanOrEqual(1);
    expect(status.watermark.identity?.model).not.toBe("fake-other");
    expect(status.watermark.fresh).toBe(false); // built under another identity

    // Under the new model: a rescan that invalidates the old identity's rows and re-embeds everything.
    const swap = JSON.parse(run(["embed", "drain", "--json"])) as { mode: string; embedded: number; pruned: { blocks: number; docs: number } };
    expect(swap.mode).toBe("rescan");
    expect(swap.pruned.blocks).toBe(status.foreignBlocks);
    expect(swap.pruned.docs).toBe(status.foreignDocs);
    expect(swap.embedded).toBeGreaterThanOrEqual(3);

    const after = JSON.parse(run(["embed", "status", "--json"])) as { foreignBlocks: number; foreignDocs: number; queued: number; docsQueued: number; watermark: { identity: { model: string } | null; fresh: boolean | null } };
    expect(after.foreignBlocks).toBe(0);
    expect(after.foreignDocs).toBe(0);
    expect(after.queued).toBe(0);
    expect(after.docsQueued).toBe(0);
    expect(after.watermark.identity?.model).toBe("fake-other");
    expect(after.watermark.fresh).toBe(true);

    // --prune still works, and finds nothing foreign.
    const pruned = JSON.parse(run(["embed", "drain", "--prune", "--json"])) as { mode: string; pruned: { blocks: number; docs: number } };
    expect(pruned.mode).toBe("rescan");
    expect(pruned.pruned).toEqual({ blocks: 0, docs: 0 });
  });
});

describe("attach auto-drains when a provider is configured", () => {
  it("attach embeds the freshly-ingested blocks, leaving nothing queued", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-attach-drain-"));
    try {
      writeFileSync(
        join(root, "arch.md"),
        "# Architecture\n\nThe engine serializes all state changes through one append-only commit log per repository backed by an embedded SQLite database in write-ahead logging mode for durability and concurrency across readers.\n",
      );
      // init with the fake embedder as the provider, then attach.
      execFileSync("node", [BIN, "init", root, "--yes", "--embedder", `node ${FAKE}`], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      const attachJson = execFileSync("node", [BIN, "-C", root, "--json", "source", "add", ".", "-y"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      const res = JSON.parse(attachJson) as { ingested: number; embedded?: number };
      expect(res.ingested).toBe(1);
      expect(res.embedded).toBeGreaterThanOrEqual(1);
      // Queue is empty right after attach — no separate drain needed.
      const status = JSON.parse(execFileSync("node", [BIN, "-C", root, "embed", "status", "--json"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })) as { queued: number };
      expect(status.queued).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
