import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `--server` against a MINIMAL server (spec/cli §2.3 "Profiles", 4.2; spec/surface
// §4 "Profiles"): `omg mcp --tools minimal` lists ten tools, none of them a
// sugar tool, so every sugar verb must fall back to `apply { effects }` built
// by the local builders — and a `#` locator, which only a server with the sugar
// tools resolves, must be refused loudly. Drives the built binary both ways:
// the client `omg` spawns the server `omg mcp --tools minimal` over stdio.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;
let server: string;

const ENV = { ...process.env, NO_COLOR: "1" };

function local(args: string[], input?: string): string {
  return execFileSync("node", [BIN, "-C", vault, ...args], { encoding: "utf8", env: ENV, ...(input !== undefined ? { input } : {}) });
}
function remote(args: string[], input?: string): string {
  return execFileSync("node", [BIN, "--server", server, ...args], { encoding: "utf8", env: ENV, ...(input !== undefined ? { input } : {}) });
}
function remoteFails(args: string[]): { status: number; stderr: string } {
  const r = spawnSync("node", [BIN, "--server", server, ...args], { encoding: "utf8", env: ENV });
  return { status: r.status ?? -1, stderr: r.stderr };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-remote-min-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "hub.md"), ["---", "layer: draft", "---", "", "# Hub", "", "Intro.", "", "## Tasks", "", "- [ ] a task", "- [ ] another", ""].join("\n"));
  writeFileSync(join(vault, "old.md"), "# Old\n\nSee [hub](/hub.md).\n");
  execFileSync("node", [BIN, "init", vault, "--yes", "--no-embedder"], { encoding: "utf8", env: ENV });
  execFileSync("node", [BIN, "-C", vault, "source", "add", ".", "-y"], { encoding: "utf8", env: ENV });
  // The server the client spawns: the same binary, serving the minimal profile without a watcher.
  server = `node ${BIN} mcp -C ${vault} --no-watch --tools minimal`;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("omg --server against `omg mcp --tools minimal`", () => {
  it("version reports the remote profile; a read goes through as always", () => {
    const v = JSON.parse(remote(["version", "--json"])) as { profile: string; engine: string };
    expect(v.engine).toBe("typescript");
    expect(v.profile).toBe("minimal");
    expect(remote(["version"])).toContain("profile  minimal");
    expect(local(["version"])).toContain("profile  full");
    const out = JSON.parse(remote(["cat", "hub.md", "--json"])) as { path: string };
    expect(out.path).toBe("/hub.md");
  }, 60_000);

  it("done falls back to apply { effects } (no blocks_check on the server) and the file changes", () => {
    // `order by text`: the default order is (path, id) and ids are random here, so without it `ids[0]` is either task.
    const ids = local(["query", 'from blocks where type == "task" and not checked order by text', "--ids"]).trim().split("\n").filter(Boolean);
    expect(ids).toHaveLength(2);
    const receipt = JSON.parse(remote(["done", ids[0]!, "--json"])) as { committed: boolean; revisions: { path: string }[] };
    expect(receipt.committed).toBe(true);
    expect(receipt.revisions.map((r) => r.path)).toEqual(["/hub.md"]);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toContain("- [x] a task");
  }, 60_000);

  it("insert / append / update <block> / new / meta / mv / rm --doc all commit through apply", () => {
    const hubId = (JSON.parse(local(["cat", "hub.md", "--json"])) as { id: string }).id;
    // insert at a document's top level (a path ref → a document target)
    const ins = JSON.parse(remote(["insert", "hub.md", "-m", "## Notes\n\nfirst", "--json"])) as { new_ids: Record<string, string>; committed: boolean };
    expect(ins.committed).toBe(true);
    const notes = Object.values(ins.new_ids)[0]!;
    expect(notes).toMatch(/^b_/);
    // append into the new heading's section — the block type read through `query` on a minimal server
    const app = JSON.parse(remote(["append", notes, "-m", "second", "--json"])) as { committed: boolean };
    expect(app.committed).toBe(true);
    // update a block by id (CAS pinned by the planner)
    const upd = JSON.parse(remote(["update", notes, "-m", "## Notes (renamed)", "--json"])) as { committed: boolean };
    expect(upd.committed).toBe(true);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toContain("## Notes (renamed)\n\nfirst\n\nsecond");
    // new, meta, mv, rm --doc
    const created = JSON.parse(remote(["new", "fresh.md", "-m", "# Fresh\n", "--json"])) as { id: string; path: string; committed: boolean };
    expect(created.path).toBe("/fresh.md");
    expect(created.committed).toBe(true);
    const meta = JSON.parse(remote(["meta", "fresh.md", "--set", "layer=draft", "--json"])) as { path: string; committed: boolean };
    expect(meta.path).toBe("/fresh.md");
    expect(readFileSync(join(vault, "fresh.md"), "utf8")).toContain("layer: draft");
    const moved = JSON.parse(remote(["mv", "fresh.md", "notes/fresh.md", "--json"])) as { path: string; retargeted: unknown; dangling: unknown[] };
    expect(moved.path).toBe("/notes/fresh.md");
    expect(moved.dangling).toEqual([]);
    expect(moved.retargeted).toBeNull();
    const rm = JSON.parse(remote(["rm", "--doc", "notes/fresh.md", "--json"])) as { path: string; committed: boolean };
    expect(rm.path).toBe("/notes/fresh.md");
    // a whole-document update (docs_update → apply { set content })
    const doc = JSON.parse(remote(["update", hubId, "-m", "---\nlayer: draft\n---\n\n# Hub\n\nIntro, rewritten.\n", "--json"])) as { committed: boolean };
    expect(doc.committed).toBe(true);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toContain("Intro, rewritten.");
  }, 120_000);

  it("retarget --apply falls back to apply { retarget } and rewrites the link", () => {
    const r = JSON.parse(remote(["retarget", "/hub.md", "/hub-renamed.md", "--apply", "--json"])) as { committed: boolean; revisions: { path: string }[] };
    expect(r.committed).toBe(true);
    expect(r.revisions.map((x) => x.path)).toEqual(["/old.md"]);
    expect(readFileSync(join(vault, "old.md"), "utf8")).toContain("(/hub-renamed.md)");
  }, 60_000);

  it("a `#` locator is a usage error (exit 2) on a server without the sugar tool, never a bogus document path", () => {
    const r = remoteFails(["done", "hub.md#task[0]"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: "hub.md#task[0]" is a locator, and this server does not list blocks_check (a minimal tools profile)');
  }, 60_000);

  it("--dry-run is `plan` under either profile", () => {
    const plan = JSON.parse(remote(["--dry-run", "insert", "hub.md", "-m", "dry", "--json"])) as { plan_id: string; preview: { diffs: Record<string, unknown> } };
    expect(plan.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(plan.preview.diffs)).toEqual(["/hub.md"]);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).not.toContain("dry");
  }, 60_000);
});
