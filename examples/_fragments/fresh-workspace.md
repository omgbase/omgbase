# Bootstrap: a fresh (un-attached) alchemy workspace

Shared setup for the omgbase CLI examples, pulled into a tutorial with a recital
`include` directive.

This variant seeds a throwaway working directory with a fresh, **un-attached**
copy of the alchemy corpus — for the getting-started walkthrough, which
demonstrates `omg init` / `omg source add` itself. The already-attached variant is
[attached-alchemy.md](./attached-alchemy.md); the live-REPL variant is
[attached-alchemy-shell.md](./attached-alchemy-shell.md).

The `setup` below, in order: locates the repo (`git rev-parse`); puts the freshly
built `omg` on `PATH` via a tiny shim over the dist binary; then copies the
corpus into a temp dir and `cd`s into it. `teardown` removes both temp dirs when
the session ends.

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
teardown: |
  rm -rf "$work" "$shim"
-->
