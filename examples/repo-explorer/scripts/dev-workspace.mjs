#!/usr/bin/env node
// Build the demo's omgbase workspace from the ALCHEMY corpus — the twenty
// interlinked documents every spec fixture and tutorial in this repository
// uses (packages/core/corpus/oqx/fixtures/alchemy) — with the omg CLI from
// packages/cli (run `pnpm build` at the repo root first). The corpus is COPIED
// to <workspace>/alchemy and that copy is the repo's source, so edits made in
// the UI (frontmatter writes through plan/execute) land in the copy, not in
// the checked-in fixtures. Idempotent: an existing workspace is kept unless
// --force (which also resets the copy). Prints the workspace path.
//
//   node scripts/dev-workspace.mjs [--force]
//   env: OMG (path to omg's main.js), REPO_EXPLORER_WORKSPACE (target dir)
//
// (After examples/live-tail/scripts/dev-workspace.mjs; the sample differs.)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, "..");
export const OMG = process.env.OMG ?? resolve(PACKAGE_ROOT, "../../packages/cli/dist/src/main.js");
export const WORKSPACE = process.env.REPO_EXPLORER_WORKSPACE ?? resolve(PACKAGE_ROOT, ".dev-workspace");
/** The corpus the workspace is built from. */
export const CORPUS = resolve(PACKAGE_ROOT, "../../packages/core/corpus/oqx/fixtures/alchemy");
/** The repo slug the copy is attached under. */
export const REPO = "alchemy";

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
  const copy = resolve(WORKSPACE, REPO);
  log(`copy ${CORPUS} → ${copy}`);
  cpSync(CORPUS, copy, { recursive: true });
  log(`omg init ${WORKSPACE}`);
  omg(["init", WORKSPACE, "--yes", "--no-embedder"], PACKAGE_ROOT);
  log(`omg source add ${copy} --repo ${REPO}`);
  omg(["-C", WORKSPACE, "source", "add", copy, "--repo", REPO, "-y"], PACKAGE_ROOT);
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
