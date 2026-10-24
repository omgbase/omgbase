// Creating a document from the palette: the starter body (`defaultMarkdown`),
// the undoable `createDocumentCommand` over `@omgbase/client`'s command log,
// and the one-line reading of the errors a create can hit (`creationError`).
//
// The command is one `apply` with a single `create` effect (spec/mutate §11.3:
// a live document or a file at the path is `path_taken`), then a `docs_read`
// that records the bytes the server composed and the new revision as the
// command's state. Undo is a new forward write, not a rollback (commands.ts):
// the compensation re-reads the document and REFUSES when it is gone or its
// `_raw` is no longer the bytes creation produced — someone edited it since —
// and otherwise removes it.

import { createDocument, OmgError, removeDocument, type DocsReadResult, type RepositoryCommand } from "@omgbase/client";
import { fileStem } from "./palette.ts";
import { rooted } from "./paths.ts";

/** The title a file name suggests: the stem with `-`/`_` as spaces, the first letter capitalised (`/a/dry-run_notes.md` → `Dry run notes`). */
export function titleFromPath(path: string): string {
  const words = fileStem(path).replace(/[-_]+/g, " ").trim();
  return words.length === 0 ? "Untitled" : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The starter body: one H1, from `title` or the file name. */
export function defaultMarkdown(path: string, title?: string): string {
  const t = title?.trim();
  return `# ${t && t.length > 0 ? t : titleFromPath(path)}\n`;
}

export interface CreateDocumentInput {
  /** Where to create (rooted or bare; sent rooted). */
  path: string;
  /** The body (default `defaultMarkdown(path)`). */
  markdown?: string;
  /** Authored frontmatter keys, when any. */
  frontmatter?: Record<string, unknown>;
  repo?: string | null;
  label?: string;
}

/** What creation produced, for the compensation's guard. */
export interface CreatedState {
  /** The file bytes the server composed (`docs_read._raw` right after the commit). */
  raw: string;
  rev: string | null;
}

export const CREATE_REASON = "create document";
export const REMOVE_CREATED_REASON = "remove the created document";

/** Create a document at `path`. Undo removes it, unless it is gone or its bytes changed since. */
export function createDocumentCommand(input: CreateDocumentInput): RepositoryCommand<CreatedState> {
  const path = rooted(input.path);
  const markdown = input.markdown ?? defaultMarkdown(path);
  const repo = input.repo;
  return {
    kind: "repository",
    label: input.label ?? `create ${path}`,
    async apply(ctx) {
      const receipt = await ctx.client.apply({ effects: [createDocument(path, markdown, input.frontmatter)], reason: CREATE_REASON, repo });
      const doc = await ctx.client.docsRead({ _path: path }, { repo });
      return { receipts: [receipt], revisions: receipt.revisions, state: { raw: doc._raw, rev: doc.rev } };
    },
    async compensate(ctx, applied) {
      let now: DocsReadResult;
      try {
        now = await ctx.client.docsRead({ _path: path }, { repo });
      } catch (e) {
        if (e instanceof OmgError && e.code === "doc_missing") return { refused: `${path} no longer exists` };
        throw e;
      }
      if (now._raw !== applied.state.raw) return { refused: `${path} was edited since it was created (rev ${now.rev ?? "?"}, expected ${applied.state.rev ?? "?"})` };
      return { effects: [removeDocument({ _path: path })], reason: REMOVE_CREATED_REASON };
    },
  };
}

/** A human line for an error a create can hit (the envelope of spec/surface §4;
 * codes of spec/mutate §8). `path` names the document when known. */
export function creationError(e: unknown, path?: string): string {
  const at = path ? ` at ${path}` : "";
  if (e instanceof OmgError) {
    switch (e.code) {
      case "path_taken": return `a document (or a file) already exists${at}`;
      case "filter_invalid": return `the create request was malformed: ${e.message}`;
      case "unknown_tool": return "this server does not offer `apply` (its tools profile hides it)";
      case "repo_not_found": return `the repository is not on this server: ${e.message}`;
      case "conflicted_document": return `the document${at} is in a sync conflict; resolve it first`;
      case "sync_conflict": return `the write collided with a sync in progress; try again`;
      default: return `${e.code}: ${e.message}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
