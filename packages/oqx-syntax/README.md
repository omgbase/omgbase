# @omgbase/oqx-syntax

**Syntax highlighting assets for [OQX](https://github.com/omgbase/omgbase/tree/main/packages/oqx)**
(omgbase Query eXpressions): a TextMate grammar, a Monaco Monarch grammar, a
CodeMirror stream parser, a Prism grammar, the editor language configuration and
language metadata, with adapters for Shiki, Monaco, CodeMirror 6 (and 5), Prism
and VS Code — all generated from **one lexical vocabulary and one rule table**,
so no grammar can drift from another.

- Language id `oqx`, TextMate scope `source.oqx`, file extension `.oqx`,
  Markdown fences ```` ```oqx ````.
- Zero runtime dependencies. Nothing here imports the parser: highlighting is
  lexical and deliberately separate from `@omgbase/oqx`, which stays the semantic
  source of truth.
- Describes OQX language **0.15** (`LANGUAGE_VERSION`, pinned by tests to
  `spec/oqx/VERSION` and to `@omgbase/oqx`).

## Install

```sh
npm i @omgbase/oqx-syntax
```

## Static assets

| File | What |
| --- | --- |
| `syntax/oqx.tmLanguage.json` | the TextMate grammar (`source.oqx`) — VS Code, Shiki, GitHub Linguist-style consumers |
| `syntax/oqx.monarch.json` | the Monaco Monarch grammar, regexes as strings |
| `syntax/language-configuration.json` | brackets, auto-closing and surrounding pairs, word pattern (no comments: OQX has none) |
| `vscode/` | a VS Code language extension: the grammar, the configuration and an injection grammar for ```` ```oqx ```` fences in Markdown |

They are also exported as subpaths (`@omgbase/oqx-syntax/oqx.tmLanguage.json`, …)
and as JavaScript objects (`oqxTextMateGrammar`, `oqxMonarchGrammar`,
`oqxLanguageConfiguration`).

## Shiki (docs, Astro, server-side rendering)

```js
import { createHighlighter } from "shiki";
import { oqxShikiLanguage } from "@omgbase/oqx-syntax/shiki";

const highlighter = await createHighlighter({ themes: ["github-dark"], langs: [oqxShikiLanguage] });
highlighter.codeToHtml('name from people where age > 30', { lang: "oqx", theme: "github-dark" });
```

With Astro, pass the language through `markdown.shikiConfig.langs`; fenced
blocks tagged `oqx` then highlight.

## Monaco

```js
import * as monaco from "monaco-editor";
import { registerOqx } from "@omgbase/oqx-syntax/monaco";

registerOqx(monaco); // language + Monarch tokens + configuration
monaco.editor.create(el, { language: "oqx", value: "name from people" });
```

`registerOqx` takes anything with a `languages` object exposing `register`,
`setMonarchTokensProvider` and `setLanguageConfiguration`, so it works with
`monaco-editor` and `@monaco-editor/react` alike without this package depending
on either.

## CodeMirror 6 (and Obsidian)

```js
import { StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { oqxStreamParser } from "@omgbase/oqx-syntax/codemirror";

const oqx = StreamLanguage.define(oqxStreamParser(tags));
// new EditorView({ extensions: [oqx, syntaxHighlighting(defaultHighlightStyle)] })
```

`oqxStreamParser` returns a plain `StreamParser` object; you pass in `tags` from
`@lezer/highlight` and it builds the `tokenTable`, so this package imports
neither library. The same tokenizer is available as a CodeMirror 5 mode
(`oqxLegacyMode()`, returning CodeMirror 5 style classes such as `keyword`,
`variable-2`, `builtin`, `error`) for hosts that still register languages that
way — Obsidian's editor registers code-block languages through
`window.CodeMirror.defineMode("oqx", () => oqxLegacyMode())`.

This is deliberately a stream parser, not a Lezer grammar: highlighting needs
no parse tree. A Lezer grammar belongs to the day OQX needs structural editing.

## Prism

```js
import Prism from "prismjs";
import { registerOqxPrism } from "@omgbase/oqx-syntax/prism";

registerOqxPrism(Prism); // Prism.languages.oqx (and the aliases)
Prism.highlight("name from people where age > 30", Prism.languages.oqx, "oqx");
```

Prism is what Obsidian's reading view and many static-site tools use for code
blocks. Tokens carry Prism's standard classes (`keyword`, `number`, `string`,
`builtin`, `function`, `property`, `punctuation`, `operator`, `boolean`,
`symbol`, `variable`) so stock themes color them, plus the token-class name
(`consumer`, `intrinsic`, `invalid`, …) for finer CSS. The grammar uses regex
lookbehind, so it needs a current JavaScript engine (every modern browser;
Safari from 16.4).

## VS Code

`vscode/` is a complete, code-free extension (`contributes.languages` and
`contributes.grammars`). Package it with `npx @vscode/vsce package` from that
directory, or symlink it into `~/.vscode/extensions/` while developing.

## What gets highlighted

The grammar follows `spec/oqx/GRAMMAR.md` §1. It distinguishes:

| Token class | TextMate scope | Monarch token | Examples |
| --- | --- | --- | --- |
| reserved keywords | `keyword.control.oqx` | `keyword` | `select` `from` `where` |
| clause words | `keyword.control.clause.oqx` | `keyword.clause` | `follow` `order by` `limit` `offset` |
| consumers | `keyword.control.consumer.oqx` | `keyword.consumer` | `collect` `exists` `none` `count` `first` `single` (before `{`) |
| follow options | `keyword.control.follow.oqx` | `keyword.follow` | `frontier` `depth` `by` |
| modifiers | `keyword.other.modifier.oqx` | `keyword.modifier` | `distinct` `asc` `desc` `values` |
| literals | `constant.language.oqx` | `constant.language` | `true` `false` `null` |
| numbers | `constant.numeric.oqx` | `number` | `42` `0.5` `1e5` |
| malformed numbers | `invalid.illegal.number.oqx` | `invalid.number` | `1.` `1e` `.5` |
| strings, escapes | `string.quoted.{double,single}.oqx`, `constant.character.escape.oqx` | `string`, `string.escape` | `"a\"b"` `'x'` |
| bindings | `variable.other.binding.oqx` | `variable.binding` | `${0}` (the tagged-template form) |
| intrinsics | `variable.language.oqx` | `variable.predefined` | `$it` `$key` `$depth` `$path` `$repo` — any `$name` |
| lift / outer reference | `keyword.operator.lift.oqx` | `operator.lift` | `^budget` `^name:` |
| aliases | `variable.other.alias.oqx` | `identifier.alias` | `label:` |
| builtin functions / methods | `support.function.builtin.oqx`, `support.function.method.oqx` | `predefined.function`, `predefined.method` | `size(…)` `entries(…)` `.lower()` `.matches(…)` |
| omgbase row functions | `support.function.omgbase.oqx` | `predefined.function.omgbase` | `text("…")` `semantic("…")` `under(…)` |
| other calls | `entity.name.function.oqx` | `identifier.function` | `foo(…)` `.bar()` |
| members | `variable.other.member.oqx` | `identifier.member` | `.slug` in `meta.slug` |
| operators | `keyword.operator.oqx` | `operator` | `== != < <= > >= && \|\| ! + - * / %` |
| range, membership | `keyword.operator.range.oqx`, `keyword.operator.membership.oqx` | `operator.range`, `keyword.operator.membership` | `..` `...` `in` |
| word operators | `keyword.operator.word.oqx` | `keyword.operator.word` | `is` `not` `and` `or` (0.17; reserved words) |
| punctuation | `punctuation.*.oqx` | `delimiter.*` | `{ } ( ) [ ] , : .` — `[ ]` is the bracket lookup (0.17) |
| lex errors | `invalid.illegal.oqx` | `invalid` | `=` `&` `\|` `@` `;` `#` — OQX has no comments |

**Contextual words are colored only in position.** `count` is a consumer before
`{`, `limit` a clause before a number, `in` an operator before a value, `asc` a
direction before `,` or the end of the clause; anywhere else they are fields,
exactly as the specification reads them (`select count from r`, `follow in`,
`in exists { … }` on omgbase's `docs`).

The full table — with the CodeMirror 6 highlight tag, the CodeMirror 5 class
and the Prism class for each token class — is `TOKEN_CLASSES` in the vocabulary
export.

One limit is shared by every grammar here: **position is decided within the
line.** A consumer word at the end of a line with its `{` on the next line, or
`in` followed by its value on the next line, is read as a field. The
line-oriented engines (TextMate, Monarch, CodeMirror) cannot see further, and
the Prism grammar is written to agree with them rather than to be cleverer.

## Vocabulary

`@omgbase/oqx-syntax/vocabulary` exports the word lists (`KEYWORDS`,
`CONTEXTUAL_WORDS`, `CONSUMERS`, `FOLLOW_OPTIONS`, `MODIFIERS`, `LITERALS`,
`OPERATORS`, `BUILTIN_FUNCTIONS`, `BUILTIN_METHODS`, `INTRINSICS`), the identifier
shape, the language metadata (`LANGUAGE`, `LANGUAGE_VERSION`) and — kept apart,
because it is not part of the language — the **omgbase host vocabulary**
(`OMGBASE`: roots, row functions, intrinsics per target, relations). Completion
providers and documentation tooling can build on the same lists the grammars do.

## How it stays honest

- `src/rules.ts` is one ordered rule table; `textmate.ts`, `monarch.ts`,
  `codemirror.ts` and `prism.ts` are serializers of it. The JSON under `syntax/`
  and `vscode/` is generated by `pnpm build` and a test fails when it differs.
- The corpus goldens run through the real TextMate engine (`vscode-textmate` on
  Oniguruma, as VS Code and Shiki do).
- Parity tests tokenize the corpus **and every query in `spec/oqx`'s fixtures**
  with the Monarch grammar (through a small interpreter of Monarch's documented
  semantics), the CodeMirror stream parser (driven line by line as
  `StreamLanguage` drives it) and the Prism grammar (through `prismjs` itself),
  and require output identical to TextMate's.
- A sweep proves that a fixture the language accepts never shows a lex-error
  token, and that every `lex`-stage fixture shows the right one.
- The vocabulary is pinned to the specification prose (`GRAMMAR.md`,
  `SEMANTICS.md`, `spec/surface`) and to `@omgbase/oqx`'s `LANGUAGE_VERSION`.

## Not here (by design)

No Lezer grammar, no tree-sitter, no semantic tokens: those need a parser and
belong to a language-server-shaped package. Semantic tokens, when they come,
should augment these grammars rather than replace them.

## License

MIT
