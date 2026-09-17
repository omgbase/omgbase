// Drop-in replacements for node:child_process' SYNCHRONOUS spawns, with a
// default timeout (+ SIGKILL). The CLI integration suites drive the built `omg`
// binary via execFileSync/spawnSync, which block the vitest worker's event loop
// until the child's stdio reaches EOF — so if a child (or a grandchild it
// spawned, e.g. an embedder or the fs-adapter) ever wedges, vitest's own
// per-test timeout can't fire (its timer is on the blocked thread) and the whole
// run hangs indefinitely. A hard timeout turns that into a loud failure instead.
//
// (Monkeypatching node:child_process from a setup file does NOT work: the suites
// use `import { execFileSync }` named bindings, which snapshot the CJS export and
// don't see a later reassignment. Importing these wrappers is what actually
// applies the timeout.)
import { execFileSync as _execFileSync, spawnSync as _spawnSync } from "node:child_process";
import type {
  ExecFileSyncOptionsWithStringEncoding,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";

const TIMEOUT_MS = 60_000;

export function execFileSync(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string {
  return _execFileSync(file, args, { timeout: TIMEOUT_MS, killSignal: "SIGKILL", ...options });
}

export function spawnSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  return _spawnSync(command, args, { timeout: TIMEOUT_MS, killSignal: "SIGKILL", ...options });
}
