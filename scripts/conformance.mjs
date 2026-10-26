#!/usr/bin/env node
// `pnpm conformance` — the four-composition conformance matrix (modular-core
// Phase 5, the plan's §6 gate: "four-profile conformance"). Runs every fixture
// suite of the TypeScript reference under each of the plan's compositions —
// `OMGBASE_CAPABILITIES=core | history | semantic | full` — SEQUENTIALLY (the
// CLI and interop runners spawn the built binaries and must not race a build),
// collects each runner's ledger line
//
//   [<suite> spec] composition=<name>: compared=<n> mapped=<n> skipped=<n>
//
// and prints one matrix: suite × composition → passed / mapped / skipped, with
// the vitest pass/fail counts beside it. Exit 1 on any failed test or any
// suite that printed no ledger line (a runner that crashed before its
// `afterAll`). Nothing is regenerated: every runner refuses `*_SPEC_UPDATE`
// under a reduced composition.
//
//   pnpm conformance                              # all eight suites, four compositions
//   pnpm conformance --suites store,surface       # a subset
//   pnpm conformance --compositions core,full
//   pnpm conformance --json <file>                # the matrix as JSON too
//   pnpm conformance --engine rust                # the Rust runners (`cargo test -p <crate> --test <runner> -- --nocapture`)
//
// The Rust pairings of the interop suite need the Rust binary: without one
// (or with `OMGBASE_INTEROP=skip`) they are skipped and counted as such.
// `--engine rust` drives the Rust twin's runners instead — the same ledger line
// (the interop runner prints one per pairing; the cell sums them) and cargo's
// `test result:` summary in vitest's place; it needs `cargo build -p omgbase`
// and, for the interop suite's TypeScript pairings, `pnpm build`.
// Needs `pnpm build` first (the CLI and interop runners spawn `packages/cli/dist`).

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** Every suite: the package that runs it, the vitest file, the ledger tag it prints. */
export const SUITES = {
  store: { pkg: "@omgbase/core", file: "corpus/store/spec.test.ts" },
  mutate: { pkg: "@omgbase/core", file: "corpus/mutate/spec.test.ts" },
  surface: { pkg: "@omgbase/core", file: "corpus/surface/spec.test.ts" },
  graph: { pkg: "@omgbase/core", file: "corpus/graph/spec.test.ts" },
  sync: { pkg: "@omgbase/core", file: "corpus/sync/spec.test.ts" },
  search: { pkg: "@omgbase/core", file: "corpus/search/spec.test.ts" },
  cli: { pkg: "omgbase", file: "corpus/cli/spec.test.ts" },
  interop: { pkg: "@omgbase/core", file: "corpus/surface/interop.test.ts" },
};
export const COMPOSITIONS = ["core", "history", "semantic", "full"];
/** The Rust twin's runners: the crate and the integration test that prints the same ledger line. */
export const RUST_SUITES = {
  store: ["omgbase-store", "spec"], mutate: ["omgbase-mutate", "spec"], surface: ["omgbase-surface", "spec"], graph: ["omgbase-graph", "spec"],
  sync: ["omgbase-sync", "spec"], search: ["omgbase-search", "spec"], cli: ["omgbase", "cli_spec"], interop: ["omgbase", "interop"],
};
export const ENGINES = ["ts", "rust"];

const suites = list(opt("suites", Object.keys(SUITES).join(",")));
const compositions = list(opt("compositions", COMPOSITIONS.join(",")));
const jsonOut = opt("json", null);
const engine = opt("engine", "ts");
if (!ENGINES.includes(engine)) { console.error(`unknown engine ${engine}; the engines are ${ENGINES.join(", ")}`); process.exit(2); }
for (const s of suites) if (!SUITES[s]) { console.error(`unknown suite ${s}; the suites are ${Object.keys(SUITES).join(", ")}`); process.exit(2); }
for (const c of compositions) if (!COMPOSITIONS.includes(c)) { console.error(`unknown composition ${c}; the compositions are ${COMPOSITIONS.join(", ")}`); process.exit(2); }

const PKG_DIR = { "@omgbase/core": join(ROOT, "packages", "core"), omgbase: join(ROOT, "packages", "cli") };
if (!existsSync(join(ROOT, "packages", "cli", "dist", "src", "main.js"))) { console.error("the built CLI is missing — run `pnpm build` first"); process.exit(2); }

/** Parse a runner's ledger line(s) — summed, for a runner that prints one per pairing — and the test summary (vitest's, or cargo's) out of its combined output. */
export function parseRun(output) {
  const lines = [...output.matchAll(/\[(\w[\w ]*?) spec\] composition=(\w+): compared=(\d+) mapped=(\d+) skipped=(\d+)/g)];
  const ledger = lines.length === 0 ? null : lines.reduce((acc, m) => ({ suite: m[1], composition: m[2], compared: acc.compared + Number(m[3]), mapped: acc.mapped + Number(m[4]), skipped: acc.skipped + Number(m[5]) }), { compared: 0, mapped: 0, skipped: 0 });
  const vitest = /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?/.exec(output) ?? /Tests\s+(\d+) failed/.exec(output);
  const cargo = [...output.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  const tests = vitest
    ? { failed: Number(vitest[1] ?? 0), passed: Number(vitest[2] ?? 0), skipped: Number(vitest[3] ?? 0) }
    : cargo.length > 0 ? cargo.reduce((acc, m) => ({ passed: acc.passed + Number(m[1]), failed: acc.failed + Number(m[2]), skipped: acc.skipped + Number(m[3]) }), { failed: 0, passed: 0, skipped: 0 }) : null;
  return { ledger, tests };
}

function runOne(suite, composition) {
  const { pkg, file } = SUITES[suite];
  const env = { ...process.env, OMGBASE_CAPABILITIES: composition, NO_COLOR: "1", FORCE_COLOR: "0" };
  const t0 = performance.now();
  const [crate, runner] = RUST_SUITES[suite];
  const r = engine === "rust"
    ? spawnSync("cargo", ["test", "-p", crate, "--test", runner, "--", "--nocapture"], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 << 20 })
    : spawnSync("npx", ["vitest", "run", file], { cwd: PKG_DIR[pkg], env, encoding: "utf8", maxBuffer: 64 << 20 });
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const parsed = parseRun(output);
  const ok = r.status === 0 && parsed.ledger !== null && (parsed.tests?.failed ?? 1) === 0;
  return { suite, composition, ok, exit: r.status, seconds: Math.round((performance.now() - t0) / 1000), ...parsed, output };
}

const cell = (r) => (r.ledger ? `${r.ledger.compared}/${r.ledger.mapped}/${r.ledger.skipped}` : "—") + (r.ok ? "" : " RED");

const results = [];
for (const composition of compositions) {
  for (const suite of suites) {
    process.stderr.write(`conformance${engine === "rust" ? " (rust)" : ""}: ${suite} under ${composition} …`);
    const r = runOne(suite, composition);
    results.push(r);
    process.stderr.write(` ${r.ok ? "ok" : "RED"} (${cell(r)}; vitest ${r.tests ? `${r.tests.passed} passed${r.tests.failed ? `, ${r.tests.failed} failed` : ""}${r.tests.skipped ? `, ${r.tests.skipped} skipped` : ""}` : "no summary"}; ${r.seconds}s)\n`);
    if (!r.ok) {
      const tail = r.output.split("\n").filter((l) => /×|FAIL|Error|composition=|panicked|REGRESS/.test(l)).slice(0, 40).join("\n");
      process.stderr.write(`${tail}\n`);
    }
  }
}

// ---- the matrix ----------------------------------------------------------------------------
let table = `| suite | ${compositions.join(" | ")} |\n| --- | ${compositions.map(() => "---").join(" | ")} |\n`;
for (const suite of suites) {
  table += `| ${suite} | ${compositions.map((c) => cell(results.find((r) => r.suite === suite && r.composition === c))).join(" | ")} |\n`;
}
table += `\nCells are compared/mapped/skipped from each runner's ledger (compared = as recorded, mapped = through the composition's mapping, skipped = needs the absent module); RED marks a failed cell.\n`;
process.stdout.write(table);
if (jsonOut) writeFileSync(resolve(ROOT, jsonOut), JSON.stringify(results.map(({ output: _o, ...r }) => r), null, 2) + "\n");
const red = results.filter((r) => !r.ok);
if (red.length > 0) { console.error(`conformance: ${red.length} red cell(s): ${red.map((r) => `${r.suite}@${r.composition}`).join(", ")}`); process.exit(1); }
console.error(`conformance: ${results.length} cells green`);
