#!/usr/bin/env node
// The build's last step: `tsc` writes `dist/src/bin.js` with the `#!/usr/bin/env
// node` shebang but a plain 0644 mode, and the engine spawns `embedding.provider`
// directly — so `omg init --embedder <path>/dist/src/bin.js` on a monorepo build
// died with `spawn … EACCES` until the bit was set by hand. `npm install` sets the
// bit on a published `bin` entry itself; this covers the checkout.
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Set the executable bits (0o755) on `path`; returns the new mode's permission bits. Throws when the file is missing. */
export function markExecutable(path: string): number {
  if (!existsSync(path)) throw new Error(`markExecutable: ${path} does not exist (run tsc first)`);
  chmodSync(path, 0o755);
  return statSync(path).mode & 0o777;
}

/** True when the file starts with a `#!` line — the only files worth marking. */
export function hasShebang(path: string): boolean {
  return readFileSync(path, "utf8").startsWith("#!");
}

/** The built CLI entry relative to this file: `dist/src/postbuild.js` → `dist/src/bin.js`. */
export const BIN_JS = resolve(fileURLToPath(new URL(".", import.meta.url)), "bin.js");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = markExecutable(BIN_JS);
  process.stderr.write(`[omgbase-embedder] ${BIN_JS} mode ${mode.toString(8)}\n`);
}
