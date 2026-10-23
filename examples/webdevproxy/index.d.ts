// Hand-written types for the plain-JS package (no build step), so a TypeScript
// Vite config or dev script can import it under `strict`.

export interface ProxyArgs {
  /** Workspace directory for `omg mcp -C <dir>`. */
  local: string | null;
  /** The `omg` entry (`.js`, run with node) or binary. */
  omg: string;
  /** `--repo` / `WEBDEVPROXY_REPO`: the repository slug — passed to the local `omg mcp --repo`, reported on `/whoami` in every mode. */
  repo: string | null;
  /** `--tools` / `WEBDEVPROXY_TOOLS`: the catalog profile the local `omg mcp` serves (`"full" | "minimal"`); reported on `/whoami`. */
  tools: string | null;
  /** The upstream MCP URL. */
  remote: string | null;
  /** `--client-id` / `WEBDEVPROXY_CLIENT_ID`: a pre-registered public OAuth client to present instead of registering one dynamically; null = register. */
  clientId: string | null;
  /** `--callback-port` / `WEBDEVPROXY_CALLBACK_PORT`: the sign-in loopback listener's port; null = ephemeral (or `DEFAULT_CALLBACK_PORT` with a client id). */
  callbackPort: number | null;
  /** `--reset-client`: forget the client registration stored for the remote (and its tokens) at start-up and register anew. */
  resetClient: boolean;
  port: number;
  path: string;
  idleSeconds: number;
  /** Extra allowed browser origins (loopback origins are always allowed). */
  origins: string[];
  tokenFile: string | null;
  noBrowser: boolean;
  logout: boolean;
  help: boolean;
  /** argv without the proxy's own flags. */
  rest: string[];
}

export interface Identity {
  email: string | null;
  name: string | null;
  subject: string | null;
}

export interface WhoAmI {
  mode: "local" | "remote";
  upstream: string;
  identity: Identity | null;
  /** The repository the proxy was started for (`--repo`), or null: the server's default. */
  repo: string | null;
  /** The catalog profile the local `omg mcp` serves (`--tools`), or null: the server's own. */
  tools: string | null;
  auth: {
    state: "none" | "unknown" | "ok" | "waiting" | "error";
    issuer?: string;
    /** While `waiting`: the page to finish the sign-in on, for a browser that did not open by itself. */
    authorizationUrl?: string;
    error?: string;
    /** `ok` reached by replacing a stored sign-in the issuer rejected with a fresh one, by itself. */
    recovered?: true;
    recoveredAt?: string;
    /** Remote mode: which OAuth client the proxy presents — the configured `--client-id`, or the file's dynamic registration (`id` null before the first one). Client ids are public. */
    client?: { source: "configured" | "registered"; id: string | null };
  };
  tokenFile: string | null;
  sessions: { id: string; upstream: string | null }[];
}

export interface Proxy {
  /** `http://localhost:<port><path>` */
  url: string;
  port: number;
  path: string;
  mode: "local" | "remote";
  /** The OAuth client in remote mode (for `startPrompt`), else null. */
  remote: RemoteAuth | null;
  whoami(): WhoAmI;
  /** Resolves once the remote sign-in (or refresh) attempted at startup has settled; never rejects. */
  ready: Promise<void>;
  close(): Promise<void>;
}

/** `Partial<ProxyArgs>` includes `clientId` (`--client-id`), `remote`, `tokenFile`, … */
export type StartProxyOptions = Partial<ProxyArgs> & {
  log?: (message: string) => void;
  /** Parsed for defaults when given; `options` override. */
  argv?: string[];
  env?: Record<string, string | undefined>;
  /** Replaces the system browser for the remote sign-in (a test's fake user). */
  openBrowser?: (url: string) => Promise<boolean>;
};

export function startProxy(options?: StartProxyOptions): Promise<Proxy>;
/** The message in the 404 `-32000` body for a session id the proxy does not know (expired after `--idle`, or the proxy restarted). */
export const UNKNOWN_SESSION_MESSAGE: string;
export function logout(options: { remote?: string | null; tokenFile?: string | null; env?: Record<string, string | undefined> }, log?: (message: string) => void): string[];

/** The one-line hint the terminal prompt prints when a sign-in is `waiting` or failed. */
export const PROMPT_HINT: string;
/**
 * Remote mode's terminal keys over readline (`a` / `r` / `l` / `q` + Enter) — attach only when stdin is a TTY.
 * `a` re-opens a waiting sign-in (URL printed again) or drops the tokens and signs in afresh; `r` forgets the
 * client registration (and its tokens) and registers anew; `l` forgets the token file and signs in fresh;
 * `q` closes the proxy and calls `exit(0)`.
 */
export function startPrompt(options: {
  remote: RemoteAuth;
  proxy: { close(): Promise<void> };
  input?: NodeJS.ReadableStream;
  log?: (message: string) => void;
  exit?: (code: number) => void;
}): { close(): void };

export interface ViteProxyEntry {
  target: string;
  changeOrigin: false;
}
/** Vite `server.proxy` entries for the MCP path (default `/mcp`) and `/whoami`. */
export function viteProxy(options?: { port?: number | string; path?: string; env?: Record<string, string | undefined> }): Record<string, ViteProxyEntry>;

export function parseArgs(argv?: string[], env?: Record<string, string | undefined>): ProxyArgs;
export function validateArgs(args: ProxyArgs): string | null;
export function defaultOmg(env?: Record<string, string | undefined>, exists?: (path: string) => boolean): string;
export function omgCommand(omg: string): { command: string; args: string[] };
export const USAGE: string;
export const DEFAULT_PORT: number;
export const DEFAULT_PATH: string;
export const DEFAULT_IDLE_SECONDS: number;
/** The fixed loopback callback port a `--client-id` run uses without `--callback-port` (8790): `http://127.0.0.1:8790/callback` is the application's allowed callback URL. */
export const DEFAULT_CALLBACK_PORT: number;
export const LISTEN_HOST: string;
export const MONOREPO_OMG: string;

export const LOOPBACK_ORIGINS: string[];
export function originMatches(origin: string, pattern: string): boolean;
export function allowOrigin(origin: string | undefined, extra?: string[]): string | null;
export function corsHeaders(origin: string): Record<string, string>;

export interface TokenFile {
  serverUrl: string;
  redirectPort?: number;
  clientInformation?: Record<string, unknown>;
  /** The authorization server `clientInformation` was registered with; a registration made with another issuer is dropped, not presented. */
  clientIssuer?: string;
  tokens?: Record<string, unknown> & { access_token?: string; refresh_token?: string; id_token?: string };
  tokensSavedAt?: number;
  codeVerifier?: string;
  state?: string;
  discovery?: Record<string, unknown> & { authorizationServerUrl?: string };
}

export const APP_DIR_NAME: string;
export const LEGACY_APP_DIR_NAME: string;
export const TOKEN_FILE_ENV: string;
export function configDir(env?: Record<string, string | undefined>, appDir?: string): string;
export function legacyConfigDir(env?: Record<string, string | undefined>): string;
export function serverUrlHash(serverUrl: string): string;
export function tokenFilePath(serverUrl: string, opts?: { env?: Record<string, string | undefined>; dir?: string }): string;
export function legacyTokenFilePath(serverUrl: string, opts?: { env?: Record<string, string | undefined>; dir?: string }): string;
export function migrateLegacyTokenFile(file: string, legacyFile: string): boolean;
export function readTokenFile(file: string): TokenFile | null;
export function writeTokenFile(file: string, data: TokenFile): void;
export function deleteTokenFile(file: string): boolean;
export function listTokenFiles(dir?: string): string[];

export const CALLBACK_PATH: string;
/** `error.name` of a loopback round trip that was superseded or cancelled (`Loopback.cancel`, `RemoteAuth.reauthorize`). */
export const SIGN_IN_CANCELLED: string;
/** `error.name` of RemoteAuth's abort of a browser flow built on stale cached issuer metadata (it rediscovers instead). */
export const STALE_DISCOVERY: string;
/** Appended to the sign-in failure when the issuer's dynamic registration is capped (Auth0 `too_many_entities`). */
export const TOO_MANY_ENTITIES_HINT: string;
/** `error.name` of the failure when the token endpoint rejects a configured `--client-id` (`invalid_client` / `unauthorized_client`); never recovered by registering. */
export const CONFIGURED_CLIENT_REJECTED: string;
/** Appended to a rejected `--client-id` when the issuer advertises a `registration_endpoint`: drop the flag and the proxy registers by itself. */
export const REGISTER_INSTEAD_HINT: string;
/** `the configured client id <id> was rejected by the issuer (<code>) — check WEBDEVPROXY_CLIENT_ID / --client-id against the tenant's application[; <REGISTER_INSTEAD_HINT>]` */
export function configuredClientRejected(clientId: string, code?: string, canRegister?: boolean): string;
/** `error.name` of the pre-browser check's verdict: the token endpoint does not know the stored client registration; `RemoteAuth.run` drops it and registers anew. */
export const CLIENT_UNKNOWN: string;
/** The bogus refresh token the pre-browser check sends. */
export const REGISTRATION_CHECK_TOKEN: string;
/** `the client registration <id> is unknown to <issuer> (<code>: the gateway was reset or started with a fresh state directory)` */
export function clientUnknown(clientId: string, issuer: string, code: string): string;
/** The loopback port a registration's `redirect_uris` name, or undefined. */
export function registeredPort(clientInformation: Record<string, unknown> | undefined): number | undefined;
/** Whether a registration's `redirect_uris` allow `redirectUrl` (a registration without the list is allowed). */
export function registrationAllows(clientInformation: Record<string, unknown> | undefined, redirectUrl: string): boolean;
/** The start-up failure when a fixed callback port is taken (another port would not match the application's allowed callback URL). */
export function callbackPortInUse(port: number): string;
export function loopbackRedirectUrls(port: number): string[];
export type LoopbackOutcome =
  | { kind: "code"; code: string }
  | { kind: "error"; status: number; message: string }
  | { kind: "mismatch" | "ignore"; status: number; message: string };
export function parseLoopbackCallback(requestUrl: string, expectedState: string | undefined): LoopbackOutcome;
export interface Loopback {
  port: number;
  redirectUrls: string[];
  redirectUrl: string;
  waitForCallback(state: string | undefined): Promise<{ code: string }>;
  /** Reject the pending round trip with a `SIGN_IN_CANCELLED` error; false when none was pending. */
  cancel(reason: string): boolean;
  close(): Promise<void>;
}
export function startLoopback(opts?: { port?: number; host?: string }): Promise<Loopback>;
export function openBrowser(url: string): Promise<boolean>;

export class FileOAuthProvider {
  constructor(opts: {
    serverUrl: string;
    file: string;
    redirectUrls: string[];
    /** A pre-registered public client: `clientInformation()` answers `{ client_id, token_endpoint_auth_method: "none" }` whatever the file holds, `saveClientInformation` stores nothing, `invalidateCredentials("all")` keeps it (tokens + discovery go). */
    clientId?: string | null;
    clientName?: string;
    log?: (message: string) => void;
    openBrowser?: (url: string) => Promise<boolean>;
    noBrowser?: boolean;
    /** Runs before the browser opens (RemoteAuth registers its loopback waiter here); may throw to abort the redirect. */
    onRedirect?: (pending: { url: string; state: string | undefined }) => void | Promise<void>;
  });
  serverUrl: string;
  file: string;
  redirectUrls: string[];
  clientId: string | null;
  pending: { url: string; state: string | undefined } | null;
  readonly redirectUrl: string;
  readonly clientMetadata: Record<string, unknown>;
  read(): TokenFile;
  patch(p: Partial<TokenFile> & Record<string, unknown>): void;
  state(): string;
  clientInformation(): Record<string, unknown> | undefined;
  saveClientInformation(info: Record<string, unknown>): void;
  tokens(): TokenFile["tokens"];
  saveTokens(tokens: Record<string, unknown>): void;
  saveCodeVerifier(v: string): void;
  codeVerifier(): string;
  saveDiscoveryState(d: Record<string, unknown>): void;
  discoveryState(): TokenFile["discovery"];
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void;
  redirectToAuthorization(url: URL): Promise<void>;
  identity(): Identity | null;
}

export class RemoteAuth {
  constructor(opts: {
    serverUrl: string;
    file?: string;
    legacyFile?: string | null;
    /** `--client-id`: present this public client, never register one; an `invalid_client` from the token endpoint is then a configuration error (`configuredClientRejected`), not a dead credential. */
    clientId?: string | null;
    /** Bind the loopback listener to this port (taken → `start()` rejects with `callbackPortInUse`); null = ephemeral, or `DEFAULT_CALLBACK_PORT` with a client id. */
    callbackPort?: number | null;
    /** `--reset-client`: forget the stored client registration (and its tokens) in `start()` and register anew. */
    resetClient?: boolean;
    log?: (message: string) => void;
    fetch?: typeof globalThis.fetch;
    openBrowser?: (url: string) => Promise<boolean>;
    noBrowser?: boolean;
    env?: Record<string, string | undefined>;
  });
  serverUrl: string;
  file: string;
  legacyFile: string | null;
  /** The configured public client, else null (dynamic registration). */
  clientId: string | null;
  /** The fixed loopback port, else null (ephemeral). */
  callbackPort: number | null;
  /** `--reset-client` was given. */
  resetClient: boolean;
  status: WhoAmI["auth"];
  /** ISO time of the last automatic recovery (a stored sign-in the issuer rejected, replaced by a fresh one). */
  recoveredAt: string | undefined;
  start(): Promise<this>;
  close(): Promise<void>;
  bearer(): string | undefined;
  identity(): Identity | null;
  issuer(): string | undefined;
  /** Which OAuth client the proxy presents (`/whoami`'s `auth.client`). */
  client(): { source: "configured" | "registered"; id: string | null };
  /** Subscribe to status changes; returns the unsubscribe. */
  onStatus(listener: (status: WhoAmI["auth"]) => void): () => void;
  /** The provider over the token file (after `start()`). */
  provider: FileOAuthProvider | undefined;
  loopback: Loopback | undefined;
  /** Where the current `auth()` pass is. */
  phase: "stored" | "browser";
  /** What the SDK's `auth()` last resolved to in the current pass. */
  lastResult: string | undefined;
  /** The error's message, or — for an empty one (an issuer answer without `error_description`) — one made from the phase and the issuer's answer. Never empty. */
  failureMessage(e: unknown): string;
  /** Drop the stored client registration and its tokens (`--reset-client`, `r`); with a configured id, the tokens only. Returns whether a registration was dropped. */
  resetRegistration(why: string): boolean;
  /** The issuer's metadata advertises a `registration_endpoint`. */
  advertisesRegistration(): boolean;
  /** Before a browser round trip with a registration this pass did not make: ask the token endpoint whether it still knows the client; throws a `CLIENT_UNKNOWN` error when not. */
  verifyRegistration(): Promise<void>;
  ensure(): Promise<void>;
  authorize(response?: Response): Promise<void>;
  fetchWithAuth(): typeof globalThis.fetch;
  /**
   * The terminal's `a` (re-open a waiting sign-in, else drop the tokens and sign in afresh), `r`
   * (`resetClient`: drop the client registration and its tokens, register anew) and `l` (`forget`:
   * delete the token file, then sign in fresh). A pending sign-in is superseded.
   */
  reauthorize(opts?: { forget?: boolean; resetClient?: boolean }): Promise<void>;
  logout(): boolean;
}

export class SessionTable<S extends { id: string | null; upstreamId?: () => string | undefined; timer?: unknown } = { id: string | null; upstreamId?: () => string | undefined; timer?: unknown }> {
  constructor(opts?: { idleMs?: number; onIdle?: (session: S) => void; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout });
  add(session: S): S;
  get(id: unknown): S | undefined;
  has(id: unknown): boolean;
  remove(id: string): S | undefined;
  touch(session: S): void;
  upstreamIdFor(id: string): string | undefined;
  readonly size: number;
  values(): S[];
  describe(): { id: string; upstream: string | null }[];
}

export function normalizeServerUrl(serverUrl: string): string;
export function callbackParams(href: string | URL): { code: string | null; state: string | null; error: string | null; errorDescription: string | null };
export function decodeJwtClaims(jwt: string | null | undefined): Record<string, unknown> | null;
export function identityFromTokens(tokens: { access_token?: string; id_token?: string; [k: string]: unknown } | null | undefined): Identity | null;
