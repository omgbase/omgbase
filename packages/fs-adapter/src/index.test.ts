import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAdapter, resolveFsAdapterArgv } from "./index.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), "omg-fsadapter-"));
  writeFileSync(join(dir, "a.md"), "# A\n\nalpha\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.md"), "# B\n\nbeta\n");
  writeFileSync(join(dir, "ignore.txt"), "not markdown\n");
  return dir;
}

describe("FsAdapter", () => {
  it("enumerates *.md repo-relative, skipping non-md", () => {
    const fs = new FsAdapter({ root: setup() });
    const paths = fs.enumerate().map((e) => e.path).sort();
    expect(paths).toEqual(["a.md", "sub/b.md"]);
  });

  it("fetch returns content + revision; null for missing", () => {
    const fs = new FsAdapter({ root: setup() });
    const item = fs.fetch("a.md");
    expect(item?.content).toContain("alpha");
    expect(item?.revision).toMatch(/^\d+:\d+$/);
    expect(fs.fetch("nope.md")).toBeNull();
  });

  it("revision changes when content changes", () => {
    const root = setup();
    const fs = new FsAdapter({ root });
    const before = fs.fetch("a.md")!.revision;
    const future = Date.now() / 1000 + 5;
    writeFileSync(join(root, "a.md"), "# A\n\nalpha edited longer now\n");
    utimesSync(join(root, "a.md"), future, future); // bump mtime deterministically
    expect(fs.fetch("a.md")!.revision).not.toBe(before);
  });

  it("write + remove round-trip through the tree", () => {
    const fs = new FsAdapter({ root: setup() });
    fs.write("new/deep.md", "# New\n");
    expect(fs.fetch("new/deep.md")?.content).toBe("# New\n");
    fs.remove("new/deep.md");
    expect(fs.fetch("new/deep.md")).toBeNull();
  });

  it("watch delivers a debounced batch of changed paths", async () => {
    const root = setup();
    const fs = new FsAdapter({ root, debounceMs: 100 }); // wide enough that two back-to-back writes coalesce even on a loaded machine
    const batches: string[][] = [];
    const sub = fs.watch((paths) => batches.push(paths));
    await sub.ready; // chokidar's initial scan has completed (spec/sync §5)
    await new Promise((r) => setTimeout(r, 200)); // let FSEvents settle
    batches.length = 0; // discard spurious startup events (macOS FSEvents re-reports existing files)
    writeFileSync(join(root, "c.md"), "# C\n");
    writeFileSync(join(root, "a.md"), "# A\n\nchanged\n");
    await new Promise((r) => setTimeout(r, 600));
    await sub.stop();
    expect(batches.length).toBe(1); // coalesced
    expect(batches[0]!.sort()).toEqual(["a.md", "c.md"]);
  });

  it("watch reports ready once the initial scan completed, then a change made after it", async () => {
    const root = setup();
    const fs = new FsAdapter({ root, debounceMs: 50 });
    const batches: string[][] = [];
    const sub = fs.watch((paths) => batches.push(paths));
    let readyAt: number | null = null;
    void sub.ready.then(() => { readyAt = Date.now(); });
    await Promise.race([sub.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("ready never resolved")), 5000))]);
    expect(readyAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 150));
    batches.length = 0;
    writeFileSync(join(root, "after-ready.md"), "# after\n");
    await new Promise((r) => setTimeout(r, 500));
    await sub.stop();
    expect(batches.flat()).toContain("after-ready.md");
  });
});

describe("resolveFsAdapterArgv (spec/sync §5, launching the built-in fs adapter)", () => {
  const fallback = { command: "/usr/bin/node", args: ["/pkg/dist/bin.js"] };
  const flags = ["--root", "/vault"];

  it("unset or blank $OMGBASE_FS_ADAPTER runs the host's own launcher, then fixed args, then flags", () => {
    expect(resolveFsAdapterArgv(undefined, fallback, [], flags)).toEqual({ command: "/usr/bin/node", args: ["/pkg/dist/bin.js", "--root", "/vault"] });
    expect(resolveFsAdapterArgv("", fallback, ["--ext", ".md"], flags)).toEqual({ command: "/usr/bin/node", args: ["/pkg/dist/bin.js", "--ext", ".md", "--root", "/vault"] });
    expect(resolveFsAdapterArgv("  \t ", fallback, [], flags)).toEqual({ command: "/usr/bin/node", args: ["/pkg/dist/bin.js", "--root", "/vault"] });
  });

  it("a set value is whitespace-split into command + leading args; the row's args and the flags follow", () => {
    expect(resolveFsAdapterArgv("omgbase-fs-adapter", fallback, [], flags)).toEqual({ command: "omgbase-fs-adapter", args: ["--root", "/vault"] });
    expect(resolveFsAdapterArgv(" cargo  run -p omgbase-fs-adapter --\n", fallback, ["--debounce-ms", "10"], flags)).toEqual({
      command: "cargo",
      args: ["run", "-p", "omgbase-fs-adapter", "--", "--debounce-ms", "10", "--root", "/vault"],
    });
  });
});
