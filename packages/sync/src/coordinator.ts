import type { SyncSource, SourceWatch } from "@omgbase/core";
import type { EngineClient } from "./engine-client.js";

// Coordinator (ADR-014): the standalone reconcile loop between a SyncSource (an
// external store behind the adapter protocol) and an omgbase repo (behind an
// EngineClient — in-process or MCP). It owns NO reconciliation logic: the engine
// echo-gates and threads identity (via observe/observe_many/observe_delete); the
// coordinator only moves whole-file bytes across and reads the change feed.
//
// Loop safety (ADR-014 D2/D3/§6): the engine echo gate makes ingest idempotent,
// so a source→engine→source→engine round-trip terminates at the echo (no new
// commit). The export direction additionally skips OBSERVED-origin commits —
// those came from a source, so there is nothing to push back — leaving only
// engine-authored (api/import) changes to write out.

export interface SyncInSummary {
  ingested: string[];
  suppressed: string[]; // echoes (bytes already matched — no commit)
  conflicted: string[]; // ingested but carrying git conflict markers
  deleted: string[];
}

export interface SyncOutSummary {
  cursor: number;
  written: string[];
  removed: string[];
}

export class Coordinator {
  constructor(
    private readonly engine: EngineClient,
    private readonly source: SyncSource,
  ) {}

  /** source → engine: ingest the source's full current scope (initial sync). */
  async syncIn(): Promise<SyncInSummary> {
    const entries = await this.source.enumerate();
    return this.reconcile(entries.map((e) => e.path));
  }

  /**
   * source → engine: reconcile a set of changed paths (e.g. a watch batch). A
   * path the source no longer has (`fetch` → null) is mirrored as a deletion.
   */
  async reconcile(paths: string[]): Promise<SyncInSummary> {
    const files: { path: string; content: string }[] = [];
    const gonePaths: string[] = [];
    for (const path of paths) {
      const item = await this.source.fetch(path);
      if (item) files.push({ path, content: item.content });
      else gonePaths.push(path);
    }

    const summary: SyncInSummary = { ingested: [], suppressed: [], conflicted: [], deleted: [] };
    if (files.length > 0) {
      for (const r of await this.engine.observeMany(files)) {
        if (r.echo) summary.suppressed.push(r.path);
        else if (r.conflicted) summary.conflicted.push(r.path);
        else summary.ingested.push(r.path);
      }
    }
    for (const path of gonePaths) {
      const d = await this.engine.observeDelete(path);
      if (d.deleted) summary.deleted.push(path);
    }
    return summary;
  }

  /**
   * engine → source: write engine-authored changes out to the source. Walks the
   * commit feed from `cursor` (paging through `truncated`), skipping
   * observed-origin commits (they originated from a source — §6), and writes
   * each changed doc's current bytes to the source (or removes a tombstoned one).
   * Requires a write-through source; a read-only source exports nothing.
   */
  async syncOut(cursor?: number): Promise<SyncOutSummary> {
    const written: string[] = [];
    const removed: string[] = [];
    let cur = cursor ?? 0;
    if (!this.source.write) return { cursor: cur, written, removed }; // read-only source

    for (;;) {
      const page = await this.engine.changesSince(cur);
      for (const digest of page.digests) {
        if (digest.origin === "observed") continue; // came from a source; don't echo back
        for (const rev of digest.revisions) {
          const doc = await this.engine.readDoc(rev.path);
          if (doc) {
            await this.source.write(rev.path, doc.content);
            written.push(rev.path);
          } else if (this.source.remove) {
            await this.source.remove(rev.path);
            removed.push(rev.path);
          }
        }
      }
      cur = page.cursor;
      if (!page.truncated) break;
    }
    return { cursor: cur, written, removed };
  }

  /**
   * Live source→engine sync: subscribe to the source's change batches and
   * reconcile each. Returns the subscription (call `.stop()`), or null if the
   * source cannot watch. Reconcile runs off the batch callback; `onSummary`
   * observes each batch's result, `onError` any failure.
   */
  async watchIn(handlers: { onSummary?: (s: SyncInSummary) => void; onError?: (err: unknown) => void } = {}): Promise<SourceWatch | null> {
    if (!this.source.watch) return null;
    return this.source.watch((paths) => {
      this.reconcile(paths).then(
        (s) => handlers.onSummary?.(s),
        (err) => handlers.onError?.(err),
      );
    });
  }
}
