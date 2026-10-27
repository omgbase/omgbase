import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `@omgbase/core` → this package's SOURCE (modular-core Phase 6a): the fixture
// runners attach the git history provider by importing `@omgbase/git-adapter`'s
// source (`corpus/composition.ts`), whose own `@omgbase/core` imports must
// resolve to the same module instances the runners use (the capability
// registry is a WeakMap on the connection; `instanceof` across two copies of
// the core would fail). The alias is test-only: nothing under src/ imports the
// package by its own name.
export default defineConfig({
  resolve: {
    alias: { "@omgbase/core": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  test: {
    include: ["src/**/*.test.ts", "corpus/**/*.test.ts"],
    environment: "node",
  },
});
