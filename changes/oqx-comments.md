---
npm:
  "@omgbase/oqx": minor
  "@omgbase/oqx-syntax": minor
  "@omgbase/core": patch
crates:
  oqx: minor
  omgbase-surface: patch
---
OQX 0.28 — comments. `//` runs to the end of the line, `/* … */` across lines (no nesting); both are whitespace to the lexer, so they may stand wherever whitespace may (between tokens, inside a block, inside a template's `${ … }`), are not recognised inside a string literal or a template's text, and are dropped by the canonical printer (the tree records no trivia). An unterminated `/*` is the lex error `unterminated comment at <offset>`; a single `/` is still division; `#` is still a lex error. New fixture suite `spec/oqx/cases/comments.json`; both engines; `@omgbase/oqx-syntax` highlights comments in every grammar and the editor configuration gains the `comments` key (line and block toggling); the `query_syntax` manual notes the syntax.
