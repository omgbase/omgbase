---
npm:
  omgbase: minor
  "@omgbase/core": minor
crates: {}
---
A `version` MCP tool (spec/surface 1.4) and an `omg version` verb (spec/cli 1.1): which engine you are talking to and what it was built from — `{ engine: "typescript", version, components: { omgbase, @omgbase/core, @omgbase/oqx, @omgbase/sync, @omgbase/fs-adapter }, specs: { oqx, format, reconcile, store, properties, graph, search, mutate, sync, surface, cli }, schema, mcp: { protocol, sdk }, runtime, commit, built }`. `versionInfo(store?, host?)` and the compile-time `SPEC_VERSIONS` map (tested against every `spec/<x>/VERSION`) are exported from `@omgbase/core`; `pnpm build` writes `dist/build-info.json` (`commit`, `built`) into the `omgbase` package, which passes its identity to the engine as `ServerContext.host`. `omg version --json` is the tool result verbatim; `omg version --server …` renders the remote engine's answer, which is how you tell a TypeScript `omg mcp` from a Rust `omgbase mcp`. The fixtures record the result by shape (leaves as type names). `--version` is unchanged.
