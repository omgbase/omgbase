# Bootstrap: a bash session with the alchemy corpus attached, ready to `omg shell`

Shared bootstrap for the interactive-shell walkthrough, pulled in with a recital
`include` directive.

This drives a **bash** session (so a transcript can show `$ omg shell` being
launched) and syncs on two prompts — bash's `$ ` and the REPL's `omg> ` — via
recital's prompt list. `$OMG_SHELL_PROMPT` (set below) is what makes a bare
`omg shell` emit `omg> ` here, exactly as an interactive terminal would; `PS1`
gives bash its `$ ` prompt.

The `setup` runs first (in the launching bash, before it `exec`s into the
interactive one) and its `cd`/exports carry over: it locates the repo
(`git rev-parse`), puts the freshly built `omg` on `PATH` via a shim, copies the
corpus into a temp dir, `cd`s in, and runs `omg init` + `omg source add`. There's no
`teardown` in prompt mode (the shell replaces the launcher); the OS reclaims the
temp dirs.

<!-- recital include: ./omg-types.md -->

<!-- recital:
cmd: "bash --norc --noprofile -i"
prompt: ["$ ", "omg> "]
syntax: console
env:
  PS1: "$ "
  OMG_SHELL_PROMPT: "omg> "
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
  omg source add . -y --repo alchemy >/dev/null
-->
