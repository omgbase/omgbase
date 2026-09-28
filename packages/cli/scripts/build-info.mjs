#!/usr/bin/env node
// Writes dist/build-info.json for the `version` tool / `omg version`
// (spec/surface §4: `commit` the build's short git revision — null when this is
// not a git checkout or git fails — and `built` the RFC 3339 build time). Run by
// `pnpm build` after tsc; ships inside the npm tarball with the rest of dist/.
// Plain Node, no dependencies.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(pkgDir, "dist", "build-info.json");

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
} catch {
  commit = null;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ commit, built: new Date().toISOString() }, null, 2) + "\n");
