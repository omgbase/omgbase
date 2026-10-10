// The bridge's session table: the browser-facing `Mcp-Session-Id` (minted by
// the SDK's server transport) mapped to the upstream for that session — an
// `omg mcp` child, or one remote Streamable HTTP session — plus the idle timer.
// Pure (timers injectable) so the mapping is unit-testable.

export class SessionTable {
  /**
   * @param {{ idleMs?: number, onIdle?: (session: any) => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} opts
   */
  constructor({ idleMs = 0, onIdle = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.idleMs = idleMs;
    this.onIdle = onIdle;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** @type {Map<string, { id: string, upstreamId?: () => string | undefined, timer?: any }>} */
    this.byId = new Map();
  }

  /** Record a session once the server transport has minted its id. */
  add(session) {
    if (!session.id) throw new Error("a session needs an id before it can be added");
    this.byId.set(session.id, session);
    this.touch(session);
    return session;
  }

  get(id) {
    return typeof id === "string" ? this.byId.get(id) : undefined;
  }

  has(id) {
    return this.get(id) !== undefined;
  }

  /** Forget a session (does not close anything; the caller owns the transports). */
  remove(id) {
    const s = this.byId.get(id);
    if (!s) return undefined;
    this.clearTimer(s.timer);
    this.byId.delete(id);
    return s;
  }

  /** Restart the idle timer; a no-op when idleMs is 0. */
  touch(session) {
    if (!this.idleMs) return;
    this.clearTimer(session.timer);
    session.timer = this.setTimer(() => this.onIdle(session), this.idleMs);
  }

  /** The upstream session id for a browser session, if the upstream has one yet. */
  upstreamIdFor(id) {
    return this.get(id)?.upstreamId?.();
  }

  get size() {
    return this.byId.size;
  }

  values() {
    return [...this.byId.values()];
  }

  /** `{ browser → upstream }` for diagnostics (/whoami). */
  describe() {
    return this.values().map((s) => ({ id: s.id, upstream: s.upstreamId?.() ?? null }));
  }
}
