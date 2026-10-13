---
npm:
  "@omgbase/oqx": none
  "@omgbase/oqx-syntax": minor
  "@omgbase/core": patch
crates:
  oqx: none
  omgbase-surface: patch
  omgbase: patch
---
OQX 0.21: template literals. A backtick string with `${expr}` interpolations — `` `${title} (${era})` `` — is a primary expression whose value is the concatenation of its text and each interpolation's string form (the `+` rule): an absent interpolation makes the whole literal absent, a list, record or range is an evaluation error (`cannot interpolate …`), every interpolation is evaluated before the result is decided. Text decodes with the same escapes as a string literal (`` \` `` a backtick, `\$` a dollar that does not open an interpolation, `\\` a backslash), newlines are kept verbatim, an interpolation holds one full expression including nested literals and `{ … }` blocks. The canonical printer round-trips the form. Fifty fixtures in `spec/oqx/cases/template-literals.json`; the syntax package highlights the new token in every target grammar. Templates are never pushed down to SQL. Groundwork for the `-> expr` sugar in effect templates, where a string such as `-> `## ${title}`` reads the hit's row. (`@omgbase/oqx` and the `oqx` crate are bumped to 0.21.0 by hand with their own CHANGELOG entries, per the standalone-package convention, so this note records them as `none`.)
