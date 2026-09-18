import type { Workspace } from "@omgbase/core";
import type { IO } from "../render.js";
import { Style } from "../style.js";
import { makeCli } from "../context.js";
import { CliUsageError, EXIT_OK, EXIT_ERROR, EXIT_USAGE, renderError } from "../output.js";
import { runCommand, parseGlobals } from "../dispatch.js";
import { tokenize, TokenizeError } from "./tokenize.js";
import {
  parseRef,
  deriveRows,
  coerce,
  RefError,
  type Row,
  type Captured,
  type ParsedRef,
} from "./refs.js";

// The persistent shell runtime (11 shell). One open Workspace/store is reused
// across every line (that is the point — no per-command startup cost), and
// typed command results become ephemeral session state:
//
//   @1 … @N   rows of the most recent displayed collection frame
//   @_        the previous command's typed result
//   @name     a named binding created with `@name = <command | @ref>`
//
// A binding is a snapshot of a typed value, never a live query (the note): using
// it later does not re-run anything. The shell stores and dereferences; all data
// semantics (filter/map/traverse/join) stay in OQX. `session.exec(line)` is the
// single entry point, which makes the session drivable from a test harness or a
// future Markdown CLI-session runner, not just interactive readline.

export interface ShellSessionOptions {
  /** The shared local workspace. Omitted in remote (`--server`) mode: every line
   *  routes over MCP and never touches a local store. */
  workspace?: Workspace;
  cwd: string;
  io: IO;
  /** Force plain styling for the shell's own notices (matches the command tier). */
  noColor?: boolean;
  /** Remote engine address (`--server <cmd|url>`): threaded into every line so
   *  each command runs against the remote engine and shares one connection. */
  server?: string;
}

export class ShellSession {
  private readonly workspace: Workspace | undefined;
  private readonly cwd: string;
  private readonly io: IO;
  private readonly style: Style;
  private readonly server: string | undefined;

  private readonly bindings = new Map<string, Captured>();
  private frame: Row[] | null = null;
  private last: { value: unknown } | undefined;

  /** Set by `exit`/`quit`; the interactive loop watches this. */
  exited = false;

  constructor(opts: ShellSessionOptions) {
    this.workspace = opts.workspace;
    this.cwd = opts.cwd;
    this.io = opts.io;
    this.server = opts.server;
    const noColor = opts.noColor ?? !opts.io.stdoutTTY;
    this.style = new Style({ noColor, isTTY: opts.io.stdoutTTY });
  }

  /** Execute one input line. Returns an exit code (0 ok, 1 error, 2 usage). */
  async exec(line: string): Promise<number> {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return EXIT_OK; // blank / comment

    let tokens: string[];
    try {
      tokens = tokenize(line);
    } catch (err) {
      if (err instanceof TokenizeError) return this.usage(err.message);
      throw err;
    }
    if (tokens.length === 0) return EXIT_OK;

    try {
      const head = tokens[0]!;
      switch (head) {
        case "exit":
        case "quit":
          this.exited = true;
          return EXIT_OK;
        case "unset":
          return this.doUnset(tokens.slice(1));
        case "bindings":
          return this.doBindings();
        case "?":
          return this.doShellHelp();
        default: {
          const ref = parseRef(head); // null unless `@…`; throws on a malformed `@…`
          // `@name = <command | @ref>` binds a snapshot (the command runs
          // quietly). A bare reference on its own line inspects the value (and,
          // if it's a collection, makes it the addressable frame). Anything else
          // is a normal omg command line with `@refs` substituted into its argv.
          if (ref && tokens[1] === "=") return await this.doAssign(ref, tokens.slice(2));
          if (ref && tokens.length === 1) return this.inspect(head);
          return await this.runLine(tokens);
        }
      }
    } catch (err) {
      if (err instanceof RefError || err instanceof CliUsageError || err instanceof TokenizeError) {
        return this.usage(err.message);
      }
      return renderError(err, this.io, this.style, false);
    }
  }

  // ---- builtins -------------------------------------------------------------

  /**
   * `@name = <command | @ref>` — bind a snapshot of a result under `name`.
   * A command runs quietly (stdout suppressed); a bare `@ref` copies its value.
   * The target must be a plain name (no `[i]`/`.field`, not `@_`/`@N`).
   */
  private async doAssign(target: ParsedRef, rhs: string[]): Promise<number> {
    const name = target.base;
    if (target.index !== undefined || target.field !== undefined) {
      return this.usage("cannot assign to @name[i] or @name.field — bind a whole result to @name");
    }
    if (!/^[A-Za-z][\w-]*$/.test(name) || name === "_") {
      return this.usage(`bad binding name '@${name}' (use a letter-led identifier)`);
    }
    if (rhs.length === 0) return this.usage("@name = <command | @ref>");

    let captured: Captured;
    if (rhs.length === 1 && parseRef(rhs[0]!)) {
      // @x = @ref  — snapshot the referenced value.
      const { value } = this.resolveRef(rhs[0]!);
      captured = { value, rows: deriveRows(value) };
    } else {
      // @x = <command>  — run it quietly (stdout suppressed) and snapshot the
      // typed result. Diagnostics/errors still reach the user via stderr.
      const substituted = this.substitute(rhs);
      let value: unknown;
      const code = await this.dispatch(substituted, (v) => (value = v), true);
      if (code !== EXIT_OK) return code; // command failed → don't bind
      captured = { value, rows: deriveRows(value) };
    }

    this.bindings.set(name, captured);
    this.last = { value: captured.value };
    this.io.err(this.style.dim(`  @${name} = ${this.summary(captured)}`));
    return EXIT_OK;
  }

  private doUnset(rest: string[]): number {
    const name = rest[0];
    if (!name) return this.usage("unset <name>");
    if (this.bindings.delete(name)) {
      this.io.err(this.style.dim(`  unset @${name}`));
    } else {
      this.io.err(this.style.dim(`  no binding @${name}`));
    }
    return EXIT_OK;
  }

  private doBindings(): number {
    if (this.bindings.size === 0) {
      this.io.err(this.style.dim("  no bindings"));
      return EXIT_OK;
    }
    for (const [name, cap] of this.bindings) {
      this.io.out(`${this.style.accent(`@${name}`)}  ${this.style.dim(this.summary(cap))}`);
    }
    return EXIT_OK;
  }

  private doShellHelp(): number {
    const { io, style } = this;
    const line = (s: string) => io.out("  " + s);
    io.out(style.bold("  omg shell — session bindings"));
    line(style.dim("run any omg command; results become addressable:"));
    line(`${style.accent("@1 @2 …")}   ${style.dim("rows of the last displayed collection")}`);
    line(`${style.accent("@_")}         ${style.dim("the previous command's result")}`);
    line(`${style.accent("@name")}      ${style.dim("a named binding (also @name[i], @name.field)")}`);
    line("");
    line(`${style.accent("@x = <cmd|@ref>")}      ${style.dim("bind a snapshot of a result")}`);
    line(`${style.accent("unset x")}              ${style.dim("drop a binding")}`);
    line(`${style.accent("bindings")}             ${style.dim("list bindings")}`);
    line(`${style.accent("exit")} / ${style.accent("quit")}          ${style.dim("leave the shell")}`);
    return EXIT_OK;
  }

  // ---- command lines --------------------------------------------------------

  /** A normal omg command line: substitute refs, dispatch, record the result. */
  private async runLine(tokens: string[]): Promise<number> {
    const substituted = this.substitute(tokens);
    return this.dispatch(substituted, (v) => this.record(v), false);
  }

  /**
   * Build a per-line Cli over the shared Workspace and run the command through
   * the same path as a one-shot invocation (freshness sweep + dispatch + error
   * mapping). `sink` receives the command's typed result; `quiet` drops stdout
   * (used by `let`, which snapshots rather than displays).
   */
  private async dispatch(tokens: string[], sink: (v: unknown) => void, quiet: boolean): Promise<number> {
    const { flags, command, rest } = parseGlobals(tokens);
    if (!command) return EXIT_OK;
    // In a remote session, thread the server address into every line (unless the
    // line names its own) so each command runs against the shared remote engine.
    if (this.server !== undefined && flags.server === undefined) flags.server = this.server;
    const io = quiet ? this.quietIO() : this.io;
    const cli = makeCli(flags, io, { ...(this.workspace ? { workspace: this.workspace } : {}), cwd: this.cwd, capture: sink });
    return runCommand(cli, command, rest);
  }

  /** Update @_ and, when the result is a collection, replace the numbered frame. */
  private record(value: unknown): void {
    this.last = { value };
    const rows = deriveRows(value);
    if (rows) {
      this.frame = rows;
      if (rows.length > 0) {
        this.io.err(this.style.dim(`  ${rows.length} row${rows.length === 1 ? "" : "s"} — address with @1..@${rows.length}`));
      }
    }
  }

  /** Inspect a bare `@ref` line: print it and, if a collection, make it the frame. */
  private inspect(token: string): number {
    const { value, ref } = this.resolveRef(token);
    const rows = deriveRows(value);
    if (rows) {
      this.frame = rows;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        this.io.out(`${this.style.dim(`[${i + 1}]`)} ${this.style.id(r.ref)}  ${this.style.accent(r.label)}`.trimEnd());
      }
      this.io.err(this.style.dim(`  ${rows.length} row${rows.length === 1 ? "" : "s"}`));
    } else if (typeof value === "string") {
      this.io.out(value);
    } else if (ref !== undefined) {
      this.io.out(ref);
    } else {
      // A scalar or a record: show its id/locator if coercible, else JSON.
      try {
        this.io.out(coerce(value));
      } catch {
        this.io.out(JSON.stringify(value));
      }
    }
    this.last = { value };
    return EXIT_OK;
  }

  // ---- reference resolution -------------------------------------------------

  /** Replace whole-token `@refs` with their coerced argv strings. */
  private substitute(tokens: string[]): string[] {
    return tokens.map((t) => {
      const parsed = parseRef(t);
      if (!parsed) return t;
      const { value, ref } = this.resolveRef(t);
      // A known row id is used verbatim; otherwise coerce (which refuses a bare
      // collection, forcing the user to pick a row with [i]).
      return ref ?? coerce(value);
    });
  }

  /**
   * Resolve a reference token to its typed value plus, when known, a direct
   * argv-usable id/locator. Coercion is deferred to the caller (substitution)
   * so that inspecting a bare collection reference does not error.
   */
  resolveRef(token: string): { value: unknown; ref?: string } {
    const parsed = parseRef(token);
    if (!parsed) throw new RefError(`not a reference: '${token}'`);

    let value: unknown;
    let ref: string | undefined; // a known id/locator for the current row, if any

    if (parsed.base === "_") {
      if (!this.last) throw new RefError("no previous result (@_)");
      value = this.last.value;
    } else if (/^\d+$/.test(parsed.base)) {
      if (!this.frame) throw new RefError("no displayed collection to index with @N");
      const row = this.frame[Number(parsed.base) - 1];
      if (!row) throw new RefError(`@${parsed.base} out of range (${this.frame.length} row${this.frame.length === 1 ? "" : "s"})`);
      value = row.value;
      ref = row.ref;
    } else {
      const binding = this.bindings.get(parsed.base);
      if (!binding) throw new RefError(`no binding @${parsed.base}`);
      value = binding.value;
    }

    if (parsed.index !== undefined) {
      const rows = deriveRows(value);
      if (!rows) throw new RefError(`@${parsed.base} is not a collection to index with [i]`);
      const row = rows[parsed.index - 1];
      if (!row) throw new RefError(`[${parsed.index}] out of range (${rows.length} item${rows.length === 1 ? "" : "s"})`);
      value = row.value;
      ref = row.ref;
    }

    if (parsed.field !== undefined) {
      if (!value || typeof value !== "object") throw new RefError(`cannot read .${parsed.field} of a non-object`);
      const o = value as Record<string, unknown>;
      if (!(parsed.field in o)) throw new RefError(`no field .${parsed.field}`);
      value = o[parsed.field];
      ref = undefined; // no longer a row id — coerce from the field value
    }

    return ref !== undefined ? { value, ref } : { value };
  }

  // ---- helpers --------------------------------------------------------------

  private summary(cap: Captured): string {
    if (cap.rows) return `${cap.rows.length} row${cap.rows.length === 1 ? "" : "s"}`;
    const v = cap.value;
    if (typeof v === "string") return v.length > 48 ? `"${v.slice(0, 45)}…"` : `"${v}"`;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const id = o.id ?? o.node ?? o.path ?? o.locator;
      return id ? String(id) : "record";
    }
    return "empty";
  }

  private usage(message: string): number {
    this.io.err(`${this.style.err("usage")}: ${message}`);
    return EXIT_USAGE;
  }

  /** An IO that drops stdout (data) but forwards stderr (diagnostics). */
  private quietIO(): IO {
    const base = this.io;
    return {
      out: () => {},
      err: (s) => base.err(s),
      stdoutTTY: base.stdoutTTY,
      stderrTTY: base.stderrTTY,
    };
  }
}

export { EXIT_OK, EXIT_ERROR };
