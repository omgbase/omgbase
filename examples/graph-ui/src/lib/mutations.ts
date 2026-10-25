// Edge editing — the I/O half, as COMMANDS on `@omgbase/client`'s `CommandLog`
// (so every toggle has a compensating undo). Two paths:
//
//   - the COMMON case — the field spells its references as `/`-rooted `.md`
//     paths, holds a list (or nothing yet), and an emptied list is unset — is
//     exactly the shared `attachRelationCommand` / `detachRelationCommand`
//     (`sharedCommandFits`): additive attach, the list without the target on
//     detach, the write pinned to the owner's revision, the undo refused when
//     the field no longer holds what the write produced;
//   - everything the shared commands cannot express keeps this demo's own
//     builder (`formToggleCommand` over lib/edit.ts `planToggle`): a field
//     spelled in another FORM (bare `timeline/beta.md`, `timeline/beta` without
//     `.md`, or doc ids `d_…` — the shared commands write rooted paths and
//     would mix forms, which this demo refuses), a SCALAR field (a `/people/…`
//     `owner` is replaced, not turned into a list), and the *emptied list →
//     keep `[]`* setting. It follows the same contract: re-read the owner
//     inside `apply` (fresh preconditions on redo), pin the write to the
//     revision, re-read on undo and refuse unless the field still holds the
//     written value.
//
// `prepareToggle` is the confirm strip's half: it reads the owner's current
// value (`docs_read`; a toggle never clobbers values the query did not select)
// and names the exact patch — a stale belief is a `noop`, not a wrong write.

import {
  OmgError, attachRelationCommand, describeDetach, describeRelation, detachRelationCommand, isStale, setFrontmatter, unsetFrontmatter,
  type Applied, type CommandClient, type Compensation, type RepositoryCommand,
} from "@omgbase/client";
import { DEFAULT_FORM, describeForm, describePatch, planToggle, sameForm, type DocRef, type EmptyListBehavior, type Patch, type RefForm, type Shape, type ToggleOptions } from "./edit.ts";
import { rooted } from "./paths.ts";

/** What the reads here need of the client (`OmgClient` satisfies it; tests pass a stub). */
export type FieldReader = Pick<CommandClient, "docsRead">;

export interface FieldState {
  value: unknown;
  /** Whether the key is present at all (`value` is `undefined` either way for an absent one). */
  existed: boolean;
  /** The owner's revision at read time — the write's CAS. */
  revision: string | null;
}

/** The owner's current value for `field` and the document's revision, from one `docs_read`. */
export async function readField(client: FieldReader, owner: Pick<DocRef, "path">, field: string, repo?: string | null): Promise<FieldState> {
  const d = await client.docsRead({ _path: rooted(owner.path) }, { repo });
  const fm = d.properties?.frontmatter ?? {};
  return { value: fm[field], existed: Object.prototype.hasOwnProperty.call(fm, field), revision: typeof d.rev === "string" ? d.rev : null };
}

export interface TogglePlan {
  owner: DocRef;
  /** The document the field refers to (or stops referring to). */
  target: DocRef;
  field: string;
  /** What the UI believed before planning. */
  present: boolean;
  previous: unknown;
  /** The owner's revision when the value was read (the write's CAS). */
  revision: string | null;
  patch: Patch;
}

export interface PlanInput {
  owner: DocRef;
  target: DocRef;
  field: string;
  present: boolean;
  form: RefForm;
  options: ToggleOptions;
  repo?: string | null;
}

/** Read the owner, name the patch. */
export async function prepareToggle(client: FieldReader, input: PlanInput): Promise<TogglePlan> {
  const { value: previous, revision } = await readField(client, input.owner, input.field, input.repo);
  const patch = planToggle(previous, input.target, input.present, input.form, input.options);
  return { owner: input.owner, target: input.target, field: input.field, present: input.present, previous, revision, patch };
}

// ---- the command ---------------------------------------------------------------------

export interface ToggleCommandInput {
  owner: DocRef;
  target: DocRef;
  field: string;
  /** Whether the edge is drawn now: true → remove it, false → add it. */
  present: boolean;
  form: RefForm;
  shape: Shape;
  emptyListBehavior: EmptyListBehavior;
  repo?: string | null;
}

/** Is this toggle exactly a shared attach / detach? Rooted `.md` paths, a list
 * (or no value yet), and an emptied list unset — the only semantics the shared
 * commands have. */
export function sharedCommandFits(form: RefForm, shape: Shape, emptyListBehavior: EmptyListBehavior): boolean {
  return sameForm(form, DEFAULT_FORM) && shape === "list" && emptyListBehavior === "unset";
}

/** The command for one ⌘-click toggle: the shared attach / detach when it fits, else this demo's form-aware builder. */
export function toggleCommand(input: ToggleCommandInput): RepositoryCommand {
  if (sharedCommandFits(input.form, input.shape, input.emptyListBehavior)) {
    const how = { kind: "frontmatter" as const, field: input.field };
    const args = { from: rooted(input.owner.path), to: rooted(input.target.path), how, repo: input.repo ?? null };
    return input.present ? detachRelationCommand(args) : attachRelationCommand(args);
  }
  return formToggleCommand(input);
}

export interface FormToggleState {
  field: string;
  /** The field's value before the write (`undefined` when absent). */
  previous: unknown;
  existed: boolean;
  /** What the write left there (`undefined`: the field was unset). */
  written: unknown;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const guard = (rev: string | null) => (rev ? { revision: rev } : undefined);

/** This demo's own toggle as a repository command (the cases the shared commands
 * cannot express — see the header). `apply` re-reads the owner and plans the
 * patch against its CURRENT value (so a redo, or a stale belief, is a `noop`
 * error rather than a wrong write), pins the effect to the revision; the
 * compensation re-reads and refuses unless the field still holds exactly what
 * the write produced, then restores the previous value (or unsets a key the
 * write created). */
export function formToggleCommand(input: ToggleCommandInput): RepositoryCommand<FormToggleState> {
  const owner = rooted(input.owner.path), target = rooted(input.target.path), { field, present, form, repo } = input;
  const how = { kind: "frontmatter" as const, field };
  const note = sameForm(form, DEFAULT_FORM) ? (input.shape === "scalar" ? " (a scalar field)" : "") : ` (as ${describeForm(form)})`;
  const label = `${present ? describeDetach(how, owner, target) : describeRelation(how, owner, target)}${note}`;
  const options: ToggleOptions = { shape: input.shape, emptyListBehavior: input.emptyListBehavior };
  return {
    kind: "repository",
    label,
    async apply(ctx) {
      const before = await readField(ctx.client, input.owner, field, repo);
      const patch = planToggle(before.value, input.target, present, form, options);
      if (patch.kind === "noop" || patch.kind === "refuse") throw new Error(describePatch(input.owner, field, patch, before.value));
      const effect = patch.kind === "set" ? setFrontmatter(owner, field, patch.value, guard(before.revision)) : unsetFrontmatter(owner, field, guard(before.revision));
      const receipt = await ctx.client.apply({ effects: [effect], reason: label, repo });
      return { receipts: [receipt], revisions: receipt.revisions, state: { field, previous: before.value, existed: before.existed, written: patch.kind === "set" ? patch.value : undefined } };
    },
    async compensate(ctx, applied: Applied<FormToggleState>): Promise<Compensation> {
      const s = applied.state;
      const now = await readField(ctx.client, input.owner, field, repo);
      if (s.written === undefined) {
        if (now.existed) return { refused: `\`${field}\` of ${owner} was set again since it was unset (now ${JSON.stringify(now.value)})` };
      } else {
        if (!now.existed) return { refused: `\`${field}\` is gone from ${owner}` };
        if (!same(now.value, s.written)) return { refused: `\`${field}\` of ${owner} no longer holds the value this command wrote (now ${JSON.stringify(now.value)})` };
      }
      const effect = s.existed ? setFrontmatter(owner, field, s.previous, guard(now.revision)) : unsetFrontmatter(owner, field, guard(now.revision));
      return { effects: [effect], reason: s.existed ? `restore \`${field}\`` : `remove \`${field}\`` };
    },
  };
}

// ---- messages ------------------------------------------------------------------------

const DENIED = /not (found|allowed|permitted|enabled|available)|unknown tool|denied|forbidden|allowlist|not in the allow|-3260[12]/i;
/** The engine's answer to a failed `expect.revision`: `stale_plan` ("document … is at revision r_…, not r_…; re-plan"). */
const STALE = /stale_plan|stale_expectation|is at revision/i;

/** A message for a failed write; a refusal that smells like a gateway's tool
 * policy says so, since that is the usual cause in proxy/direct mode, and a
 * stale revision (the document changed since it was read) says to retry. */
export function describeMutationError(e: unknown, tool = "apply"): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof OmgError ? e.code : typeof (e as { code?: unknown } | null)?.code === "string" ? ((e as { code: string }).code) : "";
  if (DENIED.test(msg) || code === "unknown_tool") {
    return `${tool} was refused (${msg}) — when omgbase sits behind a gateway, its tool allowlist must include ${tool}`;
  }
  if (tool === "apply" && (isStale(e) || STALE.test(code) || STALE.test(msg))) {
    return `${msg} — the document changed since it was read; the graph has been refreshed, try the toggle again`;
  }
  return msg;
}
