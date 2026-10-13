#!/usr/bin/env node
// The CLI. See `webdevproxy --help` (src/args.mjs USAGE) and the README.
import { USAGE, parseArgs, validateArgs } from "../src/args.mjs";
import { logout, startProxy } from "../src/proxy.mjs";
import { startPrompt } from "../src/prompt.mjs";

const o = parseArgs();
if (o.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (o.logout) {
  logout(o);
  process.exit(0);
}
const problem = validateArgs(o);
if (problem) {
  console.error(`webdevproxy: ${problem}\n\n${USAGE}`);
  process.exit(2);
}

let proxy;
try {
  proxy = await startProxy(o);
} catch (e) {
  console.error(`webdevproxy: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
// Remote mode on a terminal: `a` / `l` / `q` + Enter (src/prompt.mjs). Never when stdin is a pipe (CI, a parent script).
if (proxy.remote && process.stdin.isTTY) startPrompt({ remote: proxy.remote, proxy, log: (m) => console.error(`[webdevproxy] ${m}`) });
const stop = async () => { await proxy.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
