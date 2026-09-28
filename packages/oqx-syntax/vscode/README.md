# OQX Syntax for VS Code

Syntax highlighting for [OQX](https://github.com/omgbase/omgbase/tree/main/packages/oqx)
(omgbase Query eXpressions): `.oqx` files and ```` ```oqx ```` fenced blocks in
Markdown.

This extension has no code — only a language contribution, the TextMate grammar
(`source.oqx`) and a Markdown injection grammar. Every file except this README is
generated from [`@omgbase/oqx-syntax`](../README.md) by its `pnpm build`; do not
edit them by hand.

Package: `npx @vscode/vsce package` in this directory. Develop: symlink this
directory into `~/.vscode/extensions/omgbase.oqx-syntax`.
