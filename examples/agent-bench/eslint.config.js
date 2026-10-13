import { baseConfig } from "../../eslint.config.base.js";

// Sources are TypeScript run directly by Node's type stripping (no build step);
// the typed ruleset runs over src/ and the tests.
export default [
  { ignores: ["results/**"] },
  ...baseConfig(import.meta.dirname, {
    files: ["src/**/*.ts", "test/**/*.ts"],
    project: "./tsconfig.json",
  }),
];
