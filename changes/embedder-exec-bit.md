---
npm:
  "@omgbase/embedder": patch
  "@omgbase/core": patch
crates:
  omgbase-search: patch
---
- `@omgbase/embedder`: the build sets the executable bit on `dist/src/bin.js` (`node dist/src/postbuild.js` after `tsc`; `markExecutable`, tested). `tsc` writes the file with its `#!/usr/bin/env node` shebang at 0644, and the engine spawns `embedding.provider` directly, so `omg init --embedder <checkout>/packages/embedder/dist/src/bin.js` failed at `omg source add` with `embedder_failed … spawn … EACCES`. A published install never saw it (`npm` sets the bit on a `bin` entry); a monorepo build did.
- `@omgbase/core` / `omgbase-search`: when a stdio provider fails to spawn with EACCES or ENOENT and the command's first token ends in `.js`/`.mjs`/`.cjs`, the `embedder_failed` reason gains a hint, byte for byte the same in both engines: `Hint: the command names a JavaScript file; run it through node — set embedding.provider to \`node <command>\` — or give the file the executable bit` (`spawnHint` / `spawn_hint`; the reason text is unpinned by the spec — spec/cli `embed-broken-provider` — so the message grows rather than a `data` member). Pinned by unit tests in both crates with a 0644 `.js` file.
