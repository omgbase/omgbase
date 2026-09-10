import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK } from "../output.js";

// `omg help` / bare invocation / --help. Renders the branded header + the
// command catalog grouped by area. The catalog is data (11 §8); help reads it
// from the registry lazily to avoid an import cycle.

const GROUPS: { title: string; names: string[] }[] = [
  { title: "bootstrap", names: ["init", "attach", "repos"] },
  { title: "orient & read", names: ["status", "ls", "outline", "cat", "show", "find"] },
  { title: "query", names: ["query", "oqx", "run"] },
  { title: "history & graph", names: ["log", "hist", "diff", "links", "graph"] },
  { title: "mutate", names: ["apply", "insert", "update", "edit", "move", "rm", "done", "append", "retarget", "split", "merge"] },
  { title: "documents", names: ["new", "mv", "meta"] },
  { title: "sync & serve", names: ["sync", "watch", "mcp"] },
  { title: "admin", names: ["rebuild-index", "gc", "doctor", "config", "import", "embed"] },
];

async function runHelp(cli: Cli): Promise<number> {
  const { render, style, io } = cli;
  const { COMMANDS } = await import("../commands.js");
  const byName = new Map(COMMANDS.map((c) => [c.name, c]));

  io.out(render.wordmark("Open Markdown Graph Base"));
  io.out(render.rule(40));
  io.out("");
  io.out(`  ${style.dim("usage:")} omgbase ${style.dim("[--json|--jsonl|--ids] [-C dir] [--repo slug]")} <command> ${style.dim("[args]")}`);
  io.out("");

  for (const group of GROUPS) {
    io.out(`  ${style.bold(group.title)}`);
    const rows = group.names
      .map((n) => byName.get(n))
      .filter((c): c is Command => Boolean(c))
      .map((c) => {
        const names = [c.name, ...(c.aliases ?? [])].join(", ");
        return `    ${style.accent(names.padEnd(22))}${style.dim(c.summary)}`;
      });
    for (const r of rows) io.out(r);
    io.out("");
  }
  io.out(`  ${style.dim("run")} omgbase <command> --help ${style.dim("for details")}`);
  return EXIT_OK;
}

export const cmdHelp: Command = {
  name: "help",
  summary: "Show this help",
  listed: false,
  run: (cli) => runHelp(cli),
};
