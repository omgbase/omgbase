import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CLI-B write-surface acceptance (11 §6, §7 gate). Spawns the built binary
// against a fixture vault and asserts resulting commits (C2/C5/C6), plan-by-
// default (C6), the fence-authoring loop (C7), and doc-level ops.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;

function omg(args: string[], input?: string): string {
  return execFileSync("node", [BIN, "-C", vault, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...(input !== undefined ? { input } : {}),
  });
}
function omgFails(args: string[]): number {
  try {
    execFileSync("node", [BIN, "-C", vault, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-write-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    join(vault, "hub.md"),
    ["# Hub", "", "See [old](old.md).", "", "## Launch", "", "- [ ] wire deploy", "- [ ] add tests", "- [x] write readme", ""].join("\n"),
  );
  writeFileSync(join(vault, "old.md"), "# Old\n\ncontent\n");
  execFileSync("node", [BIN, "init", vault, "--yes", "--no-embedder"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  execFileSync("node", [BIN, "-C", vault, "attach", ".", "-y"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("C2 — complete unchecked tasks via pipe (resulting commit)", () => {
  it("done - consumes ids from stdin and checks the boxes on disk", () => {
    const ids = omg(["oqx", 'from blocks where type == "task" && !attrs.checked', "--ids"]).trim();
    expect(ids.split("\n").filter(Boolean)).toHaveLength(2);
    omg(["done", "-"], ids + "\n");
    const after = omg(["oqx", 'from blocks where type == "task" && !attrs.checked', "--ids"]).trim();
    expect(after).toBe("");
    // and it's persisted in the file
    expect(readFileSync(join(vault, "hub.md"), "utf8")).not.toContain("- [ ] wire deploy");
  });
});

describe("insert / update / dry-run", () => {
  it("append adds a task under a heading and persists", () => {
    const heading = omg(["find", "Launch", "-1"]).trim();
    omg(["append", heading, "-m", "- [ ] a brand new task"]);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toContain("a brand new task");
  });

  it("--dry-run changes nothing on disk", () => {
    const before = readFileSync(join(vault, "hub.md"), "utf8");
    const heading = omg(["find", "Launch", "-1"]).trim();
    omg(["--dry-run", "append", heading, "-m", "- [ ] should not persist"]);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toBe(before);
  });

  it("update replaces a block's markdown (auto-pinned CAS)", () => {
    const id = omg(["find", "wire deploy", "-1"]).trim();
    omg(["update", id, "-m", "- [ ] wire the deploy pipeline properly"]);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toContain("wire the deploy pipeline properly");
  });
});

describe("C6 — retarget (plan-by-default, then --apply)", () => {
  it("plan prints a diff and commits nothing; --apply rewrites the link", () => {
    const before = readFileSync(join(vault, "hub.md"), "utf8");
    const plan = omg(["retarget", "old.md", "new.md"]);
    // plan output is on stdout (the block id + diff lines)
    expect(plan).toContain("old.md");
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toBe(before); // nothing committed

    omg(["retarget", "old.md", "new.md", "--apply"]);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toContain("[old](new.md)");
  });
});

describe("C7 — fence authoring (run, inert)", () => {
  it("evaluates an omg fence and does not write anything", () => {
    writeFileSync(
      join(vault, "q.md"),
      ["# Q", "", "```omg", 'from blocks where type == "task"', "```", ""].join("\n"),
    );
    // freshness sweep picks up the new file on the next command
    const out = omg(["run", "q.md", "--ids"]).trim().split("\n").filter(Boolean);
    expect(out.length).toBe(3); // three tasks in hub.md
    // fence stayed inert: the code_fence block is still just a fence
    const fenceQuery = omg(["oqx", 'from blocks where type == "code_fence"', "--ids"]).trim();
    expect(fenceQuery.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("doc-level: new / meta / mv / rm --doc", () => {
  it("new creates a doc with frontmatter; meta patches it; mv renames; rm --doc deletes", () => {
    omg(["new", "notes/fresh.md", "-f", "-"], "---\ntitle: Fresh\n---\n# Fresh\n\nbody\n");
    expect(existsSync(join(vault, "notes/fresh.md"))).toBe(true);

    omg(["meta", "notes/fresh.md", "--set", "status=active", "--set", "priority=3"]);
    const meta = JSON.parse(omg(["show", "notes/fresh.md", "--json"])) as { properties: Record<string, unknown> };
    expect(meta.properties.status).toBe("active");
    expect(meta.properties.priority).toBe(3); // YAML scalar → number

    omg(["mv", "notes/fresh.md", "archive/fresh.md"]);
    expect(existsSync(join(vault, "archive/fresh.md"))).toBe(true);
    expect(existsSync(join(vault, "notes/fresh.md"))).toBe(false);

    omg(["rm", "--doc", "archive/fresh.md"]);
    expect(existsSync(join(vault, "archive/fresh.md"))).toBe(false);
  });
});

describe("update — whole-document reconciliation", () => {
  it("preserves the untouched paragraph's id across a whole-doc update", () => {
    const doc = "note.md";
    omg(["new", doc, "-f", "-"], "# Topic\n\nFirst paragraph, long enough to reconcile across an edit here.\n\nKept paragraph that remains untouched by this whole update.\n");
    const keep = 'from blocks where text == "Kept paragraph that remains untouched by this whole update."';
    const before = omg(["oqx", keep, "--ids"]).trim();
    expect(before).toMatch(/^b_/);
    omg(["update", doc, "-f", "-"], "# Topic\n\nFirst paragraph, now edited a bit but still recognizable here.\n\nKept paragraph that remains untouched by this whole update.\n");
    expect(readFileSync(join(vault, doc), "utf8")).toContain("now edited a bit");
    expect(omg(["oqx", keep, "--ids"]).trim()).toBe(before);
  });

  it("--plan shows the opset and writes nothing", () => {
    const doc = "note2.md";
    omg(["new", doc, "-f", "-"], "# T\n\nParagraph one that is sufficiently long to reconcile here.\n");
    const before = readFileSync(join(vault, doc), "utf8");
    const out = omg(["update", doc, "--plan", "-f", "-"], "# T\n\nParagraph one that is sufficiently long to reconcile now.\n");
    expect(out).toMatch(/preserved:|UPDATE|INSERT/);
    expect(readFileSync(join(vault, doc), "utf8")).toBe(before);
  });

  it("dispatches a b_ target to a block replace (polymorphic target)", () => {
    const id = omg(["oqx", 'from blocks where type == "task" && !attrs.checked', "--ids"]).trim().split("\n")[0]!;
    omg(["update", id, "-m", "- [ ] wire deploy pipeline"]);
    expect(readFileSync(join(vault, "hub.md"), "utf8")).toContain("wire deploy pipeline");
  });
});

describe("doctor", () => {
  it("passes on a healthy vault (exit 0)", () => {
    expect(omgFails(["doctor"])).toBe(0);
  });
});

describe("traversal (OQX follow doc.out)", () => {
  it("walks the citation graph from a seed doc to its linked doc", () => {
    // hub.md links to old.md — `follow doc.out` reaches it across the edge graph.
    const res = JSON.parse(omg(["oqx", 'from docs where $path == "hub.md" follow doc.out', "--json"])) as {
      hits: { path: string }[];
    };
    expect(res.hits.map((h) => h.path)).toContain("old.md");
  });
});
