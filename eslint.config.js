import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

// Rendering is splice-only (README invariant + 07 §0). Any canonicalizing
// serializer must never enter the dependency graph. This rule is the tripwire;
// do not disable it.
const bannedSerializers = [
  { name: "remark-stringify", message: "Rendering is splice only. remark-stringify is banned (README invariant #1)." },
  { name: "mdast-util-to-markdown", message: "Rendering is splice only. mdast-util-to-markdown is banned (README invariant #1)." },
];

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts", "corpus/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "no-restricted-imports": ["error", { paths: bannedSerializers }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    // core/ is the foundation: it MUST NOT import from any sibling module (07 §0).
    files: ["src/core/**/*.ts"],
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
