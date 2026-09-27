import { baseConfig } from "../../eslint.config.base.js";

// Tests (test/**) and the spec runner (corpus/**) live outside the build
// tsconfig's include, so typed linting uses a dedicated tsconfig.eslint.json
// that widens include to cover them.
export default baseConfig(import.meta.dirname, {
  files: ["src/**/*.ts", "test/**/*.ts", "corpus/**/*.ts"],
  project: "./tsconfig.eslint.json",
});
