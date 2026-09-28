// The checked-in JSON under syntax/ and vscode/ is exactly what the source generates.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAssets, renderAsset } from "../src/assets.js";

const ROOT = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

describe("generated assets", () => {
  for (const [rel, value] of Object.entries(buildAssets(version))) {
    it(`${rel} is current (run \`pnpm build\` to regenerate)`, () => {
      expect(readFileSync(join(ROOT, rel), "utf8")).toBe(renderAsset(value));
    });
  }

  it("the grammars are plain JSON (no RegExp objects, no undefined)", () => {
    for (const value of Object.values(buildAssets(version))) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it("the VS Code manifest points at files that exist", () => {
    const manifest = buildAssets(version)["vscode/package.json"] as {
      contributes: { languages: Array<{ configuration: string }>; grammars: Array<{ path: string }> };
    };
    for (const l of manifest.contributes.languages) readFileSync(join(ROOT, "vscode", l.configuration));
    for (const g of manifest.contributes.grammars) readFileSync(join(ROOT, "vscode", g.path));
  });
});
