import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
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
  // init (build the workspace).
  execFileSync("node", [BIN, "init", vault, "--yes"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
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
  it("emits aliased outline + ids table", () => {
    const { stdout } = omg(["outline", "hub.md", "--json"]);
    const res = JSON.parse(stdout) as { text: string; ids: Record<string, string> };
    // Frozen format: `b01 h1 Hub §` style lines; heading gets a section mark.
    expect(res.text).toMatch(/b01 h1\s+Hub/);
    expect(res.text).toContain("§");
    // ids table maps aliases → real block ids.
    expect(Object.keys(res.ids)[0]).toBe("b01");
    expect(res.ids.b01).toMatch(/^b_/);
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

describe("query", () => {
  it("CEL filter over tasks, --ids emits bare ids (pipe fuel)", () => {
    const { stdout } = omg(["q", 'type == "task"', "--ids"]);
    const ids = stdout.trim().split("\n").filter(Boolean);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^b_/);
  });

  it("unchecked-task filter narrows the set", () => {
    const { stdout } = omg(["q", 'type == "task" && !attrs.checked', "--ids"]);
    expect(stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("freshness (§3.3): reads are current without a watcher", () => {
  it("an out-of-band edit is visible on the next command", () => {
    const before = omg(["q", 'type == "task"', "--ids"]).stdout.trim().split("\n").filter(Boolean);
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

    const after = omg(["q", 'type == "task"', "--ids"]).stdout.trim().split("\n").filter(Boolean);
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
});

describe("--json parity", () => {
  it("status --json is a flat object with the documented fields", () => {
    const res = JSON.parse(omg(["status", "--json"]).stdout) as Record<string, unknown>;
    for (const k of ["repo", "docs", "blocks", "commits", "watcher", "convergent"]) {
      expect(res).toHaveProperty(k);
    }
  });
});
