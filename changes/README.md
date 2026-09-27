# Change notes

One file per change, committed with the code it describes. `pnpm release`
(`scripts/release.mjs`) folds them into versions, changelogs and a release
commit; `pnpm release check` fails when a package changed without one.

```markdown
---
npm:
  "@omgbase/core": minor
crates:
  omgbase-store: patch
  omgbase: minor
---
One paragraph or a few bullets of Markdown: what changed and why.
```

- **Filename**: `changes/<slug>.md`, any slug (`wave-5-cursors.md`, `fix-doctor-count.md`).
- **Frontmatter**: a flat two-section map — `npm:` lists npm packages by their
  `package.json` name (quote scoped names), `crates:` lists crates by their
  `Cargo.toml` name. Two sections because `omgbase` is both the npm CLI and the
  Rust binary crate. A section you do not need may be omitted or written `crates: {}`.
- **Levels**: `major | minor | patch | none`. `none` records a change that bumps
  nothing (docs, tests, refactors) — it still satisfies `release check`, and its
  body lands under `### Notes` in the changelog the next time the package ships.
- **Body**: non-empty Markdown. It is copied verbatim into each named package's
  `CHANGELOG.md` under `### Major` / `### Minor` / `### Patch` / `### Notes`, so
  write it for the reader of that changelog (a paragraph becomes one bullet;
  bullets stay bullets).
- **Spec tracking**: a crate or package that implements a spec (`oqx`,
  `@omgbase/oqx`, `omgbase-format`, `-reconcile`, `-store`, `-properties`,
  `-graph`, `-search`, `-mutate`, `-sync`, `-surface`) keeps
  `major.minor == spec/<x>/VERSION`. Ask `minor`/`major` only when the spec
  VERSION moved with the change; `patch` never moves `major.minor`. `release plan`
  enforces this both ways.
- **Pins**: a crate that pins a bumped dependency (`version = "…"` in its
  `Cargo.toml`) is patched automatically by the plan — you do not need to name it.

The tool: `pnpm release check` before committing; the coordinator runs
`pnpm release plan`, `pnpm release version` (bump, rewrite pins, changelogs,
delete the consumed notes, commit `release: …`), then `pnpm release publish`.
