---
npm:
  "@omgbase/core": minor
  "@omgbase/sync": patch
  omgbase: minor
crates:
  omgbase-surface: minor
  omgbase-sync: patch
  omgbase: minor
---
Minimal MCP tools profile (spec/surface 4.3, spec/cli 4.2). `omg mcp --tools <full|minimal>` (or the `mcp.tools` setting; a bad flag value is a usage error, a bad setting value is warned and `full` served) chooses which tools the server LISTS and ACCEPTS: `minimal` is ten tools — `docs_read`, `docs_tree`, `query_syntax`, `query`, `blocks_resolve`, `apply`, `plan`, `execute`, `changes_since`, `version` — and calling an unlisted one is the JSON-RPC error `-32602 unknown tool <name>`; semantics, schemas and fixtures are the profile-independent full catalog, filtered in registration order (`spec/surface/cases/profiles.json` pins both lists). `version` gains a last `profile` key (`"full"`/`"minimal"`; the CLI prints a `profile` line). The ten descriptions are rewritten as example ladders — a one-line summary, literal JSON rungs with a trailing comment, a last line naming `query_syntax` — and every rung is executed against the alchemy corpus by the new `spec/surface/cases/examples.json` suite, which a bytewise drift gate regenerates from the description text (`SURFACE_SPEC_UPDATE=1`), so a description cannot drift from what the engine does; `query`'s long-form prose moved into the `query_syntax` reference. Interop cases may carry `server_args` (reader only) and `{ method: "tools/list" }` steps, and record JSON-RPC errors as `{ rpc_error: { code, message } }` (`profile-minimal` is the 29th case, green in all four pairings). `omg --server` sugar verbs fall back to `apply { effects }` when the remote server does not list the sugar tool (a `#` locator among the refs is a usage error there, since resolution needs `blocks_resolve`); `@omgbase/sync`'s MCP engine client lists tools once per connection (`hasTool`).
