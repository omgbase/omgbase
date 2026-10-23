import { baseConfig } from "../../eslint.config.base.js";

export default [
  ...baseConfig(import.meta.dirname, { files: ["src/**/*.ts"] }),
  {
    // The client is browser-safe and engine-free: nothing from node: or from the
    // engine packages may enter it. The tests (src/**/*.test.ts) are exempt — they
    // run under vitest on node and build the fake server from the SDK.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["node:*"], message: "@omgbase/client is browser-safe: no node: imports." },
          { group: ["@omgbase/core", "@omgbase/core/*", "@omgbase/sync", "@omgbase/oqx"], message: "@omgbase/client depends on the MCP SDK alone (zero omgbase deps)." },
        ],
      }],
    },
  },
];
