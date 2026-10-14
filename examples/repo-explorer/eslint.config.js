import { baseConfig } from "../../eslint.config.base.js";

// Tests and the vite/vitest configs are in the one tsconfig (noEmit; vite does
// the bundling), so typed linting can use it directly.
export default baseConfig(import.meta.dirname, {
  files: ["src/**/*.ts", "test/**/*.ts"],
  project: "./tsconfig.json",
});
