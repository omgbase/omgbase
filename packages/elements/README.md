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
- `GraphViewEdge { key; from; to; label?; detail?; kind?; color?; style?: "solid" | "dotted" | "dashed"; pending?: "add" | "remove"; writable? }` —
  `detail` is the hover/provenance text; `kind` `frontmatter` / `body` /
  `external` have fixed styles, any other kind takes a deterministic palette
  colour (`edgeKindColor`) unless `color` names one outright (a host with its
  own palette per relationship); `pending` edges draw dashed and faded;
  `writable` edges may be ⌘-clicked away in `edgeToggle` mode.

### Card templates

`renderCard(template, row, fallback) → { label, lines, full }`; the default is
`DEFAULT_CARD = "{_title}"` — the element bakes in no display-property concept;
apps pass their own template (graph-ui's is `{card|_title}`: `card` is a bare
alias in the user's namespace, absent when a query does not project or compute
it). One template line per card line:

| syntax | meaning |
| --- | --- |
| `{field}` | `row.field`; `{a.b}` descends records |
| `{a\|b\|c}` | the first PRESENT alternative (not null / undefined / `""` / `[]`) |
| literal text | stays; a line with no placeholders always stays |
| a line whose placeholders are all absent | dropped (blank lines too) |
| a separator an absent placeholder leaves dangling | removed: `{layer} · {stage}` with `stage` absent is `canon`, not `canon ·`; `{a}, {b}, {c}` with `b` absent is `x, z`. Only the template's own separator-only text (`·-—–\|,:;/` with spaces) next to the gap is touched — a value keeps its glyphs (`/people/zoe.md`, `-5`), a word stays (`{_title} by {owner}` → `T by`) |
| values | strings as is (newlines collapsed), numbers/booleans/bigints as text, arrays `a, b, c`, a list of records `n items`, a record `{…}` |

The first kept line is the label (bold), the rest are detail lines; when every
line is dropped the label is `fallback`. `cardFields(template)` lists the
placeholders in order (what the host should project). A `CardText` a host builds
itself may give a detail line as `{ key, text }` (`CardLine`): it is drawn
`key: value` with the key dimmer and, when it must be cut to the card's width,
the key stays whole and the value takes the ellipsis (`lineText`,
`truncateLine`). Label fit (`sizeCard`,
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
| `card` | `card` | the template (default `{_title}`) |
| `renderCard` | — | `CardRenderer \| null`; wins over `card` |
| `labelFit` | `label-fit` | `truncate` \| `wrap` \| `expand` |
| `selected` | `selected` | the selected node id |
| `canWrite` | `canWrite` | connectors offered |
| `connectSource` | — | the host arms a connector from this node |
| `edgeStyle` | `edge-style` | `curved` (obstacle-routed Béziers, eased) \| `straight` |
| `layout` | `layout` | `force` \| `fixed` (positions from `positions`, no simulation) |
| `positions` | — | `Map<id, { x, y }>` for `fixed`; a node without one takes the force seed |
| `routes` | — | `Map<edge key, Point[]>` for `fixed`: an edge with a polyline here (elk's orthogonal bend points) is drawn along it — `polylineRoute` — instead of a routed Bézier; absent keys route as usual |
| `autoFit` | `auto-fit` | keep the graph fitted to the view — after each layout change, while the simulation settles, on resize — until the user pans or zooms; the fit button / `f` hands the camera back |
| `edgeToggle` | `edgeToggle` | ⌘/Ctrl-click toggles edges (graph-ui's gesture) |
| `toolbar` | `toolbar` | fit / 1:1 / edge style / label fit controls (default true) |

### Events (all bubble and compose; detail types exported)

`graph-select { id | null }`, `graph-open { id }`, `graph-expand { id }`,
`graph-collapse { id }`, `graph-pin { id, x, y, previous }`,
`graph-unpin { id, previous }`, `graph-connect { from, to }`,
`graph-connect-empty { from, x, y }`, `graph-edge-toggle { key?, from, to, present }`
(`present: true` an existing edge was ⌘-clicked; `false` a node was ⌘-clicked
with another selected), `graph-edge-select { key | null }`, `graph-hover { id | null }`
and `graph-edge-hover { key | null }` (the pointer entered / left a card or an
edge — for a host's own hover previews), `graph-view { k, tx, ty }`,
`graph-label-fit { labelFit }` (the toolbar's select changed it, so a host
sizing cards for an external layout can follow).

Keys: arrows select (or move the connector target), Enter opens (or confirms a
connector), `e` expands/collapses, `u`/Backspace unpins, `c` arms a connector,
`+`/`-`/`0` zoom, `f` fits, Esc cancels. Theming: `--omg-graph-accent`,
`--omg-graph-bg`, `--omg-graph-card-bg`, `--omg-graph-card-border`,
`--omg-graph-text`, `--omg-graph-muted`, `--omg-graph-font`,
`--omg-graph-external`, `--omg-graph-root-bg`.
