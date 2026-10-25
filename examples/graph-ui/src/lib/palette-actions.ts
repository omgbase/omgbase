// The palette's `>` actions — the controls this page already has, as a list
// `<omg-palette>` can filter (`filterActions` in @omgbase/elements/palette):
// run the query, fit, the layout algorithm, the label fit, the edge style, arm /
// disarm a relationship for ⌘-click edits, the confirm strip, undo / redo,
// create, the starter, reconnect. Pure: the page passes its state in and
// dispatches on the ids (`app.ts` `runPaletteAction`). Ids with a colon carry
// their argument: `layout:stress`, `label-fit:wrap`, `arm:after`.

import type { EdgeStyle, LabelFit } from "@omgbase/elements/graph";
import { LABEL_FITS } from "@omgbase/elements/graph";
import type { PaletteAction } from "@omgbase/elements/palette";
import { LAYOUT_ALGORITHMS, type LayoutAlgorithm } from "./view.ts";

export interface PaletteState {
  /** The server answered `version` and the query can run. */
  connected: boolean;
  /** `apply` is offered and the server speaks the writes' surface. */
  canWrite: boolean;
  /** The editor holds a parsed query. */
  hasQuery: boolean;
  /** The layout in effect. */
  algorithm: LayoutAlgorithm;
  labelFit: LabelFit;
  edgeStyle: EdgeStyle;
  /** The relationship armed for ⌘-click edits, and the ones that could be. */
  armed: string | null;
  writable: readonly string[];
  /** The confirm strip before every write. */
  confirm: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export function paletteActions(s: PaletteState): PaletteAction[] {
  const out: PaletteAction[] = [];
  if (s.connected && s.hasQuery) out.push({ id: "run", label: "run the query again", hint: "re-reads the rows and the edges; drops loose nodes", keywords: ["refresh", "rerun", "query", "reload"] });
  out.push({ id: "fit", label: "fit the graph to the view", shortcut: "f", keywords: ["zoom", "camera", "centre", "center"] });
  if (s.canWrite) out.push({ id: "create", label: "new document…", hint: "created with a title heading and added to the graph as a loose node", shortcut: "+", keywords: ["create", "add", "note"] });
  if (s.undoLabel) out.push({ id: "undo", label: s.undoLabel, shortcut: "⌘Z" });
  if (s.redoLabel) out.push({ id: "redo", label: s.redoLabel, shortcut: "⇧⌘Z" });
  for (const a of LAYOUT_ALGORITHMS) {
    if (a.value === s.algorithm) continue;
    out.push({ id: `layout:${a.value}`, label: `lay out: ${a.label}`, hint: a.hint, keywords: ["layout", "algorithm", a.value] });
  }
  out.push({ id: "layout:auto", label: "lay out: auto", hint: "layered along the axis relationship, force without one", keywords: ["layout", "algorithm", "default"] });
  for (const fit of LABEL_FITS) if (fit !== s.labelFit) out.push({ id: `label-fit:${fit}`, label: `label fit: ${fit}`, keywords: ["cards", "title", "ellipsis", "wrap"] });
  out.push({ id: "edge-style", label: `edges: ${s.edgeStyle === "curved" ? "straight" : "curved"}`, hint: s.edgeStyle === "curved" ? "straight segments instead of routed curves" : "obstacle-aware curves instead of straight segments", keywords: ["edge", "style", "straight", "curved", "lines"] });
  if (s.canWrite) {
    if (s.armed) out.push({ id: "disarm", label: `stop editing \`${s.armed}\``, hint: "⌘-click no longer toggles its edges", keywords: ["edit", "arm", "disarm", s.armed] });
    for (const name of s.writable) if (name !== s.armed) out.push({ id: `arm:${name}`, label: `edit \`${name}\` edges`, hint: "arm it: ⌘-click a node with another selected toggles the edge", keywords: ["edit", "arm", "toggle", name] });
    out.push({ id: "confirm", label: s.confirm ? "write edge edits without confirming" : "confirm every edge edit before writing", keywords: ["confirm", "strip", "settings"] });
  }
  out.push({ id: "starter", label: "show recent documents", hint: "the starter query: the 40 most recently updated documents and their links", keywords: ["starter", "recent", "default"] });
  out.push({ id: "reconnect", label: "reconnect", keywords: ["version", "tools", "server"] });
  return out;
}

/** An action id's argument, after the colon (`layout:stress` → `stress`); null without one. */
export function actionArgument(id: string, prefix: string): string | null {
  return id.startsWith(`${prefix}:`) ? id.slice(prefix.length + 1) : null;
}
