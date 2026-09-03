import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "corpus/**/*.test.ts"],
    environment: "node",
  },
});
