import { createHash } from "node:crypto";
import { storagePath, type SyncSource, type SourceWatch } from "@omgbase/core";
import { FeedExpired, type EngineClient } from "./engine-client.js";

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
  /** the feed's epoch the cursor belongs to (spec/sync §6, 4.0); a consumer stores both */
  epoch: string | null;
  written: string[];
  removed: string[];
  /** set when the feed had expired the cursor and the rescan procedure (spec/sync §6) ran before resuming */
  rescanned?: boolean;
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
      // The engine answers in the surface's reference form (`/a.md`,
      // spec/surface §1 "Paths"); a source speaks storage paths.
      for (const r of await this.engine.observeMany(files)) {
        const path = storagePath(r.path);
        if (r.echo) summary.suppressed.push(path);
        else if (r.conflicted) summary.conflicted.push(path);
        else summary.ingested.push(path);
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
   * change feed from `(epoch, cursor)` (paging through `truncated`), skipping
   * observed-origin commits (they originated from a source — §6), and applies
   * each digest's documents by `kind`: `created`/`changed`/`moved` → read the
   * doc by `_id` and `write` at `_path` (a `moved` also `remove`s `from_path`);
   * `deleted` → `remove`. When the feed has **expired** the cursor (another
   * epoch, past the head, pruned behind the oldest retained row — spec/surface
   * §3 `expired_cursor`) the rescan procedure of spec/sync §6 runs — the
   * server's live documents are listed and the source reconverged to them —
   * and the walk resumes from the error's `head` under its `epoch`. Requires a
   * write-through source; a read-only source exports nothing.
   */
  async syncOut(cursor?: number, epoch?: string): Promise<SyncOutSummary> {
    const written: string[] = [];
    const removed: string[] = [];
    let cur = cursor ?? 0;
    let ep: string | null = epoch ?? null;
    if (!this.source.write) return { cursor: cur, epoch: ep, written, removed }; // read-only source
    let rescanned = false;

    for (;;) {
      let page;
      try {
        page = await this.engine.changesSince(cur, ep !== null ? { epoch: ep } : {});
      } catch (e) {
        if (!(e instanceof FeedExpired) || rescanned) throw e;
        // The rescan (spec/sync §6): record S = head and E = epoch from the
        // error, reconverge the source to the server's live documents, resume
        // from (E, S). Once per call: a second expiry means the bootstrap lease
        // (the retention floor) did not hold and the caller retries.
        const r = await this.rescan();
        written.push(...r.written);
        removed.push(...r.removed);
        cur = e.head;
        ep = e.epoch;
        rescanned = true;
        continue;
      }
      for (const digest of page.digests) {
        if (digest.origin === "observed") continue; // came from a source; don't echo back
        for (const rev of digest.revisions) {
          // `changes_since` reports a document under the row's engine names
          // (`_id`, `_path`, `_hash` — spec/surface §1.2, 5.0) in the
          // reference form; the source takes storage paths.
          const path = storagePath(rev._path);
          if (rev.kind === "moved" && rev.from_path !== undefined) {
            const from = storagePath(rev.from_path);
            if (from !== path) await this.removeOnce(from, removed);
          }
          if (rev.kind === "deleted") {
            await this.removeOnce(path, removed);
            continue;
          }
          const doc = await this.engine.readDoc(path);
          if (doc) {
            await this.source.write(path, doc.content);
            written.push(path);
          } else {
            // The document no longer reads (tombstoned later in the feed): its
            // `deleted` digest follows and would remove the same path again.
            await this.removeOnce(path, removed);
          }
        }
      }
      cur = page.cursor;
      ep = page.epoch ?? ep;
      if (!page.truncated) break;
    }
    return { cursor: cur, epoch: ep, written, removed, ...(rescanned ? { rescanned } : {}) };
  }

  /** `remove` a source path once per `syncOut` call (a tombstoned document's own digest and its earlier digests all name it). */
  private async removeOnce(path: string, removed: string[]): Promise<void> {
    if (!this.source.remove || removed.includes(path)) return;
    await this.source.remove(path);
    removed.push(path);
  }

  /**
   * The rescan procedure, steps 2–3 (spec/sync §6, 4.0): page the server's
   * live documents into `L = { (id, path, hash) }`; for every document whose
   * hash differs from the source's copy (hashed as the engine hashes a file —
   * sha256 of the bytes), pull the bytes and write them at `path`; every
   * source-side path not in `L` is removed (absence from `L` is deletion — the
   * source has paths, not ids, so a moved document is a write at the new path
   * and a removal of the old one). The caller resumes the feed (step 4).
   */
  async rescan(): Promise<{ written: string[]; removed: string[] }> {
    const written: string[] = [];
    const removed: string[] = [];
    if (!this.source.write) return { written, removed };
    const listed = await this.engine.listDocs();
    const live = new Set<string>();
    for (const d of listed) {
      const path = storagePath(d._path);
      live.add(path);
      const have = await this.source.fetch(path);
      const haveHash = have ? createHash("sha256").update(have.content, "utf8").digest("hex") : null;
      if (haveHash !== null && haveHash === d._hash) continue;
      const doc = await this.engine.readDoc(path);
      if (!doc) continue;
      await this.source.write(path, doc.content);
      written.push(path);
    }
    if (this.source.remove) {
      for (const entry of await this.source.enumerate()) {
        if (live.has(entry.path)) continue;
        await this.source.remove(entry.path);
        removed.push(entry.path);
      }
    }
    return { written, removed };
  }

  /**
   * Live source→engine sync: subscribe to the source's change batches and
   * reconcile each. Returns the subscription (`.ready` resolves once the source
   * reported its feed primed — spec/sync §5; call `.stop()`), or null if the
   * source cannot watch. Reconcile runs off the batch callback; `onSummary`
   * observes each batch's result, `onError` any failure.
   */
  async watchIn(handlers: { onSummary?: (s: SyncInSummary) => void; onError?: (err: unknown) => void } = {}): Promise<SourceWatch | null> {
    if (!this.source.watch) return null;
    return this.source.watch((ev) => {
      if (ev.event !== "batch") return;
      this.reconcile(ev.paths).then(
        (s) => handlers.onSummary?.(s),
        (err) => handlers.onError?.(err),
      );
    });
  }
}
