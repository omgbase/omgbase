import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { docsRead } from "./document.js";
import { loadMutDoc } from "../../mutate/load.js";
import { renderDoc } from "../../mutate/tree.js";

// Byte-exact round-trip fidelity (01 §2). Every document must reconstruct from
// storage identical to its source bytes — through BOTH the read path (docsRead)
// and the mutate write path (loadMutDoc → renderDoc, the bytes apply() writes to
// disk). These cases previously lost the frontmatter→body separator (normalized
// to \n\n) and re-added a trailing newline; the frontmatter_trivia column and
// the no-fallback trivia load fixed both. ingest.converged now includes a
// storage round-trip, so any regression trips it here.

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

const CASES: Record<string, string> = {
  "frontmatter separator: canonical blank line": "---\na: 1\n---\n\n# H\n\nbody\n",
  "frontmatter separator: single newline": "---\na: 1\n---\n# H\n\nbody\n",
  "frontmatter separator: triple newline": "---\na: 1\n---\n\n\n# H\n\nbody\n",
  "no trailing newline": "# H\n\nbody",
  "frontmatter, no trailing newline": "---\na: 1\n---\n\n# H\n\nbody",
  "trailing blank lines": "# H\n\nbody\n\n\n",
  "block separator: triple newline": "# H\n\n\npara\n",
  "leading blank line, no frontmatter": "\n# H\n\nbody\n",
  "fenced code + table preserved": "# H\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
};

describe("byte-exact round-trip fidelity", () => {
  for (const [name, src] of Object.entries(CASES)) {
    it(`${name} — docsRead + write path + convergence`, () => {
      store = new Store({ path: ":memory:" });
      const repoId = ensureRepo(store, "t", "/tmp");
      const res = ingestFile(store, repoId, "a.md", src);

      // Read path.
      expect(docsRead(store, res.docId)!.content).toBe(src);
      // Write path (the exact bytes apply() renders to disk).
      expect(renderDoc(loadMutDoc(store.db, res.docId)!)).toBe(src);
      // Convergence now asserts the storage round-trip, so it must hold too.
      expect(res.converged).toBe(true);
    });
  }
});
