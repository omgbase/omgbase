---
npm:
  "@omgbase/core": minor
  omgbase: patch
crates:
  omgbase-properties: major
  omgbase-store: major
  omgbase-surface: patch
  omgbase: patch
---
**The stored computed property keys lose the `$` sigil: `$title`/`$tags` become
`_title`/`_tags`** (`spec/properties` 2.0, `spec/store` 18.0). `$` is reserved
for OQX's intrinsics, and storage was the last place omgbase still spent it —
both engines wrote `source = 'computed'` rows keyed `$title`/`$tags` and the
surface re-keyed them to `_title`/`_tags` at the tool boundary. Now the stored
key is the surfaced name and that translation is gone, so a computed property is
spelled one way from the row to the result.

A major rather than a minor because `prop_id` hashes the key
(`spec/properties` §1), so every computed row's identity moves with it. The DDL
does **not** change: `properties.key` carries no CHECK and the schema
fingerprint is PRAGMA-derived, so the column's comment lies outside it.

- **Migration 18** (`spec/store` §3.4 step 18) rewrites the rows of an existing
  database and re-derives each `prop_id`. It is programmatic, since stock SQLite
  has no `sha256`, and idempotent. **Scoped to `source = 'computed'` alone:** an
  authored key beginning with `$` is the user's own and is stored verbatim
  (reached as `_frontmatter.$x`), so a blanket `key LIKE '$%'` rewrite would
  corrupt it — `spec/store/cases/migrations.json`'s
  `v17-to-v18-computed-keys-lose-the-sigil` pins both halves: the computed rows
  re-keyed with new ids, and authored `$title`/`_title`/`title` rows untouched,
  key and `prop_id` alike.
- **The boundary re-keying is deleted** in both engines (`surfaceProperties` /
  `surface_properties`); `docs_read`'s `properties.computed` is the grouped shape
  verbatim. The surface's output is byte-identical, so `spec/surface` does not
  move.
- **Fixed, caught by `spec/cli`:** `omg show` subtracted the computed rows from
  the merged properties bag with a `!k.startsWith("$")` filter, which the rename
  silently defeated — `_title` was rendered twice, once under `properties` and
  again under `computed`. Both engines now subtract them by name, from the
  `properties.computed` group itself.
- `@omgbase/core`'s exported `docPropertiesMerged` returns the stored keys, so
  its computed entries are now `_title`/`_tags` — a breaking change for a
  library caller that reads them.
- Also corrected while here: `spec/properties`' header still claimed the surface
  reads the computed rows as the **bare** `title`/`tags`, a spelling two majors
  out of date, and the `newer-version-is-refused` migration fixture was pinned
  to `user_version: 18`, which the bump would have turned from a refusal into a
  successful open — it is now 19.
