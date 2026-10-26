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
    readonly extra: { fix?: string; provider?: string; reason?: string } = {},
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
      ...(this.extra.fix !== undefined ? { fix: this.extra.fix } : {}),
    };
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
