/**
 * worker.ts
 *
 * Background worker activated by the RETRIEVE_PROMPT_URL environment variable.
 *
 * Maintains a persistent SSE connection to the configured URL, receives frames
 * as JSON events, dispatches them, and streams each result back as NDJSON via
 * HTTP POST.
 *
 * Incoming frame types (discriminated by the optional `type` field; missing
 * `type` defaults to "prompt" for back-compat):
 *
 *   { "type": "prompt", "user": string, "dir": string, "system"?: string,
 *     "continue"?: boolean, "as-user"?: string,
 *     "id"?: string, "response_url"?: string }
 *
 *   { "type": "exec", "script": string, "args"?: object,
 *     "as-user"?: string, "id"?: string, "response_url"?: string }
 *
 *   { "type": "connected", ... }   — server hello, silently ignored
 *
 * Concurrency:
 *   • prompts are serialized per `dir` (one chat per dir at a time); different
 *     dirs run in parallel.
 *   • exec frames run immediately and are never queued.
 *
 * Response POST body (NDJSON, one JSON object per line):
 *   For prompts: each Claude event line, optionally with `"id"` echoed for
 *   correlation; final synthetic line `{ "type": "done", ... }`.
 *   For execs:   `{"type":"stdout","line":...}` / `{"type":"stderr",...}` and
 *   final `{"type":"done","exit":N}` (or `{"type":"error","error":"..."}` on
 *   validation/spawn failure).
 *
 * If "response_url" is absent in a frame, responses are POSTed back to the
 * same RETRIEVE_PROMPT_URL.
 *
 * Authorization: if RETRIEVE_PROMPT_TOKEN is set it is sent as a Bearer token
 * on both the SSE GET request and every response POST.
 *
 * Reconnect: on any connection or parse error the worker backs off
 * exponentially (1 s → 30 s) and reconnects indefinitely.  In-flight prompts
 * and execs are NOT interrupted by a reconnect — they keep streaming to their
 * own response_urls.
 */

import { executeClause } from "./executor.ts";
import { runScript, type ScriptRegistry } from "./scriptRunner.ts";
import type { PromptRequest } from "./types.ts";

// ─── types ────────────────────────────────────────────────────────────────────

interface PromptFrame {
  type: "prompt";
  /** Prompt text (maps to PromptRequest.prompt) */
  user: string;
  /** Working directory for Claude */
  dir: string;
  /** Optional system prompt */
  system?: string;
  /** Resume most-recent conversation in dir */
  continue?: boolean;
  /** OS user to run Claude as */
  asUser?: string;
  /** Optional correlation ID */
  id?: string;
  /** POST response events here; defaults to the retrieve URL */
  responseUrl?: string;
}

interface ExecFrame {
  type: "exec";
  script: string;
  args: Record<string, unknown>;
  asUser?: string;
  id?: string;
  responseUrl?: string;
}

type Frame = PromptFrame | ExecFrame;

// ─── helpers ─────────────────────────────────────────────────────────────────

function authHeaders(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

/** Inject `id` into a raw JSON line, silently pass it through if parsing fails. */
function tagLine(jsonLine: string, id: string): string {
  try {
    const obj = JSON.parse(jsonLine);
    return JSON.stringify({ ...obj, id });
  } catch {
    return jsonLine;
  }
}

/** Accept both "as-user" (canonical) and "asUser" (alias) from the wire. */
// deno-lint-ignore no-explicit-any
function readAsUser(raw: any): string | undefined {
  const v = raw["as-user"] ?? raw["asUser"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// deno-lint-ignore no-explicit-any
function readResponseUrl(raw: any): string | undefined {
  const v = raw["response_url"] ?? raw["responseUrl"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Parse one SSE `data:` payload into a typed Frame, or return null if the
 * frame should be ignored (e.g. `type:"connected"`, unknown type, or
 * malformed).  Logs reasons for skipped frames.
 */
function parseFrame(data: string): Frame | null {
  // deno-lint-ignore no-explicit-any
  let obj: any;
  try {
    obj = JSON.parse(data);
  } catch {
    console.error("[worker] non-JSON SSE data:", data);
    return null;
  }
  if (!obj || typeof obj !== "object") {
    console.error("[worker] SSE data not an object:", data);
    return null;
  }

  const type = typeof obj.type === "string" ? obj.type : "prompt";

  if (type === "connected") return null; // server hello — ignore silently

  if (type === "prompt") {
    if (typeof obj.user !== "string" || obj.user.length === 0) {
      console.error("[worker] prompt frame missing `user`:", data);
      return null;
    }
    if (typeof obj.dir !== "string" || obj.dir.length === 0) {
      console.error("[worker] prompt frame missing `dir`:", data);
      return null;
    }
    return {
      type: "prompt",
      user: obj.user,
      dir: obj.dir,
      system: typeof obj.system === "string" ? obj.system : undefined,
      continue: obj.continue === true,
      asUser: readAsUser(obj),
      id: typeof obj.id === "string" ? obj.id : undefined,
      responseUrl: readResponseUrl(obj),
    };
  }

  if (type === "exec") {
    if (typeof obj.script !== "string" || obj.script.length === 0) {
      console.error("[worker] exec frame missing `script`:", data);
      return null;
    }
    const args = obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
      ? obj.args as Record<string, unknown>
      : {};
    return {
      type: "exec",
      script: obj.script,
      args,
      asUser: readAsUser(obj),
      id: typeof obj.id === "string" ? obj.id : undefined,
      responseUrl: readResponseUrl(obj),
    };
  }

  console.error(`[worker] ignoring frame with unknown type \`${type}\`:`, data);
  return null;
}

// ─── SSE reader ──────────────────────────────────────────────────────────────

/** Exported for tests. */
export type { Frame, PromptFrame, ExecFrame };

export async function* readFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      // SSE event boundaries are separated by a blank line (\n\n)
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";

      for (const block of blocks) {
        let data: string | undefined;
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) {
            data = (data ?? "") + line.slice(5).trimStart();
          }
        }
        if (!data || data === "[DONE]") continue;

        const frame = parseFrame(data);
        if (frame) yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── response streaming: prompts ─────────────────────────────────────────────

/**
 * Execute a prompt frame with Claude and POST each event line back to
 * `responseUrl` as a streaming NDJSON body.  Waits until the POST completes.
 */
async function streamBackPrompt(
  responseUrl: string,
  token: string | undefined,
  frame: PromptFrame,
): Promise<void> {
  const request: PromptRequest = {
    prompt: frame.user,
    dir: frame.dir,
    continue: frame.continue ?? false,
    asUser: frame.asUser,
    systemPrompt: frame.system,
  };

  const abort = new AbortController();
  const enc = new TextEncoder();
  const { id } = frame;

  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for await (const line of executeClause(request, abort.signal)) {
          const out = id ? tagLine(line, id) : line;
          ctrl.enqueue(enc.encode(out + "\n"));
        }
        const done = JSON.stringify({ type: "done", ...(id ? { id } : {}) });
        ctrl.enqueue(enc.encode(done + "\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errLine = JSON.stringify({
          type: "error",
          error: msg,
          ...(id ? { id } : {}),
        });
        ctrl.enqueue(enc.encode(errLine + "\n"));
      } finally {
        ctrl.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  const res = await fetch(responseUrl, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-ndjson",
      ...authHeaders(token),
    },
    // Required for streaming request bodies (Fetch spec / Deno)
    // deno-lint-ignore no-explicit-any
    ...(({ duplex: "half" }) as any),
  });

  await res.body?.cancel();
  if (!res.ok) {
    throw new Error(`response POST to ${responseUrl} returned ${res.status} ${res.statusText}`);
  }
}

// ─── response streaming: exec ────────────────────────────────────────────────

/**
 * Run a registered script for `frame` and POST stdout/stderr lines back as
 * NDJSON, terminated by a `done` (or `error`) event.
 */
async function streamBackExec(
  responseUrl: string,
  token: string | undefined,
  frame: ExecFrame,
  registry: ScriptRegistry,
): Promise<void> {
  const abort = new AbortController();
  const enc = new TextEncoder();
  const { id } = frame;

  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for await (const ev of runScript(registry, frame, abort.signal)) {
          const payload = id ? { ...ev, id } : ev;
          ctrl.enqueue(enc.encode(JSON.stringify(payload) + "\n"));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errLine = JSON.stringify({
          type: "error",
          error: msg,
          ...(id ? { id } : {}),
        });
        ctrl.enqueue(enc.encode(errLine + "\n"));
      } finally {
        ctrl.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  const res = await fetch(responseUrl, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-ndjson",
      ...authHeaders(token),
    },
    // deno-lint-ignore no-explicit-any
    ...(({ duplex: "half" }) as any),
  });

  await res.body?.cancel();
  if (!res.ok) {
    throw new Error(`response POST to ${responseUrl} returned ${res.status} ${res.statusText}`);
  }
}

// ─── per-dir prompt queue ────────────────────────────────────────────────────

/**
 * Module-scope so it persists across SSE reconnects: in-flight prompts keep
 * streaming to their response_urls regardless of session state.
 */
const dirQueues = new Map<string, Promise<void>>();

/** Chain `work` onto the tail of `dir`'s queue; return when this work is done. */
function enqueueForDir(dir: string, work: () => Promise<void>): Promise<void> {
  const prev = dirQueues.get(dir) ?? Promise.resolve();
  // .then(work, work) so a failed predecessor doesn't poison the queue
  const next = prev.then(work, work);
  dirQueues.set(dir, next);
  // Clean up the map slot once this entry is the tail and has completed.
  next.finally(() => {
    if (dirQueues.get(dir) === next) dirQueues.delete(dir);
  });
  return next;
}

// ─── session ─────────────────────────────────────────────────────────────────

/**
 * Open one SSE session to `url` and dispatch frames until the stream closes.
 * Does NOT wait for in-flight jobs before returning — they continue in the
 * background even across reconnects.
 */
async function runSession(
  url: string,
  token: string | undefined,
  registry: ScriptRegistry,
): Promise<void> {
  const res = await fetch(url, {
    headers: {
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache",
      ...authHeaders(token),
    },
  });

  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("SSE response has no body");
  }
  console.log("[worker] SSE connected");

  for await (const frame of readFrames(res.body)) {
    const responseUrl = frame.responseUrl ?? url;

    if (frame.type === "prompt") {
      console.log(
        `[worker] prompt received${frame.id ? ` id=${frame.id}` : ""} dir=${frame.dir}`,
      );
      // Fire-and-track per dir; never blocks the read loop.
      enqueueForDir(frame.dir, async () => {
        try {
          await streamBackPrompt(responseUrl, token, frame);
          console.log(`[worker] prompt done${frame.id ? ` id=${frame.id}` : ""}`);
        } catch (err) {
          console.error(
            `[worker] prompt error${frame.id ? ` id=${frame.id}` : ""}:`,
            err,
          );
        }
      });
      continue;
    }

    // exec — immediate dispatch, no queueing
    console.log(
      `[worker] exec received${frame.id ? ` id=${frame.id}` : ""} script=${frame.script}`,
    );
    (async () => {
      try {
        await streamBackExec(responseUrl, token, frame, registry);
        console.log(`[worker] exec done${frame.id ? ` id=${frame.id}` : ""}`);
      } catch (err) {
        console.error(
          `[worker] exec error${frame.id ? ` id=${frame.id}` : ""}:`,
          err,
        );
      }
    })();
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Start the retrieve worker.  Runs forever, reconnecting with exponential
 * back-off on any failure.  Never resolves — call without `await` to run in
 * the background alongside the HTTP server.
 *
 * `registry` is the whitelist of scripts callable by `exec` frames; pass an
 * empty Map to reject all exec frames with an error event.
 */
export async function startWorker(
  url: string,
  token: string | undefined,
  registry: ScriptRegistry,
): Promise<never> {
  console.log(`[worker] starting — retrieve URL: ${url}`);
  if (registry.size > 0) {
    const names = [...registry.keys()].join(", ");
    console.log(`[worker] scripts registered: ${names}`);
  } else {
    console.log("[worker] scripts registered: (none — exec frames will error)");
  }

  let backoff = 1_000;

  while (true) {
    try {
      await runSession(url, token, registry);
      console.log("[worker] SSE stream ended cleanly, reconnecting …");
      backoff = 1_000;
    } catch (err) {
      console.error(`[worker] session error: ${err}`);
      console.error(`[worker] reconnecting in ${backoff}ms …`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
