# Bootstrap: the alchemy corpus, already attached

Shared setup for the omgbase CLI examples, pulled into a tutorial with a recital
`include` directive.

This variant leaves the session with the alchemy corpus already attached as the
`alchemy` repo, so a walkthrough can start querying immediately. The un-attached
variant used by getting-started is [fresh-workspace.md](./fresh-workspace.md);
the live `omg shell` REPL variant is
[attached-alchemy-shell.md](./attached-alchemy-shell.md).

The `setup` below, in order: locates the repo (`git rev-parse`); puts the freshly
built `omg` on `PATH` via a tiny shim over the dist binary; then copies the
corpus into a temp dir, `cd`s into it, and runs `omg init` + `omg attach`.
`teardown` removes both temp dirs when the session ends.

<!-- recital include: ./omg-types.md -->

<!-- recital:
cmd: bash
syntax: console
setup: |
  repo="$(git rev-parse --show-toplevel)"
  export NO_COLOR=1
  shim="$(mktemp -d)"
  printf '#!/usr/bin/env bash\nexec node "%s/packages/cli/dist/src/main.js" "$@"\n' "$repo" > "$shim/omg"
  chmod +x "$shim/omg"
  export PATH="$shim:$PATH"
  work="$(mktemp -d)"
  cp -R "$repo/packages/core/corpus/oqx/fixtures/alchemy/." "$work"
  cd "$work"
  omg init . --yes --no-embedder >/dev/null
  omg attach . -y --slug alchemy >/dev/null
teardown: |
  rm -rf "$work" "$shim"
-->
