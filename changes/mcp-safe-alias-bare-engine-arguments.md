---
npm:
  "@omgbase/core": minor
  omgbase: minor
  "@omgbase/sync": none
crates:
  omgbase-surface: minor
---
`spec/surface` 6.6: a bare `id`/`path`/`ids`/`paths` MCP tool argument (e.g.
`docs_read { path }` instead of `{ _path }`) now runs as the corrected
`_`-spelled call instead of being refused outright. The result carries a new
`argument_corrections` array naming the mistake and asking the caller to use
the `_` spelling henceforth, so a client that reads results is taught without
a wasted round trip. The one case still refused exactly as before (surface
5.0's "no tolerance") is a real collision — the call gives *both* the bare
and the `_` form — since silently picking one would mean guessing the
caller's intent rather than fixing an obvious typo. The retired `doc`/`block`/
`node` arguments are unaffected: still refused, never aliased (ambiguous
which engine field they'd mean).

Motivated by repeated real-world agent mistakes against `docs_read`'s
`_path` argument (the omgbase-notes "OMG MCP complaints" log): the 5.0
refusal already carried the fix in `data.fix`, but agents kept re-making the
same mistake across sessions rather than acting on it.
