# @omgbase/elements

Reusable Lit elements for OMGbase explorers — the "package the elements" step of
the Explorer brief. The first element is `<omg-graph>`: a renderer-neutral graph
model (nodes with a row of projected fields, edges with provenance) drawn as
cards whose content is a **card template** over the row, with edges routed as
obstacle-aware Bézier curves, pins and spring settling, progressive expansion
and collapse, zoom and pan, a connector gesture, and a `fixed` layout mode that
takes positions from an external layout (elk) instead of the force simulation.
Shared by `examples/repo-explorer` (neighbourhood graphs over `links`) and
`examples/graph-ui` (an OQX query's rows with inferred relationships).

Browser-only and engine-free: the elements render what a client fetched and
emit events for what the user did; the page (or `@omgbase/client`) does every
read and write.

## `<omg-graph>`

```ts
import "@omgbase/elements";                 // registers <omg-graph>
import { renderCard, cardFields, edgePath } from "@omgbase/elements/graph";  // the pure half
```

### The view model (`@omgbase/elements/graph`)

- `GraphViewNode { id; row; kind?: "document" | "external" | string; pinned: { x, y } | null; expandable?; expanded?; truncated?: number; emphasis?: "root" | null; tooltip? }` —
  `id` is opaque to the element (a path, a row id); `row` is the projected record
  the card reads; `external` draws dashed and is never expandable; `truncated`
  shows "+k more"; `pinned` is presentation state the host owns.
- `GraphViewEdge { key; from; to; label?; detail?; kind?; style?: "solid" | "dotted" | "dashed"; pending?: "add" | "remove"; writable? }` —
  `detail` is the hover/provenance text; `kind` `frontmatter` / `body` /
  `external` have fixed styles, any other kind takes a deterministic palette
  colour (`edgeKindColor`); `pending` edges draw dashed and faded; `writable`
  edges may be ⌘-clicked away in `edgeToggle` mode.

### Card templates

`renderCard(template, row, fallback) → { label, lines, full }`; the default is
`DEFAULT_CARD = "{_display|_title}"` (so an engine-computed `_display` wins with
no configuration). One template line per card line:

| syntax | meaning |
| --- | --- |
| `{field}` | `row.field`; `{a.b}` descends records |
| `{a\|b\|c}` | the first PRESENT alternative (not null / undefined / `""` / `[]`) |
| literal text | stays; a line with no placeholders always stays |
| a line whose placeholders are all absent | dropped (blank lines too) |
| values | strings as is (newlines collapsed), numbers/booleans/bigints as text, arrays `a, b, c`, a list of records `n items`, a record `{…}` |

The first kept line is the label (bold), the rest are detail lines; when every
line is dropped the label is `fallback`. `cardFields(template)` lists the
placeholders in order (what the host should project). Label fit (`sizeCard`,
`wrapLabel`, `canvasMeasure`): `truncate` one line with an ellipsis, `wrap`
several lines within the card's width (up to 4), `expand` widens the card to the
label (up to 480 px) then wraps; the measured size feeds collision, hit-testing,
arrow endpoints and edge routing.

`renderCard` (the element property, `CardRenderer`) replaces the template per
node: return a template string (a template per `row.type`, say), a `CardText`,
or a Lit `html\`…\`` — the latter is drawn inside the card in a
`<foreignObject>` (`.card-html` wrapper, inherits the custom properties,
measured after render; `--omg-graph-card-pointer-events: auto` makes it
interactive, by default the card underneath takes the pointer). The card group
exposes `part="card"`.

### Properties

| property | attribute | meaning |
| --- | --- | --- |
| `nodes`, `edges` | — | the view model |
| `card` | `card` | the template (default `{_display|_title}`) |
| `renderCard` | — | `CardRenderer \| null`; wins over `card` |
| `labelFit` | `label-fit` | `truncate` \| `wrap` \| `expand` |
| `selected` | `selected` | the selected node id |
| `canWrite` | `canWrite` | connectors offered |
| `connectSource` | — | the host arms a connector from this node |
| `edgeStyle` | `edge-style` | `curved` (obstacle-routed Béziers, eased) \| `straight` |
| `layout` | `layout` | `force` \| `fixed` (positions from `positions`, no simulation) |
| `positions` | — | `Map<id, { x, y }>` for `fixed`; a node without one takes the force seed |
| `edgeToggle` | `edgeToggle` | ⌘/Ctrl-click toggles edges (graph-ui's gesture) |
| `toolbar` | `toolbar` | fit / 1:1 / edge style / label fit controls (default true) |

### Events (all bubble and compose; detail types exported)

`graph-select { id | null }`, `graph-open { id }`, `graph-expand { id }`,
`graph-collapse { id }`, `graph-pin { id, x, y, previous }`,
`graph-unpin { id, previous }`, `graph-connect { from, to }`,
`graph-connect-empty { from, x, y }`, `graph-edge-toggle { key?, from, to, present }`
(`present: true` an existing edge was ⌘-clicked; `false` a node was ⌘-clicked
with another selected), `graph-edge-select { key | null }`, `graph-view { k, tx, ty }`.

Keys: arrows select (or move the connector target), Enter opens (or confirms a
connector), `e` expands/collapses, `u`/Backspace unpins, `c` arms a connector,
`+`/`-`/`0` zoom, `f` fits, Esc cancels. Theming: `--omg-graph-accent`,
`--omg-graph-bg`, `--omg-graph-card-bg`, `--omg-graph-card-border`,
`--omg-graph-text`, `--omg-graph-muted`, `--omg-graph-font`,
`--omg-graph-external`, `--omg-graph-root-bg`.
