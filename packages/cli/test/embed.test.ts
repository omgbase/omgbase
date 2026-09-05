import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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
  execFileSync("node", [BIN, "init", vault, "--yes"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("embed with no provider configured", () => {
  it("status reports no provider (exit 0)", () => {
    const res = JSON.parse(omg(["embed", "status", "--json"])) as { provider: string | null };
    expect(res.provider).toBeNull();
  });

  it("query --semantic without a provider → semantic_unavailable, exit 1", () => {
    const { code, stderr } = omgFails(["q", "--semantic", "durability", "--json"]);
    expect(code).toBe(1);
    expect(stderr).toContain("semantic_unavailable");
  });
});

describe("embed via external stdio provider (fake embedder)", () => {
  beforeEach(() => {
    omg(["config", "set", "embedding.provider", `node ${FAKE}`]);
  });

  it("status → drain → status reflects the queue draining", () => {
    const before = JSON.parse(omg(["embed", "status", "--json"])) as { provider: string; queued: number; embeddable: number };
    expect(before.embeddable).toBeGreaterThanOrEqual(2);
    expect(before.queued).toBe(before.embeddable);

    const drained = JSON.parse(omg(["embed", "drain", "--json"])) as { embedded: number };
    expect(drained.embedded).toBe(before.embeddable);

    const after = JSON.parse(omg(["embed", "status", "--json"])) as { queued: number };
    expect(after.queued).toBe(0);
  });

  it("query --semantic returns hybrid hits after draining", () => {
    omg(["embed", "drain"]);
    const res = JSON.parse(omg(["q", "--semantic", "database durability and crash safety", "--json"])) as { hits: { path: string }[] };
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("find works with a provider configured (hybrid)", () => {
    omg(["embed", "drain"]);
    const ids = omg(["find", "risotto rice cooking", "-1"]).trim();
    expect(ids).toMatch(/^b_/);
  });
});
