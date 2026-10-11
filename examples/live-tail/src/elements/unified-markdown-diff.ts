// <unified-markdown-diff>: a unified diff shown as rendered Markdown — bullets,
// headings, tables and code blocks instead of `- item` / `## Heading` text —
// with what was removed on a red background and what was added on a green one.
//
// The hard part is that a hunk is an excerpt and may begin inside a construct
// (a fenced code block, a nested list, a table). So the element takes the two
// revisions' FULL texts along with the diff and renders the documents, not the
// excerpt: lib/markdown-diff.ts maps every diff line to the block that holds it
// in each revision and shows the blocks the hunk touches — a container (list,
// item, blockquote) keeps its chrome and recurses so only the items that
// changed are coloured; a fenced or indented code block and the frontmatter —
// verbatim lines — are one code block with the removed and added LINES
// coloured; a table whose header did not change is one table with the body
// ROWS coloured; any other element the diff touches only in part (one line of
// a paragraph, a heading, a table header) is rendered WHOLE, twice: the before
// version red, the after version green. Whatever the hunk does not reach is elided
// with `⋯` — one compact line per elision, never two in a row, none at an edge
// the document's first or last block is shown at.
//
//   properties: diff     the unified diff text (`diff_unified`'s `diff`, or `createdDiff`)
//               oldText  the full text of the `from` revision (null while unknown)
//               newText  the full text of the `to` revision (null while unknown)
//               wrap     word-wrap in code blocks (the page's wrap switch)
//   (`before`/`after` would shadow Element.before()/after().)
//   Without both texts — or when they do not match the diff — the hunks alone
//   are rendered (`source` = "excerpt") and a muted line says so.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderMarkdownDiff } from "../lib/markdown-diff.ts";

@customElement("unified-markdown-diff")
export class UnifiedMarkdownDiff extends LitElement {
  static override styles = css`
    :host { display: block; }
    .body { padding: 8px 12px; font: 13.5px/1.5 system-ui, sans-serif; color: #222; }
    .source { padding: 4px 12px 0; color: #8a94a6; font-size: 12px; }
    .body > :first-child, .piece > :first-child { margin-top: 0; }
    .body > :last-child, .piece > :last-child { margin-bottom: 0; }
    h1, h2, h3, h4, h5, h6 { margin: 0.5em 0 0.3em; line-height: 1.25; }
    h1 { font-size: 1.5em; } h2 { font-size: 1.3em; } h3 { font-size: 1.15em; } h4, h5, h6 { font-size: 1em; }
    p { margin: 0.35em 0; }
    ul, ol { margin: 0.35em 0; padding-left: 1.6em; }
    li { margin: 0.1em 0; }
    li > p { margin: 0.2em 0; }
    blockquote { margin: 0.4em 0; padding: 0.1em 0 0.1em 0.8em; border-left: 3px solid #d4d8e0; color: #4a5160; }
    pre { margin: 0.4em 0; padding: 6px 8px; border-radius: 4px; background: #f6f7f9; overflow-x: auto; white-space: pre; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    :host([wrap]) pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    pre.frontmatter { border: 1px dashed #d4d8e0; background: #fafbfc; }
    code { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0f1f4; padding: 0 3px; border-radius: 3px; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; margin: 0.4em 0; font-size: 13px; }
    th, td { border: 1px solid #d4d8e0; padding: 2px 8px; text-align: left; }
    th { background: #f0f1f4; }
    hr { border: 0; border-top: 1px solid #d4d8e0; margin: 0.6em 0; }
    a { color: #1565c0; }
    .image { color: #6a7382; font-style: italic; }
    /* One short muted line per elision, as cheap in height as it can be: no margins, a line-height of 1, a couple of pixels of padding (vertical space in the feed is at a premium; the pure layer already guarantees never two in a row). */
    .gap { color: #a0a8b6; text-align: center; letter-spacing: 0.3em; font-size: 12px; line-height: 1; margin: 0; padding: 2px 0; list-style: none; user-select: none; }
    pre.verbatim { padding: 6px 0; }
    pre.verbatim .line { display: block; padding: 0 8px; }
    tr[data-kind] td { box-shadow: none; }
    [data-kind] { border-radius: 3px; }
    pre.verbatim .line[data-kind] { border-radius: 0; }
    .piece[data-kind] { padding: 2px 6px; margin: 2px 0; }
    li[data-kind] { padding: 0 6px; margin-left: -6px; }
    [data-kind="add"] { background: #e6ffed; box-shadow: inset 3px 0 0 #7bc47f; }
    [data-kind="del"] { background: #ffeef0; box-shadow: inset 3px 0 0 #e59a9a; }
    [data-kind="add"] pre, [data-kind="add"] th { background: #d9f5df; }
    [data-kind="del"] pre, [data-kind="del"] th { background: #fbe0e3; }
    [data-kind="add"] pre.frontmatter { background: #e6ffed; }
    [data-kind="del"] pre.frontmatter { background: #ffeef0; }
  `;

  @property({ type: String }) diff = "";
  @property({ type: String }) oldText: string | null = null;
  @property({ type: String }) newText: string | null = null;
  @property({ type: Boolean, reflect: true }) wrap = false;

  private rendered: { key: string; html: string; source: "documents" | "excerpt" } | null = null;

  /** The HTML for the current inputs, computed once per change of them. */
  private current() {
    const key = JSON.stringify([this.diff, this.oldText, this.newText]);
    if (this.rendered?.key !== key) this.rendered = { key, ...renderMarkdownDiff(this.diff, this.oldText, this.newText) };
    return this.rendered;
  }

  override render() {
    const { html: body, source } = this.current();
    return html`
      ${source === "excerpt" ? html`<div class="source">${this.oldText === null || this.newText === null ? "rendered from the excerpt alone — the revisions' full text is not in yet" : "rendered from the excerpt alone — the revisions' text does not match this diff"}</div>` : nothing}
      <div class="body">${unsafeHTML(body)}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "unified-markdown-diff": UnifiedMarkdownDiff }
}
