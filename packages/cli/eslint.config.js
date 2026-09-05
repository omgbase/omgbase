import { baseConfig } from "../../eslint.config.base.js";

// Tests live outside the build tsconfig's include, so typed linting uses a
// dedicated tsconfig.eslint.json that widens include to cover test/**.
export default baseConfig(import.meta.dirname, {
  files: ["src/**/*.ts", "test/**/*.ts"],
  project: "./tsconfig.eslint.json",
});
