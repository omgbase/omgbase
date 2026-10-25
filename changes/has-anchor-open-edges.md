---
npm:
  "@omgbase/core": patch
crates:
  omgbase-surface: patch
---
`has_anchor()` (OQX row method on blocks) answered true for a block whose anchored link had been edited away: both engines probed `edges` for `src_block = ? AND anchor IS NOT NULL` without the `to_commit IS NULL` filter every other edges reader applies, so a closed edge row still counted. Now `AND to_commit IS NULL`, byte for byte in both engines, pinned by `spec/surface` `reads::has-anchor-open-edges` (two anchored paragraphs, one rewritten without its link; `has_anchor()` names the other alone, agreeing with the open `links` rows). No shape changed; spec/surface 5.1 README §1.3 and §9 note it.
