import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The real model download + inference is slow; the E2E test opts in via env.
    testTimeout: 120_000,
  },
});
