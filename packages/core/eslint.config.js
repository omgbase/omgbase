import { baseConfig, bannedSerializers } from "../../eslint.config.base.js";

export default [
  ...baseConfig(import.meta.dirname, { files: ["src/**/*.ts", "corpus/**/*.ts"] }),
  {
    // core/ is the foundation: it MUST NOT import from any sibling module (07
    // §0). Production code only — test files legitimately compose modules to
    // build integration fixtures.
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: bannedSerializers,
        patterns: [
          { group: ["**/reconcile/**", "**/sync/**", "**/mutate/**", "**/graph/**", "**/search/**", "**/mcp/**", "**/cli/**"], message: "core/ must not import from sibling modules (07 §0 boundary rule)." },
        ],
      }],
    },
  },
];
