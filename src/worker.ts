/**
 * worker.ts
 *
 * Background worker activated by the RETRIEVE_PROMPT_URL environment variable.
 *
 * Maintains a persistent SSE connection to the configured URL, receives prompt
 * jobs as JSON events, executes them one-at-a-time with Claude, and streams
 * each result back as NDJSON via HTTP POST.
 *
 * Incoming SSE event shape:
 *   { "user": string, "dir": string, "system"?: string,
 *     "continue"?: boolean, "as-user"?: string,
 *     "id"?: string, "response_url"?: string }
 *
 * Response POST body (NDJSON, one JSON object per line):
 *   Each Claude event line, optionally with `"id"` echoed for correlation.
 *   Final line: { "type": "done", ... }
 *
 * If "response_url" is absent in the job, responses are POSTed back to the
 * same RETRIEVE_PROMPT_URL.
 *
 * Authorization: if RETRIEVE_PROMPT_TOKEN is set it is sent as a Bearer token
 * on both the SSE GET request and every response POST.
 *
 * Reconnect: on any connection or parse error the worker backs off
 * exponentially (1 s → 30 s) and reconnects indefinitely.  A job that is
 * already running is never interrupted — the reconnect happens after it
 * completes.
 */

import { executeClause } from "./executor.ts";
import type { PromptRequest } from "./types.ts";

// ─── types ────────────────────────────────────────────────────────────────────

interface RemoteJob {
  /** Prompt text (maps to PromptRequest.prompt) */
  user: string;
  /** Working directory for Claude */
  dir: string;
  /** Optional system prompt passed to Claude via --system-prompt */
  system?: string;
  /** Resume most-recent conversation in dir (default false) */
  continue?: boolean;
  /** OS user to run Claude as (required if server is root) */
  "as-user"?: string;
  /** Optional correlation ID echoed in every response event */
  id?: string;
  /** POST response events here; defaults to the retrieve URL */
  response_url?: string;
}

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

// ─── SSE reader ──────────────────────────────────────────────────────────────

/**
 * Yield parsed RemoteJob objects from an SSE response body.
 * Each SSE event must carry a `data:` line containing valid JSON.
 */
async function* readJobs(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RemoteJob> {
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

        let job: RemoteJob;
        try {
          job = JSON.parse(data);
        } catch {
          console.error("[worker] non-JSON SSE data:", data);
          continue;
        }

        if (!job.user || typeof job.user !== "string") {
          console.error("[worker] job missing required field `user`:", data);
          continue;
        }
        if (!job.dir || typeof job.dir !== "string") {
          console.error("[worker] job missing required field `dir`:", data);
          continue;
        }

        yield job;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── response streaming ───────────────────────────────────────────────────────

/**
 * Execute `job` with Claude and POST each event line back to `responseUrl`
 * as a streaming NDJSON body.  Waits until the POST completes (i.e. the full
 * Claude response has been delivered) before returning.
 */
async function streamBack(
  responseUrl: string,
  token: string | undefined,
  job: RemoteJob,
): Promise<void> {
  const request: PromptRequest = {
    prompt: job.user,
    dir: job.dir,
    continue: job.continue ?? false,
    asUser: job["as-user"],
    systemPrompt: job.system,
  };

  const abort = new AbortController();
  const enc = new TextEncoder();
  const { id } = job;

  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for await (const line of executeClause(request, abort.signal)) {
          const out = id ? tagLine(line, id) : line;
          ctrl.enqueue(enc.encode(out + "\n"));
        }
        // Synthetic terminal event
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

  // Drain response to avoid resource leaks regardless of status
  await res.body?.cancel();

  if (!res.ok) {
    throw new Error(`response POST to ${responseUrl} returned ${res.status} ${res.statusText}`);
  }
}

// ─── session ─────────────────────────────────────────────────────────────────

/**
 * Open one SSE session to `url` and process all jobs until the stream closes.
 * Jobs are processed sequentially — a running job is never interrupted.
 */
async function runSession(url: string, token?: string): Promise<void> {
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

  for await (const job of readJobs(res.body)) {
    const responseUrl = job.response_url ?? url;
    console.log(
      `[worker] job received${job.id ? ` id=${job.id}` : ""} dir=${job.dir}`,
    );
    try {
      await streamBack(responseUrl, token, job);
      console.log(`[worker] job done${job.id ? ` id=${job.id}` : ""}`);
    } catch (err) {
      // Log the error but keep running — never let one bad job kill the worker
      console.error(`[worker] job error${job.id ? ` id=${job.id}` : ""}:`, err);
    }
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Start the retrieve worker.  Runs forever, reconnecting with exponential
 * back-off on any failure.  Never resolves — call without `await` to run in
 * the background alongside the HTTP server.
 */
export async function startWorker(url: string, token?: string): Promise<never> {
  console.log(`[worker] starting — retrieve URL: ${url}`);
  let backoff = 1_000;

  while (true) {
    try {
      await runSession(url, token);
      // Clean server-side close → reconnect immediately
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
