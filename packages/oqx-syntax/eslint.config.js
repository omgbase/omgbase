import { baseConfig } from "../../eslint.config.base.js";

// Tests live outside the build tsconfig's include, so typed linting uses a
// widened tsconfig.eslint.json.
export default baseConfig(import.meta.dirname, {
  files: ["src/**/*.ts", "test/**/*.ts"],
  project: "./tsconfig.eslint.json",
});
