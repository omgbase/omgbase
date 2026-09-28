import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_VERSIONS } from "./spec-versions.js";

// SPEC_VERSIONS is a compile-time constant (a published package carries no
// spec/); this test is what keeps it honest against the files under spec/.
const SPEC_ROOT = fileURLToPath(new URL("../../../spec/", import.meta.url));

describe("SPEC_VERSIONS (spec/surface §4 `version.specs`)", () => {
  const specDirs = readdirSync(SPEC_ROOT).filter((d) => statSync(join(SPEC_ROOT, d)).isDirectory() && statSync(join(SPEC_ROOT, d, "VERSION")).isFile()).sort();

  it("names every spec under spec/ and nothing else", () => {
    expect(Object.keys(SPEC_VERSIONS).sort()).toEqual(specDirs);
  });

  for (const [name, version] of Object.entries(SPEC_VERSIONS)) {
    it(`${name} = spec/${name}/VERSION`, () => {
      expect(version).toBe(readFileSync(join(SPEC_ROOT, name, "VERSION"), "utf8").trim());
    });
  }
});
