// Edge editing — the I/O half. Reads the owner's current field value (from the
// row when the query projected the field, else `docs_read`), writes the patch
// with `docs_set_meta`, and serializes writes per document so two quick toggles
// on one document cannot race (there is no CAS on `docs_set_meta`: the server
// merges `set`/`unset` into whatever the file holds at that moment).

import type { Row } from "./candidates.ts";
import { planToggle, setMetaArgs, type DocRef, type Patch, type RefForm, type ToggleOptions } from "./edit.ts";

/** The two tools this module needs; `OmgClient` implements it. */
export interface MetaClient {
  docsRead(doc: string, repo?: string): Promise<{ properties?: { frontmatter?: Record<string, unknown> } }>;
  docsSetMeta(doc: string, patch: { set?: Record<string, unknown>; unset?: string[] }, repo?: string): Promise<unknown>;
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

/** The owner's current value for `field`: the row's when the query projected
 * the field (an absent key then means the document has no such field), else a
 * `docs_read` of the owner so the toggle never clobbers what the query did not
 * select. */
export async function currentFieldValue(
  client: Pick<MetaClient, "docsRead">,
  owner: DocRef,
  field: string,
  row: Row | undefined,
  projected: boolean,
  repo?: string,
): Promise<unknown> {
  if (projected && row) return row[field];
  const doc = await client.docsRead(owner.path || owner.id, repo);
  return doc.properties?.frontmatter?.[field];
}

export interface TogglePlan {
  owner: DocRef;
  /** The document the field refers to (or stops referring to). */
  target: DocRef;
  field: string;
  /** What the UI believed before planning. */
  present: boolean;
  previous: unknown;
  patch: Patch;
  args: { set: Record<string, unknown> } | { unset: string[] } | null;
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
  const previous = await currentFieldValue(client, input.owner, input.field, input.row, input.projected, input.repo);
  const patch = planToggle(previous, input.target, input.present, input.form, input.options);
  return { owner: input.owner, target: input.target, field: input.field, present: input.present, previous, patch, args: setMetaArgs(input.field, patch) };
}

/** Write the plan (no-ops and refusals resolve without a call). */
export function applyToggle(client: Pick<MetaClient, "docsSetMeta">, queue: PerKeyQueue, plan: TogglePlan, repo?: string): Promise<unknown> {
  if (!plan.args) return Promise.resolve(null);
  const args = plan.args;
  return queue.run(plan.owner.path || plan.owner.id, () => client.docsSetMeta(plan.owner.path || plan.owner.id, args, repo));
}

const DENIED = /not (found|allowed|permitted|enabled|available)|unknown tool|denied|forbidden|allowlist|not in the allow|-3260[12]/i;

/** A message for a failed write; a refusal that smells like a gateway's tool
 * policy says so, since that is the usual cause in proxy/direct mode. */
export function describeMutationError(e: unknown, tool = "docs_set_meta"): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (DENIED.test(msg)) {
    return `${tool} was refused (${msg}) — when omgbase sits behind a gateway, its tool allowlist must include ${tool}`;
  }
  return msg;
}
