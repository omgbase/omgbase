import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Integration suite for `omg shell` (11 shell). Spawns the built binary in
// piped-script mode (stdin is not a TTY → one command per line) against a
// fixture vault and asserts the session-binding behaviors: @1 frames, @_,
// named `let` bindings, [i]/.field addressing, and substitution into commands.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;

/** Feed a shell script to `omg shell` and capture stdout/stderr/exit code. */
function shell(script: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [BIN, "-C", vault, "shell"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-shell-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    join(vault, "hub.md"),
    [
      "---",
      "title: Hub",
      "---",
      "# Hub",
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
  execFileSync("node", [BIN, "init", vault, "--yes", "--no-embedder"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  execFileSync("node", [BIN, "-C", vault, "attach", ".", "-y"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("@N frame + show", () => {
  it("resolves @1 to the first row of the last displayed collection", () => {
    const { stdout, code } = shell(
      ['query \'from blocks where type == "task"\'', "show @1", "exit"].join("\n"),
    );
    expect(code).toBe(0);
    // show renders the block card, which prints the task's text.
    expect(stdout).toMatch(/wire the deploy pipeline|write the readme/);
  });
});

describe("named bindings via @name =", () => {
  it("binds a query result and dereferences a row with @name[i]", () => {
    const { stdout, code } = shell(
      [
        "@tasks = query 'from blocks where type == \"task\"'",
        "bindings",
        "cat @tasks[1]",
        "exit",
      ].join("\n"),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("@tasks"); // bindings listing
    // cat of the first task block prints its raw markdown line.
    expect(stdout).toMatch(/- \[[ x]\] (wire the deploy pipeline|write the readme)/);
  });

  it("binds from a bare @ref snapshot", () => {
    const { stdout, code } = shell(
      [
        "query 'from blocks where type == \"task\"'",
        "@first = @1",
        "cat @first",
        "exit",
      ].join("\n"),
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/- \[[ x]\]/);
  });
});

describe("node-id substitution (from nodes hits are actionable)", () => {
  it("cat @1 resolves a section node to its heading block", () => {
    const { stdout, code } = shell(
      [
        'query \'from nodes where kind == "md:section" && name == "Launch"\'',
        "cat @1",
        "exit",
      ].join("\n"),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("## Launch");
  });
});

describe("@_ previous result and .field", () => {
  it("reads a field off the previous result", () => {
    const { stdout, code } = shell(["show hub.md", "@_.path", "exit"].join("\n"));
    expect(code).toBe(0);
    expect(stdout).toContain("hub.md");
  });
});

describe("substitution drives a mutation", () => {
  it("done @1 completes the task selected from a query frame", () => {
    const { stdout, code } = shell(
      [
        "query 'from blocks where type == \"task\" && !attrs.checked'",
        "done @1",
        "exit",
      ].join("\n"),
    );
    expect(code).toBe(0);
    // done prints the affected id(s) to stdout.
    expect(stdout).toMatch(/b_[0-9a-z]+/);
    // and the task is now checked.
    const after = shell(['query \'from blocks where type == "task" && attrs.checked\' --ids', "exit"].join("\n"));
    expect(after.stdout.match(/b_[0-9a-z]+/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("frame semantics", () => {
  it("bare @_ inspects a collection result and lists it as the frame (no coercion error)", () => {
    // Regression guard: resolving @_ must not eagerly coerce the collection.
    const { stdout, code } = shell(
      ["query 'from blocks where type == \"task\"'", "@_", "exit"].join("\n"),
    );
    expect(code).toBe(0);
    // Inspection prints numbered selectors for the collection.
    expect(stdout).toMatch(/\[1\]\s+b_[0-9a-z]+/);
    expect(stdout).toMatch(/\[2\]\s+b_[0-9a-z]+/);
  });

  it("a card command (show) leaves the numbered frame intact", () => {
    // query sets frame → show (single entity) must NOT replace it → @1 still
    // resolves the original query row.
    const { stdout, code } = shell(
      [
        "query 'from blocks where type == \"task\"'",
        "show @1", // card; frame must survive
        "cat @1", // still the first task's bytes
        "exit",
      ].join("\n"),
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/- \[[ x]\] (wire the deploy pipeline|write the readme)/);
  });

  it("a binding assignment runs quietly and does not clobber the numbered frame", () => {
    const { stdout, code } = shell(
      [
        "query 'from blocks where type == \"task\"'", // frame = tasks
        "@d = find deploy", // quiet; must not become the frame
        "cat @1", // still the first task
        "exit",
      ].join("\n"),
    );
    expect(code).toBe(0);
    // assignment is quiet: the find hits are not printed as data.
    expect(stdout).not.toMatch(/#task\[/);
    expect(stdout).toMatch(/- \[[ x]\]/);
  });

  it("a --json command line still populates the frame", () => {
    const { stdout, code } = shell(
      ["query 'from blocks where type == \"task\"' --json", "cat @1", "exit"].join("\n"),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('"hits"'); // the verbatim json result
    expect(stdout).toMatch(/- \[[ x]\]/); // @1 still resolved a row
  });
});

describe("bindings management", () => {
  it("bindings is empty until an assignment, and unset drops a binding", () => {
    const { stdout, stderr, code } = shell(
      [
        "bindings",
        "@x = show hub.md",
        "bindings",
        "unset x",
        "bindings",
        "exit",
      ].join("\n"),
    );
    expect(code).toBe(0);
    // Two "no bindings" notices (before the assignment, after unset) on stderr; one listing
    // of @x on stdout in between.
    expect(stderr.match(/no bindings/g)?.length).toBe(2);
    expect(stdout).toContain("@x");
  });

  it("reads a field off a named binding", () => {
    const { stdout, code } = shell(
      ["@d = show hub.md", "@d.path", "exit"].join("\n"),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("hub.md");
  });
});

describe("errors", () => {
  it("an out-of-range @N is a usage error (exit 2)", () => {
    const { code, stderr } = shell(["query 'from blocks where type == \"task\"'", "show @9"].join("\n"));
    expect(code).toBe(2);
    expect(stderr).toMatch(/out of range/);
  });

  it("passing a bare collection binding as an argument is refused", () => {
    const { code, stderr } = shell(
      [
        "@tasks = query 'from blocks where type == \"task\"'",
        "show @tasks", // a collection can't be one argument
      ].join("\n"),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/collection/);
  });

  it("an unknown binding is a usage error", () => {
    const { code, stderr } = shell(["show @nope"].join("\n"));
    expect(code).toBe(2);
    expect(stderr).toMatch(/no binding @nope/);
  });

  it("an unterminated quote is a usage error, and the session survives it", () => {
    const { stdout, code } = shell(["query 'oops", "ls", "exit"].join("\n"));
    // last non-zero code is the tokenize usage error, but ls still ran.
    expect(code).toBe(2);
    expect(stdout).toContain("hub.md");
  });

  it("comments and blank lines are ignored", () => {
    const { code } = shell(["# just a comment", "", "exit"].join("\n"));
    expect(code).toBe(0);
  });

  // `--prompt` makes piped mode emit a prompt (no trailing newline) on stdout
  // before each line, so a driver (e.g. recital's prompt mode) can sync on its
  // reappearance. Two commands ⇒ an initial prompt plus one after each.
  it("--prompt emits the prompt before each line, ordered with output", () => {
    const r = spawnSync("node", [BIN, "-C", vault, "shell", "--prompt", "omg> "], {
      input: ["query 'from blocks where type == \"task\"'", "bindings", "exit"].join("\n"),
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = r.stdout ?? "";
    // Prompt up front, and it precedes the command's row output (not the reverse).
    expect(stdout).toMatch(/^omg> b_[a-z0-9]+ {2}hub\.md/);
    // One prompt initially, then one after each of the two commands.
    expect((stdout.match(/omg> /g) ?? []).length).toBe(3);
  });

  it("the prompt can also come from $OMG_SHELL_PROMPT (no --prompt flag)", () => {
    const r = spawnSync("node", [BIN, "-C", vault, "shell"], {
      input: ["query 'from blocks where type == \"task\"'", "exit"].join("\n"),
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", OMG_SHELL_PROMPT: "omg> " },
    });
    const stdout = r.stdout ?? "";
    expect(stdout).toMatch(/^omg> b_[a-z0-9]+ {2}hub\.md/);
    // initial prompt + one after the query (exit ends the session, no prompt).
    expect((stdout.match(/omg> /g) ?? []).length).toBe(2);
  });
});
