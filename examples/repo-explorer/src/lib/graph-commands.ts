// The graph's local commands (`@omgbase/client` `LocalCommand`s over the model
// held by the page): a pin, an unpin, an expansion, a collapse. None of them touches the
// repository — a pin is presentation state, an expansion is a query whose
// result the model keeps — so each is a `view`/`query` command whose redo and
// undo swap the model through the accessor the page passes (a signal's
// get/set). Pointer movement during a drag is provisional; the pane emits ONE
// `graph-pin` on drop, and a pin command carries `coalesceKey: "pin:<path>"`
// so a run of drops on the same node folds into one history entry until the
// log is sealed.

import { localCommand, type LocalCommand } from "@omgbase/client";
import { setPin, type GraphModel, type Pin } from "./graph.ts";

/** How a command reads and replaces the page's model (a signal, a plain box, …). */
export interface ModelAccessor {
  get(): GraphModel;
  set(model: GraphModel): void;
}

export const pinKey = (path: string): string => `pin:${path}`;

/** Pin `path` at `pin`; undo restores `previous` (null: unpinned). One drag = one entry (`pin:<path>`). */
export function pinCommand(model: ModelAccessor, path: string, pin: Pin, previous: Pin | null): LocalCommand {
  const at = { x: pin.x, y: pin.y };
  const before = previous ? { x: previous.x, y: previous.y } : null;
  return localCommand("view", `pin ${path}`, () => model.set(setPin(model.get(), path, at)), () => model.set(setPin(model.get(), path, before)), { coalesceKey: pinKey(path) });
}

/** Release `path`'s pin so it settles back; undo re-pins it at `previous`. Not coalesced: a drag and its unpin are two steps. */
export function unpinCommand(model: ModelAccessor, path: string, previous: Pin | null): LocalCommand {
  const before = previous ? { x: previous.x, y: previous.y } : null;
  return localCommand("view", `unpin ${path}`, () => model.set(setPin(model.get(), path, null)), () => model.set(setPin(model.get(), path, before)));
}

/** Swap the whole model: `after` on redo, `before` on undo. */
export function modelSwapCommand(model: ModelAccessor, kind: "view" | "query", label: string, before: GraphModel, after: GraphModel): LocalCommand {
  return localCommand(kind, label, () => model.set(after), () => model.set(before));
}

/** An expansion (`withNeighborhood` + titles) as a `query` command. */
export function expandCommand(model: ModelAccessor, path: string, before: GraphModel, after: GraphModel): LocalCommand {
  return modelSwapCommand(model, "query", `expand ${path}`, before, after);
}

/** A collapse (`collapseNode`) as a `query` command. */
export function collapseCommand(model: ModelAccessor, path: string, before: GraphModel, after: GraphModel): LocalCommand {
  return modelSwapCommand(model, "query", `collapse ${path}`, before, after);
}

/** Dropping a node from the view (`removeNode`) as a `view` command. */
export function removeNodeCommand(model: ModelAccessor, path: string, before: GraphModel, after: GraphModel): LocalCommand {
  return modelSwapCommand(model, "view", `remove ${path} from the graph`, before, after);
}
