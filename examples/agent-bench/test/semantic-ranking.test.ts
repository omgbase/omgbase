// Opt-in: the three semantic-only tasks under a real embedder. Builds ONE embedded
// timeline workspace (`omg init --embedder`, drained — ~2 min with gte-base cached)
// and asserts, for each plant, that the target is the TOP `semantic()` hit at the
// block grain — the hit the task's solution reads — and prints every decoy's rank at
// both grains for the task notes. Runs only with AGENT_BENCH_EMBEDDER=<cmd|url>, e.g.
//   AGENT_BENCH_EMBEDDER=packages/embedder/dist/src/bin.js pnpm --filter agent-bench exec vitest run test/semantic-ranking.test.ts
// (a bare .js path is run through node — resolveEmbedder).
import { afterAll, describe, expect, it } from "vitest";
import { SEMANTIC_PLANTS } from "../src/corpus.ts";
import { OmgServer } from "../src/mcp.ts";
import { createWorkspace, embedWorkspace, resolveEmbedder, type Workspace } from "../src/workspace.ts";

const EMBEDDER = process.env.AGENT_BENCH_EMBEDDER;
const suite = EMBEDDER ? describe : describe.skip;

suite("the semantic plants rank first under the configured embedder", () => {
  let ws: Workspace | undefined;
  let server: OmgServer | undefined;
  afterAll(async () => {
    await server?.close();
    ws?.cleanup();
  });

  async function ranked(grain: "blocks" | "docs", question: string): Promise<{ _path: string; s: number }[]> {
    const q = JSON.stringify(question);
    const r = await server!.call("query", { query: `select _path, s: semantic(${q}) from ${grain} where semantic(${q}) != null order by semantic(${q}) desc limit 200`, limit: 200 });
    if (!r.ok) throw new Error(JSON.stringify(r.result));
    return (r.result as { hits: { _path: string; s: number }[] }).hits;
  }

  it("builds and drains one embedded timeline workspace", () => {
    ws = createWorkspace({ corpus: "timeline", embedder: resolveEmbedder(EMBEDDER!, process.cwd()) });
    const status = embedWorkspace(ws);
    expect(status.queued).toBe(0);
  }, 600_000);

  for (const plant of SEMANTIC_PLANTS) {
    it(`${plant.task}: the target is the top block hit for ${JSON.stringify(plant.question)}; the decoys rank below it`, async () => {
      server ??= await OmgServer.spawn({ workspace: ws!, profile: "full" });
      const rank = (hits: { _path: string; s: number }[], path: string) => {
        const i = hits.findIndex((h) => h._path === path);
        return i < 0 ? ">200" : `${i + 1} (${hits[i]!.s.toFixed(4)})`;
      };
      const blocks = await ranked("blocks", plant.question);
      const docs = await ranked("docs", plant.question);
      expect(blocks[0]!._path).toBe(plant.target.path);
      for (const d of plant.decoys) expect(blocks.findIndex((h) => h._path === d.path)).toBeGreaterThan(0);
      // the solution's exact query: the top hit is the target
      const sol = await server.call("query", { query: `blocks { select _path, _text order by semantic(${JSON.stringify(plant.question)}) desc limit 5 }` });
      expect(sol.ok).toBe(true);
      expect((sol.result as { hits: { _path: string }[] }).hits[0]!._path).toBe(plant.target.path);
      console.log(`${plant.task} blocks: target ${rank(blocks, plant.target.path)}; ${plant.decoys.map((d) => `${d.path} ${rank(blocks, d.path)}`).join("; ")}`);
      console.log(`${plant.task} docs:   target ${rank(docs, plant.target.path)}; ${plant.decoys.map((d) => `${d.path} ${rank(docs, d.path)}`).join("; ")}`);
    }, 120_000);
  }
});
