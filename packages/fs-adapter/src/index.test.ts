import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAdapter } from "./index.js";

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
    const fs = new FsAdapter({ root, debounceMs: 50 });
    const batches: string[][] = [];
    const sub = fs.watch((paths) => batches.push(paths));
    await new Promise((r) => setTimeout(r, 200)); // let chokidar's initial scan settle
    batches.length = 0; // discard spurious startup events (macOS FSEvents re-reports existing files)
    writeFileSync(join(root, "c.md"), "# C\n");
    writeFileSync(join(root, "a.md"), "# A\n\nchanged\n");
    await new Promise((r) => setTimeout(r, 300));
    await sub.stop();
    expect(batches.length).toBe(1); // coalesced
    expect(batches[0]!.sort()).toEqual(["a.md", "c.md"]);
  });
});
