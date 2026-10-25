import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { observeBatch } from "../../sync/observe.js";
import { mintId, withIdMinter, sequentialMinter } from "../ids.js";
import { runGc } from "../store/gc.js";
import { sweepResurrectionPool } from "../store/gc.js";
import { tombstoneObservedDeletion } from "../../sync/tombstone.js";
import { IdClaims, HOLDER_CORE, HOLDER_RECORDER, claimsRetainDays } from "./claims.js";

// spec/store §2.1 "Uniqueness at mint" and §7.3 "Claims prune" (17.0, M3/D5):
// the `id_claims` table — written by the core's writers in the transaction
// that lands the id, held by the recorder's capture, probed by `mintId`,
// pruned by `gc` under `identity.claims_retain_days`.

const T0 = "2026-09-26T10:00:00.000Z";
const T1 = "2026-09-26T10:01:00.000Z";
const T2 = "2026-09-26T10:02:00.000Z";
const LATER = "2026-11-10T00:00:00.000Z"; // T1 + 45 days

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "claims", null);
});
afterEach(() => store.close());

function claim(id: string): { prefix: string; repo_id: string | null; minted_at: string; holders: number } | undefined {
  return store.db.prepare("SELECT prefix, repo_id, minted_at, holders FROM id_claims WHERE id = ?").get(id) as { prefix: string; repo_id: string | null; minted_at: string; holders: number } | undefined;
}
/** One observed file through the reconciling path (`observeBatch`, spec/store §5): the carry/pool/resurrection semantics `ingestFile` alone has not. */
function observe(path: string, source: string | null, ts: string): { docId: string; rev: string | null } {
  const [o] = observeBatch(store, repoId, [{ path, content: source }], ts);
  if (!o || o.kind === "deleted") return { docId: o?.docId ?? "", rev: null };
  return { docId: o.docId, rev: o.rev };
}
function setRetainDays(days: number | null): void {
  store.db.prepare("UPDATE repos SET settings = ? WHERE repo_id = ?").run(JSON.stringify({ identity: { claims_retain_days: days } }), repoId);
}

describe("IdClaims — the claim is written with the row (spec/store §2.1, 17.0)", () => {
  it("claims the repo at ensureRepo and every d/b/r the ingest lands, with the recorder's hold", () => {
    expect(claim(repoId)).toMatchObject({ prefix: "rp", repo_id: repoId, holders: HOLDER_CORE });
    const r = store.write(() => ingestFile(store, repoId, "a.md", "# T\n\nOne.\n\nTwo.\n", { ts: T0 }));
    expect(claim(r.docId)).toEqual({ prefix: "d", repo_id: repoId, minted_at: T0, holders: HOLDER_CORE | HOLDER_RECORDER });
    expect(claim(r.revId)).toEqual({ prefix: "r", repo_id: repoId, minted_at: T0, holders: HOLDER_CORE | HOLDER_RECORDER });
    const blocks = store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? ORDER BY ordinal").all(r.docId) as { block_id: string }[];
    expect(blocks).toHaveLength(3);
    for (const b of blocks) expect(claim(b.block_id)).toEqual({ prefix: "b", repo_id: repoId, minted_at: T0, holders: HOLDER_CORE | HOLDER_RECORDER });
    // The commit is the recorder's: no claim, and `isClaimed("c")` still probes `commits`.
    expect(claim(r.commitId)).toBeUndefined();
    expect(store.capabilities.claims.isClaimed("c", r.commitId)).toBe(true);
    expect(store.capabilities.claims.isClaimed("c", "c_nope")).toBe(false);
  });

  it("isClaimed is one probe on id_claims for the core prefixes, and a claim outlives the row, the pool and the sweep", () => {
    const claims = store.capabilities.claims;
    const r = observe("a.md", "# T\n\nOne.\n\nTwo.\n", T0);
    const two = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND text = 'Two.'").get(r.docId) as { block_id: string }).block_id;
    expect(claims.isClaimed("b", two)).toBe(true);
    // Delete the paragraph: the id is pooled, then swept; the claim stays and the probe still says "in use".
    observe("a.md", "# T\n\nOne.\n", T1);
    expect(store.db.prepare("SELECT deleted_at, expires_ts FROM resurrection_pool WHERE block_id = ?").get(two)).toEqual({ deleted_at: T1, expires_ts: "2026-10-26T10:01:00.000Z" });
    expect(sweepResurrectionPool(store, LATER)).toBe(1);
    expect(store.db.prepare("SELECT 1 FROM blocks WHERE block_id = ?").get(two)).toBeUndefined();
    expect(claims.isClaimed("b", two)).toBe(true);
    expect(claim(two)?.holders).toBe(HOLDER_CORE | HOLDER_RECORDER);
    // And `mintId` redraws past it: a minter offering the swept id first is refused once.
    const minted = withIdMinter(
      (() => {
        let n = 0;
        return () => (n++ === 0 ? two : `b_fresh${n}`);
      })(),
      () => mintId("b"),
    );
    expect(minted).toBe("b_fresh2");
  });

  it("a tombstone and a revival carry the claims; the revival's head is the only new one", () => {
    const r0 = observe("a.md", "# T\n\nOne.\n", T0);
    const before = (store.db.prepare("SELECT id FROM id_claims ORDER BY id").all() as { id: string }[]).map((x) => x.id);
    tombstoneObservedDeletion(store, repoId, r0.docId, T1);
    expect((store.db.prepare("SELECT id FROM id_claims ORDER BY id").all() as { id: string }[]).map((x) => x.id)).toEqual(before);
    const r1 = observe("a.md", "# T\n\nOne.\n", T2);
    expect(r1.docId).toBe(r0.docId);
    const after = (store.db.prepare("SELECT id FROM id_claims ORDER BY id").all() as { id: string }[]).map((x) => x.id);
    expect(after).toEqual([...before, r1.rev!].sort());
  });
});

describe("the claims prune (spec/store §7.3)", () => {
  function deleteAndSweep(): { kept: string; gone: string; oldHead: string; head: string; docId: string } {
    const r0 = observe("a.md", "# T\n\nOne.\n\nTwo.\n", T0);
    const gone = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND text = 'Two.'").get(r0.docId) as { block_id: string }).block_id;
    const kept = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND text = 'One.'").get(r0.docId) as { block_id: string }).block_id;
    const r1 = observe("a.md", "# T\n\nOne.\n", T1);
    expect(sweepResurrectionPool(store, LATER)).toBe(1);
    return { kept, gone, oldHead: r0.rev!, head: r1.rev!, docId: r0.docId };
  }

  it("releases nothing while identity.claims_retain_days is null, and never a claim that names a core row", () => {
    const { kept, gone, oldHead, head, docId } = deleteAndSweep();
    expect(runGc(store, { enabled: true, now: LATER }).claimsReleased).toBe(0);
    setRetainDays(30);
    expect(runGc(store, { enabled: true, now: LATER, dryRun: true }).claimsReleased).toBe(0);
    expect(runGc(store, { enabled: true, now: LATER }).claimsReleased).toBe(2);
    // The deleted block and the old head lose the core's hold; the recorder's keeps the rows.
    expect(claim(gone)?.holders).toBe(HOLDER_RECORDER);
    expect(claim(oldHead)?.holders).toBe(HOLDER_RECORDER);
    expect(store.capabilities.claims.isClaimed("b", gone)).toBe(true);
    // Live rows, the head, the doc and the repo keep the core's hold whatever their age.
    for (const id of [kept, head, docId, repoId]) expect((claim(id)!.holders & HOLDER_CORE) !== 0).toBe(true);
    // A second run finds nothing more to release.
    expect(runGc(store, { enabled: true, now: LATER }).claimsReleased).toBe(0);
  });

  it("honours the window: a claim younger than claims_retain_days is kept", () => {
    const { gone } = deleteAndSweep();
    setRetainDays(60);
    expect(runGc(store, { enabled: true, now: LATER }).claimsReleased).toBe(0);
    expect(claim(gone)?.holders).toBe(HOLDER_CORE | HOLDER_RECORDER);
    setRetainDays(0);
    expect(runGc(store, { enabled: true, now: LATER }).claimsReleased).toBe(2);
  });

  it("deletes a claim with no holder left, after which the id can be minted again (D5, the documented consequence)", () => {
    const { gone } = deleteAndSweep();
    // What `history purge` does for every id: the recorder's rows and its hold go.
    store.db.prepare("DELETE FROM dispositions WHERE block_id = ?").run(gone);
    store.db.prepare("DELETE FROM block_changes WHERE block_id = ?").run(gone);
    store.db.prepare(`UPDATE id_claims SET holders = holders & ~${HOLDER_RECORDER} WHERE id = ?`).run(gone);
    setRetainDays(30);
    expect(runGc(store, { enabled: true, now: LATER }).claimsReleased).toBe(2);
    expect(claim(gone)).toBeUndefined();
    expect(store.capabilities.claims.isClaimed("b", gone)).toBe(false);
    // A minter that offers the pruned id gets it back.
    const minted = withIdMinter(() => gone, () => mintId("b"));
    expect(minted).toBe(gone);
  });

  it("refuses a malformed identity.claims_retain_days", () => {
    expect(claimsRetainDays({})).toBeNull();
    expect(claimsRetainDays({ identity: { claims_retain_days: null } })).toBeNull();
    expect(claimsRetainDays({ identity: { claims_retain_days: 0 } })).toBe(0);
    expect(() => claimsRetainDays({ identity: { claims_retain_days: -1 } })).toThrow(/non-negative integer/);
    expect(() => claimsRetainDays({ identity: { claims_retain_days: "30" } })).toThrow(/non-negative integer/);
    store.db.prepare("UPDATE repos SET settings = ? WHERE repo_id = ?").run('{"identity":{"claims_retain_days":1.5}}', repoId);
    expect(() => runGc(store, { enabled: true, now: LATER })).toThrow(/identity\.claims_retain_days/);
  });

  it("the size report counts the claims", () => {
    store.write(() => ingestFile(store, repoId, "a.md", "# T\n\nOne.\n", { ts: T0 }));
    expect(store.capabilities.claims.count()).toBe((store.db.prepare("SELECT count(*) AS c FROM id_claims").get() as { c: number }).c);
    expect(store.capabilities.claims).toBeInstanceOf(IdClaims);
  });
});

describe("the fixture minter is independent of the claims (spec/store §2.2)", () => {
  it("mints the same sequence as a store without claims would — the claim is written after the minter yields", () => {
    withIdMinter(sequentialMinter(), () => {
      const s = new Store({ path: ":memory:" });
      try {
        const rp = ensureRepo(s, "fixture", null);
        expect(rp).toBe("rp_0");
        const r = s.write(() => ingestFile(s, rp, "a.md", "# T\n\nOne.\n", { ts: T0 }));
        expect(r.docId).toBe("d_0");
        expect(r.revId).toBe("r_0");
        expect(r.commitId).toBe("c_0");
        expect((s.db.prepare("SELECT id FROM id_claims WHERE prefix = 'b' ORDER BY id").all() as { id: string }[]).map((x) => x.id)).toEqual(["b_0", "b_1"]);
      } finally {
        s.close();
      }
    });
  });
});
