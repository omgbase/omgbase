// Loose nodes: documents on the canvas that are NOT among the query's rows — a
// document found through the palette, one just created, or a connector's
// destination picked (or created) on an empty drop. Each is one `docs { … }`
// query of its own (`looseNodeQuery`: the envelope, the title and the fields
// the current query projects under plain names, so its card reads like the
// others'), turned into a `GraphNode` flagged `loose` (`looseNode`) and merged
// after the rows (`withLoose`; a path the rows already carry is not doubled).
// They live in the page's own signal and are dropped when the query re-runs —
// the query is the contract for what is on the canvas; a loose node is a guest.

import type { Row } from "./candidates.ts";
import { graphNodes, type GraphNode } from "./graph-view.ts";
import { rooted, type EngineNames } from "./paths.ts";

/** A plain field name a `select` can spell as is (an alias or a computed item cannot be re-selected by its key). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The query that fetches one document as a row shaped like the current result:
 * `_id, _path, _title` and the projected fields that are plain names (deduped,
 * the envelope and the title not repeated; `$`-names and expressions dropped). */
export function looseNodeQuery(path: string, fields: readonly string[], names: EngineNames): string {
  const base = [names.id, names.path, names.title];
  const extra = [...new Set(fields)].filter((f) => IDENT.test(f) && !base.includes(f as EngineNames["id"]));
  return `docs { select ${[...base, ...extra].join(", ")} where ${names.path} == ${JSON.stringify(rooted(path))} }`;
}

/** The hit as a loose node; null when it carries no identity. */
export function looseNode(hit: Row): GraphNode | null {
  const n = graphNodes([hit])[0];
  return n && n.path ? { ...n, loose: true } : null;
}

/** The rows' nodes, then the loose ones not already among them (by rooted path), in the order they were added. */
export function withLoose(nodes: readonly GraphNode[], loose: readonly GraphNode[]): GraphNode[] {
  const shown = new Set(nodes.map((n) => n.path));
  const out = [...nodes];
  for (const l of loose) {
    if (shown.has(l.path)) continue;
    shown.add(l.path);
    out.push(l);
  }
  return out;
}

/** `loose` plus `node`, replacing an earlier entry for the same path. */
export function addLoose(loose: readonly GraphNode[], node: GraphNode): GraphNode[] {
  return [...loose.filter((l) => l.path !== node.path), node];
}
