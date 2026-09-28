// The common token shape both tokenizers reduce to, so goldens and the parity
// test compare like with like.

import type { TokenClass } from "../src/vocabulary.js";

export interface ClassToken {
  text: string;
  cls: TokenClass;
}

/** Drop the unclassified tokens (whitespace between tokens: only whitespace is
 * left unmatched by every grammar), split tokens at line breaks (a line-oriented
 * engine never yields a token spanning lines), and merge touching tokens of one
 * class, as editors render them. A blank token *with* a class — the space inside
 * `" "` — is content and stays. */
/** OQX whitespace only (GRAMMAR §1) — not `String.prototype.trim`'s Unicode set. */
const blank = (text: string): boolean => /^[ \t\r]*$/.test(text);

export function normalize(tokens: ReadonlyArray<{ text: string; cls: TokenClass | null }>): ClassToken[] {
  const out: ClassToken[] = [];
  let gap = true;
  for (const t of tokens) {
    t.text.split("\n").forEach((text, i) => {
      if (i > 0) gap = true;
      if (text === "") return;
      if (t.cls === null) {
        if (!blank(text)) throw new Error(`unclassified token ${JSON.stringify(text)}`);
        gap = true;
        return;
      }
      const last = out[out.length - 1];
      if (last && !gap && last.cls === t.cls) last.text += text;
      else out.push({ text, cls: t.cls });
      gap = false;
    });
  }
  return out;
}

/** `class(text) class(text) …` — the golden notation. */
export function render(tokens: readonly ClassToken[]): string {
  return tokens.map((t) => `${t.cls}(${t.text})`).join(" ");
}
