import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "corpus/**/*.test.ts"],
    environment: "node",
  },
});
