// The `capability_unavailable` error (docs/modular-core/phase-1-contracts.md
// §2.1, D3) as the core raises it: a tool or a query reached a capability the
// store does not run with. Defined here — not in `mcp/errors.ts` — so the
// query binding (`oqx-js/context.ts`), the fusion ranker (`search/rrf.ts`) and
// the CLI can throw it without importing the surface; `mcp/errors.ts` renders it
// into the envelope `{ error: "capability_unavailable", message, data:
// { capability, state, fix? }, retriable }` (retriable only for `unavailable`).
//
// The semantic states this phase raises (README §6, resolution 1 of §7):
//   `disabled`    — the store runs without the semantic module (`Capabilities.
//                   semantic === null`): nothing can embed, score or rank.
//   `unavailable` — the module is here and a provider is configured, but the
//                   host could not start it (the embedder failed to spawn or to
//                   hand-shake); retriable once it is fixed.
// A module that IS present with no provider configured keeps the surface's
// 3.0 code `provider_unavailable` (spec/surface §4 pins its message and
// `data`), the alias of `disabled` for that composition — see `mcp/server.ts`.

export type CapabilityName = "history" | "semantic";
export type CapabilityState = "enabled" | "disabled" | "unavailable";

/** The history states a read can raise (phase-1-contracts §2.1): `outside_coverage` and `pruned` arrive with Phase 4b. */
export type HistoryReadState = "disabled" | "unavailable";

/** The pinned messages, byte for byte what the Rust twin spells. */
export const SEMANTIC_DISABLED_MESSAGE =
  "semantic search is disabled for this repository — configure an embedding provider (omg config set embedding.provider <command|url>) and embed the repository (omg embed drain)";
export const SEMANTIC_DISABLED_FIX = "omg config set embedding.provider <command|url>";

export function semanticUnavailableMessage(provider: string, reason: string): string {
  return `semantic search is unavailable — the configured embedding provider ${JSON.stringify(provider)} failed to start: ${reason}`;
}

export class CapabilityUnavailable extends Error {
  readonly code = "capability_unavailable" as const;
  readonly retriable: boolean;
  constructor(
    readonly capability: CapabilityName,
    readonly state: Exclude<CapabilityState, "enabled">,
    message: string,
    readonly extra: { fix?: string; provider?: string; reason?: string; rev?: string } = {},
  ) {
    super(message);
    this.name = "CapabilityUnavailable";
    this.retriable = state === "unavailable";
  }

  /** The envelope's `data` (spec/surface §2.1): the capability and its state, then what the caller can do. */
  data(): Record<string, unknown> {
    return {
      capability: this.capability,
      state: this.state,
      ...(this.extra.provider !== undefined ? { provider: this.extra.provider } : {}),
      ...(this.extra.reason !== undefined ? { reason: this.extra.reason } : {}),
      ...(this.extra.rev !== undefined ? { rev: this.extra.rev } : {}),
      ...(this.extra.fix !== undefined ? { fix: this.extra.fix } : {}),
    };
  }

  /**
   * A history read on a composition without the history module (phase-1-contracts
   * §2.1 `unavailable`, retriable): `docs_read { at }`, `docs_diff*`,
   * `docs_history`, `blocks_history` — Phase 4a.
   */
  static historyUnavailable(): CapabilityUnavailable {
    return new CapabilityUnavailable("history", "unavailable", HISTORY_UNAVAILABLE_MESSAGE);
  }

  /**
   * A history read on a repository whose manifest has capture `disabled` and
   * whose target was never captured (phase-1-contracts §2.1 `disabled`; Phase
   * 4a reads what WAS captured — a revision that has a row is served). `rev`
   * names the revision asked for, when one was.
   */
  static historyDisabled(rev?: string): CapabilityUnavailable {
    return new CapabilityUnavailable("history", "disabled", HISTORY_DISABLED_MESSAGE, rev !== undefined ? { rev } : {});
  }

  /** The semantic module is not part of this store's composition. */
  static semanticDisabled(): CapabilityUnavailable {
    return new CapabilityUnavailable("semantic", "disabled", SEMANTIC_DISABLED_MESSAGE, { fix: SEMANTIC_DISABLED_FIX });
  }

  /** A configured provider the host could not start (retriable). */
  static semanticUnavailable(provider: string, reason: string): CapabilityUnavailable {
    return new CapabilityUnavailable("semantic", "unavailable", semanticUnavailableMessage(provider, reason), { provider, reason });
  }

  /**
   * A writer without the history module on a repository whose manifest requires
   * capture (`writer_requires`, spec/store §5.4 step 0 — resolution 17):
   * `{ capability: "history", state: "unavailable" }`, retriable — an engine
   * carrying the module can. Unreachable through 17.0 (every composition
   * carries the recorder); the shape Phase 4 wires.
   */
  static historyWriterRequired(): CapabilityUnavailable {
    return new CapabilityUnavailable("history", "unavailable", HISTORY_WRITER_REQUIRED_MESSAGE);
  }
}

/** The refusal's message (resolution 17), byte for byte what the Rust twin spells. */
export const HISTORY_WRITER_REQUIRED_MESSAGE =
  "history capture is required on this repository (writer_requires) and this engine runs without the history module — write through an engine that carries it, or run omg history disable";

/** phase-1-contracts §2.1, byte for byte in both engines: a history read on a build without the module. */
export const HISTORY_UNAVAILABLE_MESSAGE = "history is unavailable in this build — run an engine with the history module to read it";
/** phase-1-contracts §2.1, byte for byte in both engines: a history read on a repository whose capture is off. */
export const HISTORY_DISABLED_MESSAGE =
  "history is disabled for this repository — enable it with `omg history enable` (reads of what was captured earlier still work)";

/**
 * Capture failed inside a commit (spec/store §5.4 step 15, 17.0 Phase 4a —
 * resolution 18): the recorder threw while writing its rows, so the member's
 * transaction is rolled back — nothing is written without its capture — the
 * `capture_failed` alert is raised by the transaction's owner once the
 * rollback is done (an alert raised inside would roll back with it), and the
 * next sweep retries. `path` is the member's (the owner fills it in when the
 * failing call did not know it — the commit row of a batch), `cause` the
 * recorder's error. Rendered as the envelope `capture_failed { path, reason }`,
 * retriable.
 */
export class CaptureFailed extends Error {
  readonly code = "capture_failed" as const;
  readonly retriable = true;
  path: string | null;
  readonly reason: string;
  constructor(path: string | null, override readonly cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(captureFailedMessage(path, reason));
    this.name = "CaptureFailed";
    this.path = path;
    this.reason = reason;
  }

  /** Name the member once the transaction's owner knows it (the message follows). */
  at(path: string): this {
    if (this.path === null) {
      this.path = path;
      this.message = captureFailedMessage(path, this.reason);
    }
    return this;
  }

  data(): Record<string, unknown> {
    return { ...(this.path !== null ? { path: this.path } : {}), reason: this.reason };
  }
}

/** The `capture_failed` message (the alert's and the envelope's), byte for byte in both engines. */
export function captureFailedMessage(path: string | null, reason: string): string {
  const where = path === null ? "a commit" : path;
  return `history capture of ${where} failed: ${reason} — the write was rolled back and is retried by the next sweep; fix the recorder or run omg history disable`;
}
