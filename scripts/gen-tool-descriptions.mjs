#!/usr/bin/env node
// The Rust catalog's tool descriptions, generated from the one source both
// engines share: spec/surface/tool-descriptions.json (written by the reference
// under SURFACE_SPEC_UPDATE=1 — packages/core/corpus/surface/spec.test.ts —
// from the registrations in packages/core/src/mcp/server.ts). Rewrites
// crates/omgbase-surface/src/descriptions.rs; the surface crate's tests/spec.rs
// fails when the two drift, in either direction. Plain Node, no dependencies.
//
//   node scripts/gen-tool-descriptions.mjs          # write
//   node scripts/gen-tool-descriptions.mjs --check  # exit 1 when stale
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "spec/surface/tool-descriptions.json");
const target = join(root, "crates/omgbase-surface/src/descriptions.rs");

/** `docs_read` → `DOCS_READ`. */
export function constName(tool) {
  return tool.toUpperCase();
}

/** A Rust raw-string literal that can hold `text` (the hash run grows until it cannot close early). */
export function rawString(text) {
  let hashes = "#";
  while (text.includes(`"${hashes}`)) hashes += "#";
  return `r${hashes}"${text}"${hashes}`;
}

export function render(descriptions) {
  const lines = [
    "//! The tool descriptions of the catalog (`spec/surface/README.md` §4) —",
    "//! GENERATED from `spec/surface/tool-descriptions.json` by",
    "//! `scripts/gen-tool-descriptions.mjs`; do not edit by hand. That file is",
    "//! written by the reference (`SURFACE_SPEC_UPDATE=1` on",
    "//! `packages/core/corpus/surface/spec.test.ts`) from the registrations in",
    "//! `packages/core/src/mcp/server.ts`, so both engines publish the same text",
    "//! byte for byte; `tests/spec.rs` fails when either side drifts.",
    "",
  ];
  for (const [tool, description] of Object.entries(descriptions)) {
    lines.push(`/// \`${tool}\``);
    lines.push(`pub const ${constName(tool)}: &str = ${rawString(description)};`);
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const descriptions = JSON.parse(readFileSync(source, "utf8"));
  const text = render(descriptions);
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(target, "utf8"); } catch { /* missing counts as stale */ }
    if (current !== text) {
      process.stderr.write(`${target} is stale — run node scripts/gen-tool-descriptions.mjs\n`);
      process.exit(1);
    }
  } else {
    writeFileSync(target, text);
    process.stdout.write(`wrote ${target} (${Object.keys(descriptions).length} tools)\n`);
  }
}
