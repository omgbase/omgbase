// Editor language configuration (VS Code's `language-configuration.json` shape,
// also what Monaco's `setLanguageConfiguration` takes after `wordPattern` becomes
// a RegExp). `comments` names the `//` line and `/* … */` block comment of OQX
// 0.28 (GRAMMAR §1), so the editors' toggle-comment commands work.

import { COMMENT, IDENTIFIER } from "./vocabulary.js";

export interface LanguageConfiguration {
  comments: { lineComment: string; blockComment: [string, string] };
  brackets: Array<[string, string]>;
  autoClosingPairs: Array<{ open: string; close: string; notIn?: string[] }>;
  surroundingPairs: Array<[string, string]>;
  /** A regex source: VS Code reads a string; Monaco wants a RegExp (see `monaco.ts`). */
  wordPattern: string;
}

export const oqxLanguageConfiguration: LanguageConfiguration = {
  comments: { lineComment: COMMENT.line, blockComment: [COMMENT.blockOpen, COMMENT.blockClose] },
  brackets: [
    ["{", "}"],
    ["(", ")"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    ["{", "}"],
    ["(", ")"],
    ["[", "]"],
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
  ],
  wordPattern: IDENTIFIER,
};
