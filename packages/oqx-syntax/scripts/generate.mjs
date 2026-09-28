// Write the highlighting assets (`syntax/*.json`, the VS Code extension under
// `vscode/`) from the built grammars. Runs after `tsc` as part of `pnpm build`;
// `test/assets.test.ts` fails when a checked-in file differs from what this writes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildAssets, renderAsset } = await import(join(ROOT, "dist", "src", "assets.js"));
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

for (const [rel, value] of Object.entries(buildAssets(version))) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  const next = renderAsset(value);
  let prev = null;
  try { prev = readFileSync(path, "utf8"); } catch { /* new file */ }
  if (prev !== next) {
    writeFileSync(path, next);
    console.log(`${prev === null ? "created" : "updated"} ${rel}`);
  }
}
