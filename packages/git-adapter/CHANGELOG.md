# Changelog

All notable changes to `@omgbase/git-adapter` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.1.1] - 2026-10-27

### Patch
- Dependency pins moved: .

### Notes
- Publish `@omgbase/git-adapter` instead of keeping it `private`. The package was
  marked `private: true` and had never reached npm, but `omgbase` (the CLI)
  declares it as an ordinary runtime dependency and `packages/cli/src/seams.ts`
  imports it statically to register the Git history provider at process start —
  so the published `omgbase@0.30.0` has been uninstallable since it shipped:

  ```
  $ npm install omgbase@0.30.0
  npm error code E404
  npm error 404  The requested resource '@omgbase/git-adapter@^0.1.0' could not be found
  ```

  Making it public at its current `0.1.0` satisfies that existing `^0.1.0` range,
  so the broken install is repaired without republishing the CLI. Brought in line
  with every other published package: `publishConfig.access = "public"` (a scoped
  package is `restricted` by default) and `LICENSE` added to the package and to
  `files`. No code change — the version does not move.
