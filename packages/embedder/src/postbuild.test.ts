import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN_JS, hasShebang, markExecutable } from "./postbuild.js";

// The post-build step: the built bin.js must be executable, because the engine
// spawns `embedding.provider` directly (a shebang alone is not enough).

describe("markExecutable", () => {
  it("sets 0o755 on a file tsc left at 0o644 and reports the mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "omgbase-embedder-postbuild-"));
    try {
      const file = join(dir, "bin.js");
      writeFileSync(file, "#!/usr/bin/env node\nconsole.log(1);\n");
      chmodSync(file, 0o644);
      expect(statSync(file).mode & 0o111).toBe(0);
      expect(markExecutable(file)).toBe(0o755);
      expect(statSync(file).mode & 0o111).toBe(0o111);
      expect(hasShebang(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the file is missing (the build order is tsc, then this)", () => {
    expect(() => markExecutable(join(tmpdir(), "omgbase-embedder-no-such-file.js"))).toThrow(/does not exist/);
  });

  it("names dist/src/bin.js, and the built one — when it exists — carries the shebang and the executable bit", () => {
    expect(BIN_JS.endsWith("/bin.js")).toBe(true);
    if (!existsSync(BIN_JS)) return; // not built yet
    expect(hasShebang(BIN_JS)).toBe(true);
    expect(statSync(BIN_JS).mode & 0o111).toBe(0o111);
  });
});
