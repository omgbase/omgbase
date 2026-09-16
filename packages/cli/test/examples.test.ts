import { describeMarkdown } from "@simplebrains/recital/vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Executable documentation. Every Markdown file under the repo-root `examples/`
// directory is a recital session: a transcript that reads like a real terminal
// and is verified command-by-command against the built `omg` binary. The prose
// teaches the CLI; recital keeps the prose honest.
//
// Each example is fully self-contained: its `<!-- recital … -->` setup finds the
// repo (git rev-parse), puts the freshly built CLI on PATH, seeds a throwaway
// temp workspace with the alchemy corpus, and tears it down after — so there is
// nothing to wire up here. The one prerequisite is a prior `pnpm build` (the
// setup shims `packages/cli/dist/src/main.js`, exactly as the sibling spawn-based
// suites depend on the built binary). describeMarkdown registers a `describe`
// per file and a `test` per runnable block.

// The walkthroughs live directly under examples/ and in the examples/oqx-tutorial/
// subdirectory. The shared `include` fragments under examples/_fragments/ are
// spliced into them at parse time and are not standalone documents, so match
// those two directories explicitly rather than a recursive `**` that would also
// pick up _fragments/.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const EX = resolve(HERE, "..", "..", "..", "examples");

describeMarkdown([resolve(EX, "*.md"), resolve(EX, "oqx-tutorial", "*.md")]);
