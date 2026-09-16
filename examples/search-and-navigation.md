<!-- recital include: ./_fragments/attached-alchemy.md -->

# Search & navigation

Once a repo is attached you rarely know a document's exact path. These commands
get you from a vague idea to the precise block you want: **find** it, **outline**
it, **show** its metadata, and follow its **links**.

> Starts from an already-attached `alchemy` repo (see
> [getting-started.md](./getting-started.md)).

## `omg find` — ranked search

`find` runs a full-text search and returns ranked hits as `<id>  <locator>
<preview>`. Only mercury's page mentions "quicksilver", so there's one hit:

```console
$ omg find "quicksilver"
b_qm3p1az  substances/mercury.md#paragraph[1]  Quicksilver: a metal that is liquid at room temperature, and therefore the…
```

The locator (`substances/mercury.md#paragraph[1]`) is for your eyes; the id is
for follow-up commands. `-1` prints just the top hit's id, which makes `find`
compose into other commands:

```console
$ omg find "calcination" -1
b_gd7vw2q
$ omg cat "$(omg find "calcination" -1)"
# Calcination
```

## `omg outline` — a document's skeleton

`outline` prints the block tree in a frozen wire format: each line is
`<id> <type> <text>`, headings marked with `§`. It's the fastest way to see a
document's shape and grab the id of a block to act on:

```console
$ omg outline substances/sulphur.md
  omgbase  >  substances/sulphur.md
  ----------------------------------------
b_s1u1phr h1   Sulphur  §
b_br1mst0 p    Brimstone: yellow, brittle, and burns with a blue flame and…
b_sym8fld p    symbol:: 🜍 melting_point:: 115.2 toxic:: mildly
b_pr1nc9l h2   As a principle  §
b_soul4kb p    Sulphur is the soul — the combustible principle, what makes…
b_mrc2slf p    In the mercury–sulphur theory inherited from [Jabir ibn Hayyan](/practitioners/jabir-ibn-hayyan.md), every…
b_mat3r1l h2   As a material  §
b_cmb5nds p    Sulphur combines directly with most metals on heating, producing sulphides…
```

## `omg show` — the metadata card

Where `cat` gives bytes and `outline` gives structure, `show` gives the derived
metadata: frontmatter and inline (`key:: value`) properties, plus the document's
open edges. Mercury declares a symbol, a melting point, its toxicity, and links
out to other pages:

```console
$ omg show substances/mercury.md
  omgbase  >  substances/mercury.md
  ----------------------------------------
  properties
    symbol = ☿
    melting_point = -38.8
    toxic = yes
    type = substance
    slug = mercury
    layer = canon
    tradition = western
    element = mercury
    tags = substance
    verified = true
    $title = Mercury
  out edges
...
```

## `omg links` — the citation graph

`links --in` are backlinks: which documents point *at* this one. Five documents
cite the magnum opus (the grand work that ties the corpus together):

```console
$ omg links processes/magnum-opus.md --in
  in (backlinks)
    d_lk1a2b3 > references ×1
    d_lk2c4d5 > references ×1
    d_lk3e6f7 > references ×1
    d_lk4g8h9 > references ×1
    d_lk5i0j1 > references ×1
```

`links` without a direction shows both in- and out-edges; `--out` shows only the
documents this one cites. For transitive reach (a document's whole citation
closure), use OQX `follow` — see
[oqx-tutorial/graph-traversal.md](./oqx-tutorial/graph-traversal.md).
