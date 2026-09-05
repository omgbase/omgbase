import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, RepoSelectionError } from "./workspace.js";
import { attachRepo } from "./attach.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Workspace.find", () => {
  it("walks up to the directory containing .omgbase/", () => {
    dir = mkdtempSync(join(tmpdir(), "omg-ws-"));
    const root = join(dir, "vault");
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(root, ".omgbase"), { recursive: true });

    const ws = Workspace.find(nested);
    expect(ws).not.toBeNull();
    expect(ws!.root).toBe(root);
    ws!.close();
  });

  it("returns null when no workspace exists above", () => {
    dir = mkdtempSync(join(tmpdir(), "omg-ws-"));
    expect(Workspace.find(dir)).toBeNull();
  });
});

describe("Workspace.selectRepo", () => {
  it("returns the single repo when only one exists", () => {
    dir = mkdtempSync(join(tmpdir(), "omg-ws-"));
    const root = join(dir, "vault");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "x.md"), "# X\n");
    const ws = Workspace.open(root);
    attachRepo(ws.store, "vault", root);

    const repo = ws.selectRepo(root);
    expect(repo.slug).toBe("vault");
    ws.close();
  });

  it("selects by containing root_path and errors with candidates when none match", () => {
    dir = mkdtempSync(join(tmpdir(), "omg-ws-"));
    const root = join(dir, "vault");
    const repoA = join(root, "docs");
    const repoB = join(root, "notes");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    writeFileSync(join(repoA, "a.md"), "# A\n");
    writeFileSync(join(repoB, "b.md"), "# B\n");
    const ws = Workspace.open(root);
    attachRepo(ws.store, "docs", repoA);
    attachRepo(ws.store, "notes", repoB);

    // cwd inside repoA → picks docs.
    expect(ws.selectRepo(repoA).slug).toBe("docs");
    // cwd at the workspace root (contains neither repo) → ambiguous.
    try {
      ws.selectRepo(root);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RepoSelectionError);
      expect((err as RepoSelectionError).candidates.sort()).toEqual(["docs", "notes"]);
    }
    ws.close();
  });

  it("throws repo_not_found for an unknown --repo slug", () => {
    dir = mkdtempSync(join(tmpdir(), "omg-ws-"));
    const root = join(dir, "vault");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "x.md"), "# X\n");
    const ws = Workspace.open(root);
    attachRepo(ws.store, "vault", root);

    expect(() => ws.selectRepo(root, "nope")).toThrow(RepoSelectionError);
    ws.close();
  });
});
