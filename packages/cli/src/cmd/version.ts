import { parseArgs } from "node:util";
import { versionInfo, type VersionInfo } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK, emitMachine, renderHelp } from "../output.js";
import { hostInfo } from "../build.js";
import { remoteCall } from "./_remote.js";

// `omg version` (spec/cli §6, 1.1): the surface's `version` tool, rendered.
// Which engine and which component versions a host or a shell is talking to —
// with `--server` it is the REMOTE engine's answer, which is exactly how you
// tell a TypeScript `omg mcp` from a Rust `omgbase mcp`. Needs no repo; the
// workspace is opened only for `schema` (`—` without one). `--version` (§2.5)
// stays the one-line form.

async function runVersion(cli: Cli, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  if (values.help) {
    return renderHelp(cli, {
      name: "version",
      summary: "Which engine and which versions: the binary, its components, the specs it implements, the schema, MCP protocol, runtime, build",
      usage: "version [--json]",
      options: [["--json", "the `version` tool result verbatim"]],
      notes: ["with --server, the remote engine's answer (typescript or rust)"],
    });
  }

  let info: VersionInfo;
  if (cli.flags.server !== undefined) {
    info = await remoteCall<VersionInfo>(cli, "version", {});
  } else {
    // `schema` is the open database's user_version; without a workspace the
    // command still answers (spec/cli §3.7: version ∈ NO_WORKSPACE_OK).
    let store = null;
    try {
      store = cli.workspace().store;
    } catch {
      store = null;
    }
    info = versionInfo(store, hostInfo());
  }
  cli.capture?.(info);
  if (cli.flags.mode !== "human") return emitMachine(cli, info);

  const { io, style } = cli;
  const dash = "—";
  const keys = ["engine", "version", "specs", "schema", "mcp", "runtime", "commit", "built"];
  const width = Math.max(...keys.map((k) => k.length));
  const line = (key: string, value: string | number | null): void => {
    io.out(`${style.dim(key.padEnd(width))}  ${value === null ? style.dim(dash) : String(value)}`);
  };
  line("engine", info.engine);
  line("version", info.version);
  const names = Object.keys(info.components);
  const nameWidth = Math.max(0, ...names.map((n) => n.length));
  for (const name of names) io.out(`  ${style.accent(name.padEnd(nameWidth))}  ${info.components[name]}`);
  line("specs", Object.entries(info.specs).map(([k, v]) => `${k} ${v}`).join(" · "));
  line("schema", info.schema);
  line("mcp", info.mcp.sdk !== undefined ? `${info.mcp.protocol} (sdk ${info.mcp.sdk})` : info.mcp.protocol);
  line("runtime", info.runtime);
  line("commit", info.commit);
  line("built", info.built);
  return EXIT_OK;
}

export const cmdVersion: Command = {
  name: "version",
  summary: "Which engine and which versions (binary, components, specs, schema, MCP, runtime, build)",
  run: (cli, a) => runVersion(cli, a),
};
