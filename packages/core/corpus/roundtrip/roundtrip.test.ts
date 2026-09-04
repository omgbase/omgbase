import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTree, assertFullCoverage } from "../../src/core/parse/tree.js";
import { render } from "../../src/core/parse/render.js";

const CORPUS_DIR = fileURLToPath(new URL(".", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = walk(CORPUS_DIR);

// Stage 0 exit gate (03 §2.4): 100% byte-identity across the corpus.
describe("round-trip corpus — Stage 0 exit gate", () => {
  it("has a populated corpus (>= 50 files)", () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it.each(files.map((f) => [relative(CORPUS_DIR, f), f] as const))(
    "%s round-trips byte-identically",
    (_name, path) => {
      const src = readFileSync(path, "utf8");
      const tree = parseTree(src);
      expect(assertFullCoverage(tree)).toBe(true);
      expect(render(tree)).toBe(src);
    },
  );
});
