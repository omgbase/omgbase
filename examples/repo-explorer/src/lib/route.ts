// The page's location: the hash holds what is open, so a document (and a
// revision of it) is a URL one can reload or share —
//   #doc=/processes/calcination.md
//   #doc=/processes/calcination.md&rev=r_7&tab=history
//   #doc=/processes/calcination.md&tab=graph     (the document's neighbourhood as a graph)
//   #graph=docs+%7B+select+_path+where+layer+%3D%3D+%22canon%22+%7D   (a QUERY's rows as a graph: no document open)
//   #deleted
// `parseRoute` / `routeHash` are inverse; unknown keys are dropped. The graph
// query is URL-encoded by URLSearchParams (a space is `+`, `/` stays readable).

export type Tab = "document" | "history" | "links" | "graph";

export interface Route {
  /** The open document's rooted path, or null for the welcome pane. */
  doc: string | null;
  /** A revision to show beside the current body (history). */
  rev: string | null;
  tab: Tab;
  /** The deleted-documents list instead of a document. */
  deleted: boolean;
  /** A block to scroll to (`#doc=…&block=b_12`). */
  block: string | null;
  /** An OQX query whose rows are shown as a graph instead of a document (`#graph=…`). */
  graphQuery: string | null;
}

export const DEFAULT_ROUTE: Route = { doc: null, rev: null, tab: "document", deleted: false, block: null, graphQuery: null };

const TABS: readonly Tab[] = ["document", "history", "links", "graph"];

export function parseRoute(hash: string): Route {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const tab = q.get("tab");
  const doc = q.get("doc");
  return {
    doc: doc ? `/${doc.replace(/^\/+/, "")}` : null,
    rev: q.get("rev") || null,
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : "document",
    deleted: q.has("deleted"),
    block: q.get("block") || null,
    graphQuery: q.get("graph")?.trim() || null,
  };
}

export function routeHash(r: Partial<Route>): string {
  const q = new URLSearchParams();
  if (r.deleted) q.set("deleted", "");
  if (r.doc) q.set("doc", r.doc);
  if (r.rev) q.set("rev", r.rev);
  if (r.tab && r.tab !== "document") q.set("tab", r.tab);
  if (r.block) q.set("block", r.block);
  if (r.graphQuery) q.set("graph", r.graphQuery);
  const s = q.toString().replace(/=(&|$)/g, "$1").replace(/%2F/g, "/");
  return s ? `#${s}` : "";
}

/** The route for opening a document (the tab kept when the same document is already open). */
export function openDocRoute(current: Route, path: string, opts: { keepTab?: boolean; block?: string | null } = {}): Route {
  const same = current.doc === path;
  return { doc: path, rev: null, tab: same && opts.keepTab !== false ? current.tab : "document", deleted: false, block: opts.block ?? null, graphQuery: null };
}

/** The route for a query's rows as a graph: the graph pane alone, no document open. */
export function graphRoute(query: string): Route {
  return { ...DEFAULT_ROUTE, graphQuery: query.trim() || null };
}
