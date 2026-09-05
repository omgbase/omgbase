import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

// Shared eslint base for every workspace package. Package configs call
// baseConfig(import.meta.dirname) and may append their own rules (e.g. core's
// module-boundary rule). Keeps the TS ruleset and the splice-only serializer
// ban in one place instead of drifting per package.

// Rendering is splice-only (README invariant + 07 §0). Any canonicalizing
// serializer must never enter the dependency graph. This rule is the tripwire;
// do not disable it.
export const bannedSerializers = [
  { name: "remark-stringify", message: "Rendering is splice only. remark-stringify is banned (README invariant #1)." },
  { name: "mdast-util-to-markdown", message: "Rendering is splice only. mdast-util-to-markdown is banned (README invariant #1)." },
];

/**
 * Base flat-config array for a package rooted at `dirname`. `files` defaults to
 * src/**; pass extra globs (e.g. corpus/**) when a package needs them. `project`
 * is the tsconfig used for typed linting (default ./tsconfig.json); packages
 * whose tests live outside the build tsconfig pass a widened tsconfig.eslint.json.
 */
export function baseConfig(dirname, { files = ["src/**/*.ts"], project = "./tsconfig.json" } = {}) {
  return [
    {
      ignores: ["dist/**", "node_modules/**", "coverage/**"],
    },
    {
      files,
      languageOptions: {
        parser: tsparser,
        parserOptions: {
          project,
          tsconfigRootDir: dirname,
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
  ];
}
