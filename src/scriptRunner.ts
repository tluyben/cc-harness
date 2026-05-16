/**
 * scriptRunner.ts
 *
 * Whitelisted local script execution for worker-pushed `exec` frames.
 *
 * Scripts are declared on the server CLI with one or more
 *   --script <name>=<path>[:<arg1>,<arg2>,...]
 * flags.  Only registered names can be invoked.  Args are passed positionally
 * in declared order — the server sends them by name, this module looks them
 * up against the registry and rejects unknown / missing keys.
 *
 * Each invocation yields a stream of structured events:
 *   { type: "stdout", line }   — one per stdout line
 *   { type: "stderr", line }   — one per stderr line
 *   { type: "done",   exit }   — terminal, exit code
 *   { type: "error",  error }  — validation / spawn error (terminal)
 */

export interface ScriptDef {
  path: string;
  args: string[]; // ordered list of arg names
}

export type ScriptRegistry = Map<string, ScriptDef>;

export interface ExecRequest {
  script: string;
  args: Record<string, unknown>;
  asUser?: string;
}

export type ExecEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "done"; exit: number }
  | { type: "error"; error: string };

// ─── CLI parsing ──────────────────────────────────────────────────────────────

/**
 * Parse repeated `--script name=path[:arg1,arg2,...]` flags from a CLI argv.
 * Throws on malformed specs.  Unknown flags are ignored (so the same argv can
 * carry other server flags too).
 */
export function parseScriptFlags(argv: string[]): ScriptRegistry {
  const reg: ScriptRegistry = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let spec: string | undefined;
    if (a === "--script") spec = argv[++i];
    else if (a.startsWith("--script=")) spec = a.slice("--script=".length);
    else continue;

    if (!spec) throw new Error("--script requires a value");
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--script spec must be name=path[:args]: ${spec}`);
    }
    const name = spec.slice(0, eq).trim();
    const rest = spec.slice(eq + 1);
    const colon = rest.indexOf(":");
    let path: string;
    let argNames: string[];
    if (colon < 0) {
      path = rest;
      argNames = [];
    } else {
      path = rest.slice(0, colon);
      argNames = rest.slice(colon + 1)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (!name) throw new Error(`--script: empty name in ${spec}`);
    if (!path) throw new Error(`--script: empty path in ${spec}`);
    if (reg.has(name)) {
      throw new Error(`--script: duplicate script name: ${name}`);
    }
    reg.set(name, { path, args: argNames });
  }
  return reg;
}

// ─── runner ──────────────────────────────────────────────────────────────────

/**
 * Resolve a frame's named args against a script's declared arg order.
 * Returns either positional argv values or an error string.
 */
function resolveArgs(
  def: ScriptDef,
  provided: Record<string, unknown>,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const expected = new Set(def.args);
  for (const k of Object.keys(provided)) {
    if (!expected.has(k)) {
      return { ok: false, error: `unknown arg \`${k}\`` };
    }
  }
  const argv: string[] = [];
  for (const name of def.args) {
    const v = provided[name];
    if (v === undefined || v === null) {
      return { ok: false, error: `missing arg \`${name}\`` };
    }
    argv.push(String(v));
  }
  return { ok: true, argv };
}

/**
 * Spawn the registered script for `req` and yield interleaved stdout/stderr
 * lines followed by a terminal `done` (or `error`) event.  Never throws —
 * failures surface as `{type:"error"}` events.
 */
export async function* runScript(
  registry: ScriptRegistry,
  req: ExecRequest,
  signal?: AbortSignal,
): AsyncGenerator<ExecEvent> {
  const def = registry.get(req.script);
  if (!def) {
    yield { type: "error", error: `unknown script: ${req.script}` };
    return;
  }

  const resolved = resolveArgs(def, req.args ?? {});
  if (!resolved.ok) {
    yield { type: "error", error: `${req.script}: ${resolved.error}` };
    return;
  }

  let cmd: string;
  let argv: string[];
  if (req.asUser) {
    cmd = "runuser";
    argv = ["-u", req.asUser, "--", def.path, ...resolved.argv];
  } else {
    cmd = def.path;
    argv = resolved.argv;
  }

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args: argv,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    yield { type: "error", error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    return;
  }

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  };
  signal?.addEventListener("abort", onAbort);

  // Bounded channel that pumpers push events to and the generator pulls from.
  // Lets us interleave stdout + stderr without losing ordering within a stream.
  const queue: ExecEvent[] = [];
  const waiters: Array<() => void> = [];
  const wake = () => {
    const w = waiters.shift();
    if (w) w();
  };
  const push = (e: ExecEvent) => {
    queue.push(e);
    wake();
  };

  async function pump(
    stream: ReadableStream<Uint8Array>,
    type: "stdout" | "stderr",
  ): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) push({ type, line });
      }
      if (buf.length > 0) push({ type, line: buf });
    } finally {
      reader.releaseLock();
    }
  }

  const pumps = Promise.all([
    pump(child.stdout, "stdout"),
    pump(child.stderr, "stderr"),
  ]);

  // Background: when both pumps finish, push terminal event.
  let finished = false;
  pumps
    .then(async () => {
      const status = await child.status;
      push({ type: "done", exit: status.code });
    })
    .catch((err) => {
      push({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      finished = true;
      // Wake any pending waiter so the generator's loop can exit.
      wake();
    });

  try {
    while (true) {
      if (queue.length === 0) {
        if (finished) break;
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      const ev = queue.shift()!;
      yield ev;
      if (ev.type === "done" || ev.type === "error") break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
