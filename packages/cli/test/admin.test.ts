import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The admin verbs' size surface (spec/cli §6 `doctor --size`, `gc --vacuum`):
// the report over a small workspace, its JSON, and the vacuum round trip. The
// spec runner (corpus/cli/spec.test.ts) pins the bytes of both by shape; this
// suite checks the numbers themselves are sane.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;

function omg(args: string[], opts: { expectFail?: boolean } = {}): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync("node", [BIN, "-C", vault, "--no-color", ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (!opts.expectFail) throw new Error(`omg ${args.join(" ")} failed: ${e.stderr ?? e.stdout ?? err}`);
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1 };
  }
}

interface SizeJson {
  file: { path: string; bytes: number; wal_bytes: number; page_size: number; page_count: number; freelist_count: number; reclaimable: number };
  categories: { name: string; bytes: number; share: number; rows: number; tables: { name: string; bytes: number; share: number; rows: number; indexes: number }[] }[];
  advice: string[];
  detail?: string;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-admin-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(vault, `note-${i}.md`), `---\ntitle: Note ${i}\n---\n# Note ${i}\n\n- [ ] task ${i}\n\nSee [next](note-${(i + 1) % 6}.md).\n\n${"lorem ipsum ".repeat(40)}\n`);
  }
  omg(["init", "--yes", "--no-embedder"]);
  omg(["source", "add", ".", "--repo", "vault", "-y"]);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("doctor --size", () => {
  it("reports the six categories over every table, the file, the feed and advice", () => {
    const r = JSON.parse(omg(["doctor", "--size", "--json"]).stdout) as SizeJson;
    expect(r.file.path).toBe(join(vault, ".omgbase", "omgbase.db"));
    expect(r.file.bytes).toBe(statSync(r.file.path).size);
    expect(r.file.page_size * r.file.page_count).toBeGreaterThan(0);
    expect(r.file.reclaimable).toBe(r.file.freelist_count * r.file.page_size);
    expect(r.categories.map((c) => c.name)).toEqual(["content", "identity", "recovery", "history", "search", "sync"]);
    expect(r.detail).toBeUndefined();
    // store 17.0 (3e): the feed's position and policy of the store's one repository.
    expect(r.feed).toMatchObject({ oldest: 1, retain_days: 10, retain_entries: 10000, max_entries: 100000 });
    expect(r.feed!.epoch).toMatch(/^ep_/);
    expect(r.feed!.head).toBe(r.feed!.entries);
    expect(r.categories[1]!.tables.map((t) => t.name).sort()).toEqual(["id_claims", "resurrection_pool"]);
    expect(r.categories[2]!.tables.map((t) => t.name)).toEqual(["pending_materializations"]);
    const content = r.categories[0]!;
    const blocks = content.tables.find((t) => t.name === "blocks")!;
    expect(blocks.rows).toBeGreaterThan(6 * 3);
    expect(blocks.bytes).toBeGreaterThan(0);
    expect(blocks.indexes).toBeGreaterThan(0);
    expect(blocks.indexes).toBeLessThan(blocks.bytes);
    // Categories sum to the whole, shares to ~100.
    const total = r.categories.reduce((n, c) => n + c.bytes, 0);
    const shares = r.categories.reduce((n, c) => n + c.share, 0);
    expect(Math.abs(shares - 100)).toBeLessThan(0.3);
    for (const c of r.categories) expect(c.share).toBe(Math.round((c.bytes * 1000) / total) / 10);
    // Tables by bytes desc then name; a category's rows are its tables'.
    for (const c of r.categories) {
      const sorted = [...c.tables].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).map((t) => t.name);
      expect(c.tables.map((t) => t.name)).toEqual(sorted);
      expect(c.rows).toBe(c.tables.reduce((n, t) => n + t.rows, 0));
    }
    expect(r.categories[4]!.tables.map((t) => t.name).sort()).toEqual(["blocks_fts", "doc_embeddings", "embeddings", "nodes_fts"]);
    expect(r.advice).toEqual(["nothing to reclaim"]);
  });

  it("renders the table, the file lines and the advice, exit 0, without a repo selection", () => {
    const { stdout } = omg(["doctor", "--size"]);
    const lines = stdout.split("\n");
    // The name column is as wide as the widest name shown (`pending_materializations` since 17.0's six categories).
    expect(lines[0]).toMatch(/^ {2}category {2,}bytes {3}share {2}rows$/);
    expect(lines[1]).toMatch(/^ {2}content {2,} *\d+(\.\d)? [KMGT]?B {2} *\d+\.\d% {2} *\d+$/);
    // Each category heads at most three indented tables.
    const cats = lines.filter((l) => /^ {2}\S/.test(l) && !/^ {2}(category|file|size|pages|reclaimable|archived|id claims|feed|advice)/.test(l));
    expect(cats.map((l) => l.trim().split(/\s+/)[0])).toEqual(["content", "identity", "recovery", "history", "search", "sync"]);
    const tables = lines.filter((l) => /^ {4}\S/.test(l));
    expect(tables.length).toBeLessThanOrEqual(18);
    expect(tables.length).toBeGreaterThanOrEqual(12);
    expect(lines).toContain("");
    expect(stdout).toMatch(/\n {2}file {9}.*omgbase\.db\n {2}size {9}\d+(\.\d)? [KMGT]?B on disk, wal \d+(\.\d)? [KMGT]?B\n {2}pages {8}\d+ x \d+ bytes, \d+ free\n {2}reclaimable {2}\d+(\.\d)? [KMGT]?B\n {2}archived {5}0 revisions in 0 segments, 0 B on disk\n {2}id claims {4}\d+ ids claimed\n {2}feed {9}epoch ep_[0-9a-z]+, \d+ entries, seq \d+\.\.\d+\n {2}advice: nothing to reclaim\n$/);
    // The checks still run without --size.
    // store 17.0 (3d): the `convergence` check left with `repos_status.unconverged` (identically true under I1).
    expect(omg(["doctor"]).stdout).not.toContain("convergence");
    expect(omg(["doctor"]).stdout).toContain("  ok head present");
  });
});

describe("gc --vacuum", () => {
  it("needs gc.enabled like the sweep, measures on --dry-run, vacuums otherwise", () => {
    const refused = omg(["gc", "--vacuum"], { expectFail: true });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("gc is disabled; set gc.enabled=true (or use --dry-run)");

    const dry = JSON.parse(omg(["gc", "--dry-run", "--vacuum", "--json"]).stdout) as { blobsSwept: number; treeNodesSwept: number; vacuum: { reclaimable: number; applied: boolean } };
    expect(dry.vacuum.applied).toBe(false);
    const before = JSON.parse(omg(["doctor", "--size", "--json"]).stdout) as SizeJson;
    expect(dry.vacuum.reclaimable).toBe(before.file.reclaimable);

    omg(["config", "set", "gc.enabled", "true"]);
    const run = JSON.parse(omg(["gc", "--vacuum", "--json"]).stdout) as typeof dry;
    expect(run).toEqual({ blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0, claimsReleased: 0, feedPruned: 0, vacuum: { reclaimable: before.file.reclaimable, applied: true } });
    const after = JSON.parse(omg(["doctor", "--size", "--json"]).stdout) as SizeJson;
    expect(after.file.freelist_count).toBe(0);
    expect(after.file.reclaimable).toBe(0);
    expect(after.categories[0]!.rows).toBe(before.categories[0]!.rows);
    expect(omg(["doctor"]).stdout).toContain("  ok sqlite integrity");
  });
});
