import { describe, expect, it } from "vitest";
import { SessionTable } from "../scripts/lib/sessions.mjs";

describe("SessionTable", () => {
  it("maps the browser session id to its upstream and forgets it on remove", () => {
    const t = new SessionTable();
    let upstream: string | undefined;
    const s = t.add({ id: "b1", upstreamId: () => upstream });
    expect(t.get("b1")).toBe(s);
    expect(t.has("b1")).toBe(true);
    expect(t.get(undefined)).toBeUndefined();
    expect(t.get(["b1"])).toBeUndefined(); // a repeated header is not a session id
    expect(t.upstreamIdFor("b1")).toBeUndefined(); // the upstream has not answered initialize yet
    upstream = "u1";
    expect(t.upstreamIdFor("b1")).toBe("u1");
    expect(t.describe()).toEqual([{ id: "b1", upstream: "u1" }]);
    expect(t.remove("b1")).toBe(s);
    expect(t.remove("b1")).toBeUndefined();
    expect(t.size).toBe(0);
    expect(() => t.add({ id: null })).toThrow(/needs an id/);
  });

  it("runs the idle timer per session and restarts it on touch", () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const idle: string[] = [];
    const t = new SessionTable({
      idleMs: 1000,
      onIdle: (s) => idle.push(s.id),
      setTimer: ((fn: () => void, ms: number) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; }) as unknown as typeof setTimeout,
      clearTimer: ((h: { cleared: boolean } | undefined) => { if (h) h.cleared = true; }) as unknown as typeof clearTimeout,
    });
    const a = t.add({ id: "a" });
    t.add({ id: "b" });
    expect(timers.map((x) => x.ms)).toEqual([1000, 1000]);
    t.touch(a);
    expect(timers[0]!.cleared).toBe(true);
    expect(timers).toHaveLength(3);
    timers[1]!.fn();
    expect(idle).toEqual(["b"]);
    t.remove("a");
    expect(timers[2]!.cleared).toBe(true);
    // idleMs 0 → no timers at all
    const none = new SessionTable({ setTimer: (() => { throw new Error("no timer expected"); }) as unknown as typeof setTimeout });
    expect(() => none.add({ id: "x" })).not.toThrow();
  });
});
