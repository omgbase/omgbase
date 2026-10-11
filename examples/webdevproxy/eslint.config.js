import { baseConfig } from "../../eslint.config.base.js";

// The package is plain JS (no build step); the typed ruleset runs over the
// tests and the hand-written declaration file, which import the .mjs modules.
export default baseConfig(import.meta.dirname, {
  files: ["test/**/*.ts", "index.d.ts"],
  project: "./tsconfig.json",
});
