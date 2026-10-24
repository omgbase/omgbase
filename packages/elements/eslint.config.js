import { baseConfig } from "../../eslint.config.base.js";

export default [
  ...baseConfig(import.meta.dirname, { files: ["src/**/*.ts"] }),
  {
    // The elements are browser-only and engine-free: nothing from node: or from
    // the engine packages may enter them (the tests are exempt; they run on node).
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["node:*"], message: "@omgbase/elements is browser-only: no node: imports." },
          { group: ["@omgbase/core", "@omgbase/core/*", "@omgbase/sync", "@omgbase/oqx"], message: "@omgbase/elements renders what a client fetched; it never talks to an engine." },
        ],
      }],
    },
  },
];
