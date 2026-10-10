#!/usr/bin/env node
// Build the demo's omgbase workspace from ./sample with the omg CLI from
// packages/cli (run `pnpm build` at the repo root first). The sample is COPIED
// to <workspace>/sample and that copy is the repo's source, so edge edits made
// in the UI (`docs_set_meta`) land in the copy, not in the checked-in sample.
// Idempotent: an existing workspace is kept unless --force (which also resets
// the copy). Prints the workspace path.
//
//   node scripts/dev-workspace.mjs [--force]
//   env: OMG (path to omg's main.js), GRAPH_UI_WORKSPACE (target dir)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, "..");
export const OMG = process.env.OMG ?? resolve(PACKAGE_ROOT, "../../packages/cli/dist/src/main.js");
export const WORKSPACE = process.env.GRAPH_UI_WORKSPACE ?? resolve(PACKAGE_ROOT, ".dev-workspace");
const SAMPLE = resolve(PACKAGE_ROOT, "sample");

function omg(args, cwd) {
  const r = spawnSync(process.execPath, [OMG, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`omg ${args.join(" ")} failed (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  }
  return r.stdout;
}

/** Ensure the workspace exists and is populated; returns its path. */
export function ensureWorkspace({ force = false, log = () => {} } = {}) {
  if (!existsSync(OMG)) {
    throw new Error(`omg is not built at ${OMG} — run \`pnpm build\` at the repository root first`);
  }
  if (existsSync(resolve(WORKSPACE, ".omgbase")) && !force) {
    log(`workspace ok  ${WORKSPACE}`);
    return WORKSPACE;
  }
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  const copy = resolve(WORKSPACE, "sample");
  log(`copy ${SAMPLE} → ${copy}`);
  cpSync(SAMPLE, copy, { recursive: true });
  log(`omg init ${WORKSPACE}`);
  omg(["init", WORKSPACE, "--yes", "--no-embedder"], PACKAGE_ROOT);
  log(`omg source add ${copy} --repo sample`);
  omg(["-C", WORKSPACE, "source", "add", copy, "--repo", "sample", "-y"], PACKAGE_ROOT);
  log(`workspace built  ${WORKSPACE}`);
  return WORKSPACE;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    ensureWorkspace({ force: process.argv.includes("--force"), log: (m) => console.error(m) });
    console.log(WORKSPACE);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
