---
npm:
  "@omgbase/core": patch
  omgbase: patch
---

`omg query '<grouped query>'` (no `--bare`, no `--json`) crashed on **every**
grouped query since `group by` shipped (oqx 0.24) — the default human-table
renderer unconditionally assumed the store envelope (`_id`/`_path`), which a
grouped row never carries (spec/surface §1.4: "a grouped row is not a store
row"). Found while writing the first tutorial page to actually exercise a
grouped query through the plain CLI path rather than `--json`/`--bare`/the
library directly.

Fixed: the default renderer now detects the missing envelope and falls back
to the same envelope-free table `--bare` already rendered correctly; `--ids`
and the JSON Lines `ids` field are correspondingly omitted for a grouped
result instead of filling in `undefined`. `HitLike._id`/`_path` are now
typed optional, matching reality.

Also fixed in `@omgbase/core`: `oqx-js/planner.ts`'s SQL-pushdown
raise-analysis (`exprMayRaise`) was missing a case for OQX 0.30's `present`
node, caught by `tsc`'s exhaustiveness check once the switch's fallback
path was exercised — mirrors the same gap already fixed in
`omgbase-surface`'s Rust twin when `?` shipped.
