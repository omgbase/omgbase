// The command layer: a session-local undo/redo log over `OmgClient`.
//
// Three kinds of command. A `view` or `query` command changes client state only
// and carries its own `undo()` / `redo()` closures. A `repository` command
// writes through `apply`: its `apply(ctx)` performs the write and returns what
// it did (`Applied`: the receipts, the touched revisions, and whatever
// post-state its compensation needs); its `compensate(ctx, applied)` is asked
// at undo time to produce the inverse effects — and must re-check its
// preconditions against the repository's CURRENT state (re-read the block's
// hash, the document's revision) and `refuse` when the world moved on, because
// undo here is a new forward write, not a rollback. Redo re-runs `apply` with
// fresh preconditions the same way.
//
// The log keeps intent (the command) apart from what was applied (`Applied`),
// coalesces consecutive commands sharing a `coalesceKey` into one history entry
// (one drag = one command), serializes run/undo/redo, and reports honest states:
// `applied`, `partial` (a multi-step command stopped midway — see
// `PartialFailure`), `undone`, `failed` (nothing applied), `refused` (still
// applied; its compensation refused). Nothing is persisted.

import type { ApplyRequest, OmgClient, Receipt, Revision } from "./client.js";
import { isStale } from "./client.js";
import { setBlockAttr, setFrontmatter, unsetFrontmatter, type DocRef, type Effect } from "./effects.js";

export type CommandKind = "view" | "query" | "repository";

/** What a repository command needs of the client. `OmgClient` satisfies it; tests pass a stub. */
export type CommandClient = Pick<OmgClient, "apply" | "docsRead" | "query" | "call">;

export interface Progress {
  label: string;
  done: number;
  total: number;
  receipt?: Receipt;
}

export interface CommandContext {
  client: CommandClient;
  signal?: AbortSignal;
  /** Called by a multi-step command after each committed step. */
  report?: (progress: Progress) => void;
}

interface CommandBase {
  /** Supplied or minted by the log. */
  id?: string;
  label: string;
  /** Consecutive commands with the same key fold into one history entry. */
  coalesceKey?: string;
}

/** A command over client state: `redo()` is the forward action (run calls it first), `undo()` restores. */
export interface LocalCommand extends CommandBase {
  kind: "view" | "query";
  redo(): void | Promise<void>;
  undo(): void | Promise<void>;
}

/** What a repository command did: the receipts it committed, the revisions they touched, and its post-state `S`. */
export interface Applied<S = unknown> {
  receipts: Receipt[];
  revisions: Revision[];
  state: S;
}

export type Compensation = { effects: Effect[]; reason: string } | { refused: string };

export interface RepositoryCommand<S = unknown> extends CommandBase {
  kind: "repository";
  /** Perform the write. On redo, `run.previous` is what the first run applied. */
  apply(ctx: CommandContext, run: { redo: boolean; previous: Applied<S> | null }): Promise<Applied<S>>;
  /** The inverse, computed against the CURRENT state; `refused` when a precondition no longer holds. */
  compensate(ctx: CommandContext, applied: Applied<S>): Promise<Compensation>;
}

export type Command<S = unknown> = LocalCommand | RepositoryCommand<S>;

/** Thrown by a multi-step `apply` that committed some steps and then failed: the log records the entry as `partial`, undoable over `applied`. */
export class PartialFailure<S = unknown> extends Error {
  constructor(readonly applied: Applied<S>, override readonly cause: unknown, message = "the command was applied in part") {
    super(message);
    this.name = "PartialFailure";
  }
}

export type EntryState = "applied" | "partial" | "undone" | "failed" | "refused";

export interface Step {
  /** The intent. */
  command: Command;
  /** What it applied (null for a local command, or when it failed before writing). */
  applied: Applied | null;
}

export interface HistoryEntry {
  id: string;
  kind: CommandKind;
  label: string;
  at: string;
  coalesceKey: string | null;
  state: EntryState;
  /** The coalesced commands, in order; one for an ordinary command. */
  steps: readonly Step[];
  /** The last failure (a run, redo or undo that threw). */
  error: unknown;
  /** Why the last undo was refused (`state === "refused"`). */
  refusal: string | null;
  /** The undo's receipt (null: local, or nothing to commit). */
  compensation: Receipt | null;
  updatedAt: string;
}

export type LogEvent = { type: "run" | "undo" | "redo" | "seal" | "clear"; entry: HistoryEntry | null };
export type LogListener = (event: LogEvent, log: CommandLog) => void;

export interface CommandLogOptions {
  /** Oldest entries beyond this count are dropped (default 200). */
  limit?: number;
  now?: () => string;
  nextId?: () => string;
}

interface Entry extends HistoryEntry {
  steps: Step[];
  /** A sealed entry accepts no more coalescing (its group ended, or it was undone once). */
  sealed: boolean;
}

const UNDOABLE: ReadonlySet<EntryState> = new Set(["applied", "partial"]);

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class CommandLog {
  private entries: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<LogListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly limit: number;
  private readonly now: () => string;
  private readonly nextId: () => string;

  constructor(readonly ctx: CommandContext, opts: CommandLogOptions = {}) {
    this.limit = opts.limit ?? 200;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.nextId = opts.nextId ?? defaultId;
  }

  /** Every entry, oldest first (a snapshot of the list; entries are the live objects). */
  get history(): readonly HistoryEntry[] {
    return [...this.entries];
  }

  get canUndo(): boolean {
    return this.nextUndo !== null;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The entry `undo()` would take: the most recent applied (or partial) one. */
  get nextUndo(): HistoryEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) if (UNDOABLE.has(this.entries[i]!.state)) return this.entries[i]!;
    return null;
  }

  get nextRedo(): HistoryEntry | null {
    return this.redoStack[this.redoStack.length - 1] ?? null;
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Run a command: it becomes the newest history entry (or folds into the last one by `coalesceKey`); the redo stack is dropped. */
  run<S>(command: Command<S>): Promise<HistoryEntry> {
    return this.serial(async () => {
      this.redoStack = [];
      const cmd = command as Command;
      const last = this.entries[this.entries.length - 1];
      const coalesce = cmd.coalesceKey !== undefined && last !== undefined && !last.sealed && last.state === "applied" && last.kind === cmd.kind && last.coalesceKey === cmd.coalesceKey;
      const entry = coalesce ? last : this.newEntry(cmd);
      if (!coalesce) {
        this.entries.push(entry);
        while (this.entries.length > this.limit) this.entries.shift();
      }
      const step: Step = { command: cmd, applied: null };
      entry.steps.push(step);
      const ok = await this.forward(step, { redo: false, previous: null });
      this.settle(entry, ok);
      this.emit("run", entry);
      return entry;
    });
  }

  /** Undo the most recent applied entry. A repository entry's steps are compensated
   * in reverse — every compensation computed first, against current state — and
   * committed as ONE `apply`; one refusal refuses the whole undo and leaves the
   * entry applied (`state: "refused"`, off the undo path). */
  undo(): Promise<HistoryEntry | null> {
    return this.serial(async () => {
      const entry = this.nextUndo as Entry | null;
      if (!entry) return null;
      entry.sealed = true;
      entry.error = undefined;
      entry.refusal = null;
      try {
        if (entry.kind === "repository") {
          const effects: Effect[] = [];
          const reasons: string[] = [];
          for (const step of [...entry.steps].reverse()) {
            if (!step.applied) continue;
            const c = await (step.command as RepositoryCommand).compensate(this.ctx, step.applied);
            if ("refused" in c) {
              entry.state = "refused";
              entry.refusal = c.refused;
              this.touch(entry);
              this.emit("undo", entry);
              return entry;
            }
            effects.push(...c.effects);
            reasons.push(c.reason);
          }
          entry.compensation = effects.length > 0 ? await this.ctx.client.apply({ effects, reason: `undo: ${entry.label} — ${[...new Set(reasons)].join("; ")}` }) : null;
        } else {
          for (const step of [...entry.steps].reverse()) await (step.command as LocalCommand).undo();
          entry.compensation = null;
        }
        entry.state = "undone";
        this.redoStack.push(entry);
      } catch (e) {
        // A stale guard between the re-check and the commit is a refusal too;
        // anything else leaves the entry as it was, the error recorded.
        if (isStale(e)) {
          entry.state = "refused";
          entry.refusal = e.message;
        }
        entry.error = e;
      }
      this.touch(entry);
      this.emit("undo", entry);
      return entry;
    });
  }

  /** Redo the most recently undone entry: every step re-applied in order with fresh preconditions. */
  redo(): Promise<HistoryEntry | null> {
    return this.serial(async () => {
      const entry = this.redoStack.pop();
      if (!entry) return null;
      entry.error = undefined;
      entry.refusal = null;
      entry.compensation = null;
      let ok = true;
      for (const step of entry.steps) {
        const previous = step.applied;
        step.applied = null;
        ok = await this.forward(step, { redo: true, previous });
        if (!ok) {
          entry.error = step.applied ? entry.error : entry.error;
          break;
        }
      }
      this.settle(entry, ok);
      this.emit("redo", entry);
      return entry;
    });
  }

  /** End the current coalescing group: the next command with the same key starts a new entry. */
  seal(): void {
    const last = this.entries[this.entries.length - 1];
    if (last) last.sealed = true;
    this.emit("seal", last ?? null);
  }

  clear(): void {
    this.entries = [];
    this.redoStack = [];
    this.emit("clear", null);
  }

  // ---- internals ------------------------------------------------------------------

  private newEntry(cmd: Command): Entry {
    const at = this.now();
    return { id: cmd.id ?? this.nextId(), kind: cmd.kind, label: cmd.label, at, coalesceKey: cmd.coalesceKey ?? null, state: "failed", steps: [], error: undefined, refusal: null, compensation: null, updatedAt: at, sealed: false };
  }

  /** Run one step forward; true when it applied in full. Records `applied` on a partial failure and the error on the entry. */
  private async forward(step: Step, run: { redo: boolean; previous: Applied | null }): Promise<boolean> {
    const entry = this.entries.find((e) => e.steps.includes(step)) ?? this.redoStack.find((e) => e.steps.includes(step));
    try {
      if (step.command.kind === "repository") step.applied = await step.command.apply(this.ctx, run);
      else await step.command.redo();
      return true;
    } catch (e) {
      if (e instanceof PartialFailure) {
        step.applied = e.applied;
        if (entry) entry.error = e.cause;
      } else if (entry) entry.error = e;
      return false;
    }
  }

  /** The entry's state after a run or redo: applied; partial when something was applied; failed when nothing was. */
  private settle(entry: Entry, ok: boolean): void {
    if (ok) entry.state = "applied";
    else entry.state = entry.steps.some((s) => s.applied !== null) ? "partial" : "failed";
    if (!ok) entry.sealed = true;
    this.touch(entry);
  }

  private touch(entry: Entry): void {
    entry.updatedAt = this.now();
  }

  private emit(type: LogEvent["type"], entry: HistoryEntry | null): void {
    for (const l of this.listeners) l({ type, entry }, this);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---- two commands every Explorer needs ---------------------------------------------

/** A `view`/`query` command from two closures. */
export function localCommand(kind: "view" | "query", label: string, redo: () => void | Promise<void>, undo: () => void | Promise<void>, opts: { id?: string; coalesceKey?: string } = {}): LocalCommand {
  return { kind, label, redo, undo, ...opts };
}

/** The current `_hash` of a block, or null when it is gone. */
async function blockHash(client: CommandClient, blockId: string, repo?: string | null): Promise<string | null> {
  const r = await client.query(`blocks { select _hash where _id == ${JSON.stringify(blockId)} }`, { limit: 1, repo });
  const h = r.hits[0]?._hash;
  return typeof h === "string" ? h : null;
}

export interface TaskCheckState {
  /** The block's hash before the write (the guard of the forward write). */
  before: string;
  /** The block's hash the write produced (the guard of the compensation). */
  after: string | null;
  checked: boolean;
}

/** Check or uncheck a task block, pinned to its hash. The write is refused
 * (`stale_expectation`) when the block changed since it was read; the undo
 * re-reads the block and refuses when it is not the one the write produced. */
export function taskCheckCommand(input: { blockId: string; checked: boolean; contentHash: string; label?: string; repo?: string | null; coalesceKey?: string }): RepositoryCommand<TaskCheckState> {
  const { blockId, checked, repo } = input;
  const read = async (client: CommandClient, known: string | null): Promise<string> => {
    const h = known ?? (await blockHash(client, blockId, repo));
    if (h === null) throw new Error(`block ${blockId} is gone`);
    return h;
  };
  return {
    kind: "repository",
    label: input.label ?? `${checked ? "check" : "uncheck"} ${blockId}`,
    ...(input.coalesceKey !== undefined ? { coalesceKey: input.coalesceKey } : {}),
    async apply(ctx, run) {
      // The first run trusts the hash the UI read; a redo re-reads it.
      const before = await read(ctx.client, run.redo ? null : input.contentHash);
      const receipt = await ctx.client.apply({ effects: [setBlockAttr(blockId, "checked", checked, { contentHash: before })], reason: `${checked ? "check" : "uncheck"} task`, repo });
      const after = await blockHash(ctx.client, blockId, repo);
      return { receipts: [receipt], revisions: receipt.revisions, state: { before, after, checked } };
    },
    async compensate(ctx, applied) {
      const current = await blockHash(ctx.client, blockId, repo);
      if (current === null) return { refused: `block ${blockId} no longer exists` };
      if (applied.state.after !== null && current !== applied.state.after) return { refused: `block ${blockId} changed since (hash ${current}, expected ${applied.state.after})` };
      return { effects: [setBlockAttr(blockId, "checked", !checked, { contentHash: current })], reason: `${checked ? "uncheck" : "check"} task` };
    },
  };
}

export interface FrontmatterState {
  /** The document's revision the write was pinned to. */
  revision: string | null;
  /** The key's value before the write (`undefined`: absent). */
  previous: unknown;
  /** Whether the key existed before. */
  existed: boolean;
}

/** Set (or, with `value: undefined`, unset) one frontmatter key of a document.
 * The forward write re-reads the document (value and revision) and pins the
 * write to that revision; the undo re-reads again and refuses when the key no
 * longer holds the value the write put there. */
export function frontmatterCommand(input: { doc: DocRef; key: string; value: unknown; label?: string; repo?: string | null; coalesceKey?: string }): RepositoryCommand<FrontmatterState> {
  const { doc, key, value, repo } = input;
  const locator = typeof doc === "string" ? { _path: doc } : "kind" in doc ? ("_id" in doc ? { _id: doc._id } : { _path: doc._path }) : doc;
  const readDoc = async (client: CommandClient) => {
    const d = await client.docsRead(locator, { repo });
    const fm = d.properties.frontmatter ?? {};
    return { revision: d.rev, value: fm[key], existed: Object.prototype.hasOwnProperty.call(fm, key) };
  };
  const write = (v: unknown, revision: string | null): Effect =>
    v === undefined ? unsetFrontmatter(doc, key, revision ? { revision } : undefined) : setFrontmatter(doc, key, v, revision ? { revision } : undefined);
  return {
    kind: "repository",
    label: input.label ?? `${value === undefined ? "unset" : "set"} ${key}`,
    ...(input.coalesceKey !== undefined ? { coalesceKey: input.coalesceKey } : {}),
    async apply(ctx) {
      const before = await readDoc(ctx.client);
      const receipt = await ctx.client.apply({ effects: [write(value, before.revision)], reason: `${value === undefined ? "unset" : "set"} ${key}`, repo });
      return { receipts: [receipt], revisions: receipt.revisions, state: { revision: before.revision, previous: before.value, existed: before.existed } };
    },
    async compensate(ctx, applied) {
      const now = await readDoc(ctx.client);
      const same = value === undefined ? !now.existed : JSON.stringify(now.value) === JSON.stringify(value);
      if (!same) return { refused: `${key} no longer holds the value this command wrote (now ${JSON.stringify(now.value)})` };
      return { effects: [write(applied.state.existed ? applied.state.previous : undefined, now.revision)], reason: `restore ${key}` };
    },
  };
}

/** The `apply` request a compensation would send, for a confirm dialog. */
export function compensationRequest(c: Compensation, label: string): ApplyRequest | null {
  return "refused" in c ? null : { effects: c.effects, reason: `undo: ${label} — ${c.reason}` };
}
