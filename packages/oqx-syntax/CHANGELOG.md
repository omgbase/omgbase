# Changelog

All notable changes to `@omgbase/oqx-syntax` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.2.0] - 2026-09-28

### Minor
- New package **`@omgbase/oqx-syntax`**: syntax highlighting assets for OQX, generated from one lexical vocabulary so no editor grammar can drift from another. It ships the TextMate grammar (`source.oqx`, `syntax/oqx.tmLanguage.json`), a Monaco Monarch grammar (`syntax/oqx.monarch.json`), a CodeMirror 6 stream parser (`oqxStreamParser(tags)`, plus `oqxLegacyMode()` in CodeMirror 5's shape for Obsidian), a Prism grammar (`oqxPrismGrammar`, `registerOqxPrism`), the editor language configuration, language metadata (`LANGUAGE`, `LANGUAGE_VERSION`), the vocabulary itself (keywords, contextual words, consumers, builtins, intrinsics, the omgbase host names), and adapters for Shiki (`oqxShikiLanguage`), Monaco (`registerOqx`) and a VS Code extension under `vscode/` that also highlights ```` ```oqx ```` Markdown fences. Highlighting is lexical: contextual words are colored only in position (`count {`, `limit 10`, `order by`, `in <value>`), malformed numbers and lex-error characters are marked `invalid`, and every `$name` is an intrinsic. Tests tokenize with the real TextMate engine (golden corpus), prove that the Monarch, CodeMirror and Prism grammars tokenize every `spec/oqx` fixture exactly as TextMate does, check that lexically valid fixtures never show an error token, pin the vocabulary to the spec prose and to `@omgbase/oqx`'s `LANGUAGE_VERSION`, and load the grammar into Shiki.
