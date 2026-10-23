// Edge editing — the I/O half. Reads the owner's current field value (from the
// row when the query projected the field, else `docs_read`, which also yields
// the document's revision), writes the patch with `apply` (the one write tool
// of the minimal profile: `set` / `unset` effects on `_frontmatter.<key>`), and
// serializes writes per document so two quick toggles on one document cannot
// race. When the value came from a `docs_read`, the write carries
// `expect: { revision }` — the compare-and-swap `docs_set_meta` never had: a
// document that moved on in between fails `stale_plan` ("document … is at
// revision r_…, not r_…; re-plan") instead of being overwritten.

import type { Row } from "./candidates.ts";
import { frontmatterEffects, planToggle, type DocRef, type FrontmatterEffect, type Patch, type RefForm, type ToggleOptions } from "./edit.ts";

/** The two tools this module needs; `OmgClient` implements them (the client
 * adds the server-spelled document target to each effect). */
export interface MetaClient {
  docsRead(doc: string, repo?: string): Promise<{ rev?: unknown; properties?: { frontmatter?: Record<string, unknown> } }>;
  applyFrontmatter(doc: string, effects: FrontmatterEffect[], repo?: string): Promise<unknown>;
}

/** One in-flight chain per key: `run` waits for the previous job on the same key. */
export class PerKeyQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    // The chain never rejects (a failed job must not poison the next one).
    const tail = next.then(() => undefined, () => undefined).then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.tails.set(key, tail);
    return next;
  }

  /** Keys with work in flight. */
  get busy(): string[] {
    return [...this.tails.keys()];
  }
}

/** The owner's current value for `field` and, when it was read from the
 * document, the document's revision (the CAS for the write): the row's value
 * when the query projected the field (an absent key then means the document
 * has no such field; no revision is known), else a `docs_read` of the owner so
 * the toggle never clobbers what the query did not select. */
export async function readFieldValue(
  client: Pick<MetaClient, "docsRead">,
  owner: DocRef,
  field: string,
  row: Row | undefined,
  projected: boolean,
  repo?: string,
): Promise<{ value: unknown; revision: string | null }> {
  if (projected && row) return { value: row[field], revision: null };
  const doc = await client.docsRead(owner.path || owner.id, repo);
  return { value: doc.properties?.frontmatter?.[field], revision: typeof doc.rev === "string" ? doc.rev : null };
}

/** `readFieldValue`'s value alone. */
export async function currentFieldValue(
  client: Pick<MetaClient, "docsRead">,
  owner: DocRef,
  field: string,
  row: Row | undefined,
  projected: boolean,
  repo?: string,
): Promise<unknown> {
  return (await readFieldValue(client, owner, field, row, projected, repo)).value;
}

export interface TogglePlan {
  owner: DocRef;
  /** The document the field refers to (or stops referring to). */
  target: DocRef;
  field: string;
  /** What the UI believed before planning. */
  present: boolean;
  previous: unknown;
  /** The owner's revision when the value was read from the document (the write's CAS), else null. */
  revision: string | null;
  patch: Patch;
  /** The `apply` effects (without their target), or null when nothing is written. */
  effects: FrontmatterEffect[] | null;
}

export interface PlanInput {
  owner: DocRef;
  target: DocRef;
  field: string;
  present: boolean;
  form: RefForm;
  options: ToggleOptions;
  /** The owner's row, when shown. */
  row: Row | undefined;
  projected: boolean;
  repo?: string;
}

export async function prepareToggle(client: Pick<MetaClient, "docsRead">, input: PlanInput): Promise<TogglePlan> {
  const { value: previous, revision } = await readFieldValue(client, input.owner, input.field, input.row, input.projected, input.repo);
  const patch = planToggle(previous, input.target, input.present, input.form, input.options);
  return { owner: input.owner, target: input.target, field: input.field, present: input.present, previous, revision, patch, effects: frontmatterEffects(input.field, patch, revision) };
}

/** Write the plan (no-ops and refusals resolve without a call). */
export function applyToggle(client: Pick<MetaClient, "applyFrontmatter">, queue: PerKeyQueue, plan: TogglePlan, repo?: string): Promise<unknown> {
  if (!plan.effects) return Promise.resolve(null);
  const effects = plan.effects;
  return queue.run(plan.owner.path || plan.owner.id, () => client.applyFrontmatter(plan.owner.path || plan.owner.id, effects, repo));
}

const DENIED = /not (found|allowed|permitted|enabled|available)|unknown tool|denied|forbidden|allowlist|not in the allow|-3260[12]/i;
/** The engine's answer to a failed `expect.revision`: `stale_plan` ("document … is at revision r_…, not r_…; re-plan"). */
const STALE = /stale_plan|stale_expectation|is at revision/i;

/** A message for a failed write; a refusal that smells like a gateway's tool
 * policy says so, since that is the usual cause in proxy/direct mode, and a
 * stale revision (the document changed since it was read) says to retry. */
export function describeMutationError(e: unknown, tool = "apply"): string {
  const msg = e instanceof Error ? e.message : String(e);
  const codeOf = (e as { code?: unknown } | null)?.code;
  const code = typeof codeOf === "string" ? codeOf : "";
  if (DENIED.test(msg)) {
    return `${tool} was refused (${msg}) — when omgbase sits behind a gateway, its tool allowlist must include ${tool}`;
  }
  if (tool === "apply" && (STALE.test(code) || STALE.test(msg))) {
    return `${msg} — the document changed since it was read; the graph has been refreshed, try the toggle again`;
  }
  return msg;
}
