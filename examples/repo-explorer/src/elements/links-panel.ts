// <links-panel>: the open document's backlinks (`from links where _dst_path ==
// …`) and outlinks (`from links where _path == …`), each row a link to its
// document (lib/links.ts). Event: `open-doc { path }`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { linkProvenance, linkTarget, wikiStem, type DocLinks, type LinkRow } from "../lib/links.ts";

@customElement("links-panel")
export class LinksPanel extends LitElement {
  static override styles = css`
    :host { display: block; font: 13px/1.5 system-ui, sans-serif; color: #1e2430; }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #5a6270; margin: 12px 0 6px; }
    h3:first-child { margin-top: 0; }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
    td { padding: 3px 10px 3px 0; border-bottom: 1px solid #eef0f4; vertical-align: top; }
    td.prov { color: #8a94a6; white-space: nowrap; font-size: 11.5px; }
    td.block { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #8a94a6; }
    a { color: #1565c0; cursor: pointer; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .dangling { color: #b26a00; }
    .empty { color: #8a94a6; font-size: 12.5px; }
    .query { font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a94a6; margin: 2px 0 6px; word-break: break-all; }
  `;

  @property({ attribute: false }) links: DocLinks | null = null;
  @property({ type: String }) path: string | null = null;
  @property({ type: String }) error: string | null = null;

  private open(path: string): void {
    this.dispatchEvent(new CustomEvent("open-doc", { detail: { path }, bubbles: true, composed: true }));
  }

  private docLink(path: string) {
    return html`<a href=${`#doc=${path}`} @click=${(e: Event) => { e.preventDefault(); this.open(path); }}>${path}</a>`;
  }

  private renderInbound(rows: LinkRow[]) {
    if (rows.length === 0) return html`<div class="empty">nothing links here</div>`;
    return html`<table>${rows.map((r) => html`<tr>
      <td>${this.docLink(r.path)}</td>
      <td class="prov">${linkProvenance(r)}</td>
      <td class="block">${r.blockId ?? ""}</td>
    </tr>`)}</table>`;
  }

  private renderOutbound(rows: LinkRow[]) {
    if (rows.length === 0) return html`<div class="empty">no outgoing links</div>`;
    return html`<table>${rows.map((r) => {
      const t = linkTarget(r);
      return html`<tr>
        <td>${t.doc ? this.docLink(t.doc) : t.href ? html`<a href=${t.href} target="_blank" rel="noopener">${t.text}</a>` : html`<span class=${t.dangling ? "dangling" : ""}>${t.text}</span>`}</td>
        <td class="prov">${linkProvenance(r)}${r.dstKind && r.dstKind !== "document" ? ` · ${r.dstKind}` : ""}</td>
        <td class="block">${r.anchor ? `#${r.anchor}` : ""}</td>
      </tr>`;
    })}</table>`;
  }

  override render() {
    if (this.error) return html`<div class="empty">${this.error}</div>`;
    const l = this.links;
    if (!l) return html`<div class="empty">loading links…</div>`;
    const p = this.path ?? "";
    return html`
      <h3>backlinks (${l.inbound.length})</h3>
      <div class="query">from links where _dst_path == ${JSON.stringify(p)}</div>
      ${this.renderInbound(l.inbound)}
      <h3>outlinks (${l.outbound.length})</h3>
      <div class="query">from links where _path == ${JSON.stringify(p)}</div>
      ${this.renderOutbound(l.outbound)}
      ${l.byName.length > 0 ? html`
        <h3>wikilinks naming [[${wikiStem(p)}]] (${l.byName.length})</h3>
        <div class="query">from links where _dst_id == ${JSON.stringify(`phantom:${wikiStem(p)}`)}</div>
        <div class="empty">a bare <code>[[${wikiStem(p)}]]</code> is not resolved to this document by the engine (its row has <code>_dst_path: null</code>), so these are listed by the phantom's name</div>
        ${this.renderInbound(l.byName)}` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "links-panel": LinksPanel }
}
