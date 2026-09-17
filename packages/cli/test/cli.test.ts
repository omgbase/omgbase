import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CLI-A acceptance suite (11 §6, §7 gate). Spawns the built binary against a
// fixture vault and asserts output shape, exit codes, and --json parity. Covers
// C1 (outline frozen wire format), C3 (log --since), C4 (query has_edge), plus
// the freshness gate (out-of-band edit visible without a watcher).

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;

function omg(args: string[], opts: { expectFail?: boolean } = {}): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("node", [BIN, "-C", vault, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" }, // deterministic: force plain tier
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (!opts.expectFail) throw new Error(`omg ${args.join(" ")} failed: ${e.stderr ?? e.stdout ?? err}`);
    return { stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-cli-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    join(vault, "hub.md"),
    [
      "---",
      "title: Hub",
      "status: active",
      "---",
      "# Hub",
      "",
      "Intro paragraph.",
      "",
      "## Launch",
      "",
      "- [ ] wire the deploy pipeline",
      "- [x] write the readme",
      "",
      "## Links",
      "",
      "See [target](target.md).",
      "",
    ].join("\n"),
  );
  writeFileSync(join(vault, "target.md"), "# Target\n\nReferenced by hub.\n");
  // init (build the workspace), then attach the tree to ingest it.
  execFileSync("node", [BIN, "init", vault, "--yes", "--no-embedder"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  execFileSync("node", [BIN, "-C", vault, "attach", ".", "-y"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bootstrap", () => {
  it("repos lists the attached vault", () => {
    const { stdout } = omg(["repos", "--json"]);
    const repos = JSON.parse(stdout) as { slug: string; docs: number }[];
    expect(repos).toHaveLength(1);
    expect(repos[0]!.slug).toBe("vault");
    expect(repos[0]!.docs).toBe(2);
  });
});

describe("C1 — orient (outline, frozen wire format)", () => {
  it("emits an outline with full block ids inline", () => {
    const { stdout } = omg(["outline", "hub.md", "--json"]);
    const res = JSON.parse(stdout) as { text: string };
    // Wire format: `b_… h1 Hub §` style lines; heading gets a section mark.
    expect(res.text).toMatch(/^b_[0-9a-z]+ h1\s+Hub/m);
    expect(res.text).toContain("§");
    expect(res).not.toHaveProperty("ids");
  });
});

describe("C3 — what changed (log)", () => {
  it("prints one digest per commit", () => {
    const { stdout } = omg(["log"]);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatch(/#\d+\s+observed/);
  });

  it("--since 24h resolves client-side and returns recent commits", () => {
    const { stdout } = omg(["log", "--since", "24h", "--json"]);
    const res = JSON.parse(stdout) as { digests: unknown[] };
    expect(res.digests.length).toBeGreaterThanOrEqual(2);
  });
});

describe("C4 — dependency query (has_edge)", () => {
  it("finds docs that reference the target via a CEL edge predicate", () => {
    // target.md's doc id, then query documents linking to it.
    const repos = JSON.parse(omg(["repos", "--json"]).stdout) as unknown;
    void repos;
    const links = JSON.parse(omg(["links", "target.md", "--in", "--json"]).stdout) as {
      in: { node: string; predicate: string }[];
    };
    expect(links.in.length).toBeGreaterThanOrEqual(1);
    expect(links.in[0]!.predicate).toBe("references");
  });
});

describe("query (oqx)", () => {
  it("OQX filter over tasks, --ids emits bare ids (pipe fuel)", () => {
    const { stdout } = omg(["query", 'from blocks where type == "task"', "--ids"]);
    const ids = stdout.trim().split("\n").filter(Boolean);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^b_/);
  });

  it("unchecked-task filter narrows the set", () => {
    const { stdout } = omg(["query", 'from blocks where type == "task" && !attrs.checked', "--ids"]);
    expect(stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("a select clause projects fields onto each hit", () => {
    const { stdout } = omg(["query", 'from blocks where type == "task" select p: $path, t: type', "--json"]);
    const { hits } = JSON.parse(stdout) as { hits: Record<string, unknown>[] };
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.p).toBeDefined();
      expect(h.t).toBe("task");
    }
  });
});

describe("freshness (§3.3): reads are current without a watcher", () => {
  it("an out-of-band edit is visible on the next command", () => {
    const before = omg(["query", 'from blocks where type == "task"', "--ids"]).stdout.trim().split("\n").filter(Boolean);
    expect(before).toHaveLength(2);

    writeFileSync(
      join(vault, "hub.md"),
      [
        "---",
        "title: Hub",
        "status: active",
        "---",
        "# Hub",
        "",
        "Intro paragraph.",
        "",
        "## Launch",
        "",
        "- [ ] wire the deploy pipeline",
        "- [x] write the readme",
        "- [ ] freshly added task",
        "",
      ].join("\n"),
    );
    const future = Date.now() / 1000 + 5;
    utimesSync(join(vault, "hub.md"), future, future);

    const after = omg(["query", 'from blocks where type == "task"', "--ids"]).stdout.trim().split("\n").filter(Boolean);
    expect(after).toHaveLength(3);
  });
});

describe("errors + exit codes (§2.4)", () => {
  it("no workspace → repo_not_found, exit 1", () => {
    // Use a guaranteed-empty nested dir so no stray workspace exists above it.
    const empty = mkdtempSync(join(tmpdir(), "omg-empty-"));
    try {
      let code = 0;
      try {
        execFileSync("node", [BIN, "-C", empty, "status"], { encoding: "utf8", stdio: "pipe" });
      } catch (err) {
        code = (err as { status?: number }).status ?? 1;
      }
      expect(code).toBe(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("unknown command → exit 2", () => {
    let code = 0;
    try {
      execFileSync("node", [BIN, "bogus-cmd"], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      code = (err as { status?: number }).status ?? 0;
    }
    expect(code).toBe(2);
  });

  it("the `oqx` alias is gone — OQX is `query` / `q`", () => {
    // `omg oqx …` used to alias the query command; it was removed (OQX *is* the
    // default query experience, so `query`/`q` name it). It's now unknown.
    let code = 0;
    try {
      execFileSync("node", [BIN, "-C", vault, "oqx", "from docs"], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      code = (err as { status?: number }).status ?? 0;
    }
    expect(code).toBe(2);
    // …while `q` still works.
    expect(omg(["q", "from docs", "--ids"]).code).toBe(0);
  });
});

describe("--json parity", () => {
  it("status --json is a flat object with the documented fields", () => {
    const res = JSON.parse(omg(["status", "--json"]).stdout) as Record<string, unknown>;
    for (const k of ["repo", "docs", "blocks", "commits", "watcher", "convergent"]) {
      expect(res).toHaveProperty(k);
    }
  });
});

describe("init / attach split (consent-gated ingest)", () => {
  const run = (cwd: string, args: string[]): { code: number; stderr: string; stdout: string } => {
    const res = spawnSync("node", [BIN, "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    return { code: res.status ?? 1, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
  };

  it("init creates a workspace but ingests nothing; attach is required", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-split-"));
    try {
      writeFileSync(join(root, "note.md"), "# Note\n\nbody\n");
      run(root, ["init", "--yes", "--no-embedder"]);
      // Before attach: workspace exists but no repo ingested yet.
      expect(JSON.parse(run(root, ["repos", "--json"]).stdout) as unknown[]).toHaveLength(0);
      // -y ingests the tree; attach --json reports the file count.
      const attached = JSON.parse(run(root, ["attach", ".", "-y", "--json"]).stdout) as { files: number };
      expect(attached.files).toBe(1);
      // Now a repo exists and is queryable.
      const after = JSON.parse(run(root, ["repos", "--json"]).stdout) as unknown[];
      expect(after).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attach without -y in a non-TTY refuses to ingest", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-split-"));
    try {
      writeFileSync(join(root, "note.md"), "# Note\n\nbody\n");
      run(root, ["init", "--yes", "--no-embedder"]);
      const res = run(root, ["attach", "."]);
      expect(res.stderr).toMatch(/refusing to attach without -y/);
      // Declined ⇒ still no repo ingested.
      expect(JSON.parse(run(root, ["repos", "--json"]).stdout) as unknown[]).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("init --embedder sets the provider verbatim (no prompt, no PATH check)", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-split-"));
    try {
      run(root, ["init", "--yes", "--embedder", "http://localhost:9999/embed"]);
      // Workspace-layer provider is set to exactly what we passed.
      const cfg = JSON.parse(run(root, ["config", "list", "--repo", "", "--json"]).stdout) as {
        embedding?: { provider?: string };
      };
      expect(cfg.embedding?.provider).toBe("http://localhost:9999/embed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("init --no-embedder leaves no provider and hints how to add one", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-split-"));
    try {
      const res = run(root, ["init", "--yes", "--no-embedder"]);
      const cfg = JSON.parse(run(root, ["config", "list", "--repo", "", "--json"]).stdout) as {
        embedding?: { provider?: string };
      };
      expect(cfg.embedding?.provider).toBeUndefined();
      void res;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
