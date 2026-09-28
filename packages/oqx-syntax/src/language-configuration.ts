// Editor language configuration (VS Code's `language-configuration.json` shape,
// also what Monaco's `setLanguageConfiguration` takes after `wordPattern` becomes
// a RegExp). OQX has no comment syntax (GRAMMAR §1), so there is no `comments` key.

import { IDENTIFIER } from "./vocabulary.js";

export interface LanguageConfiguration {
  brackets: Array<[string, string]>;
  autoClosingPairs: Array<{ open: string; close: string; notIn?: string[] }>;
  surroundingPairs: Array<[string, string]>;
  /** A regex source: VS Code reads a string; Monaco wants a RegExp (see `monaco.ts`). */
  wordPattern: string;
}

export const oqxLanguageConfiguration: LanguageConfiguration = {
  brackets: [
    ["{", "}"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
  ],
  surroundingPairs: [
    ["{", "}"],
    ["(", ")"],
    ['"', '"'],
    ["'", "'"],
  ],
  wordPattern: IDENTIFIER,
};
