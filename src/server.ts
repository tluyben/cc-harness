/**
 * server.ts
 *
 * Lightweight Deno HTTP server that exposes a single SSE endpoint:
 *
 *   POST /prompt
 *   Body: { prompt: string, dir: string, continue?: boolean }
 *
 * The server spawns `claude` in the requested working directory and streams
 * its --output-format stream-json events back as Server-Sent Events, one JSON
 * object per `data:` line.  A synthetic `{"type":"done"}` event is emitted
 * when the Claude process exits successfully.
 *
 * Configuration (environment variables):
 *   PORT        — listening port (default: 8080)
 *   CLAUDE_PATH — path to the claude binary (default: "claude")
 */

import { executeClause } from "./executor.ts";
import type { PromptRequest } from "./types.ts";

const enc = new TextEncoder();

function sseEvent(data: string): Uint8Array {
  return enc.encode(`data: ${data}\n\n`);
}

async function handlePrompt(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ---------- parse & validate body ----------
  let body: PromptRequest;
  try {
    body = await req.json();
  } catch {
    return json400("request body must be valid JSON");
  }

  const { prompt, dir, continue: cont = false } = body ?? {};

  if (!prompt || typeof prompt !== "string") {
    return json400("`prompt` is required and must be a non-empty string");
  }
  if (!dir || typeof dir !== "string") {
    return json400("`dir` is required and must be a non-empty string");
  }

  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) return json400("`dir` exists but is not a directory");
  } catch {
    return json400(`\`dir\` does not exist or is not accessible: ${dir}`);
  }

  // ---------- SSE stream ----------
  const abort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for await (
          const line of executeClause(
            { prompt, dir, continue: cont },
            abort.signal,
          )
        ) {
          ctrl.enqueue(sseEvent(line));
        }
        ctrl.enqueue(sseEvent(JSON.stringify({ type: "done" })));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctrl.enqueue(
          sseEvent(JSON.stringify({ type: "error", error: msg })),
        );
      } finally {
        ctrl.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function json400(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- routing ----------
function router(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (pathname === "/prompt") return handlePrompt(req);

  if (pathname === "/health" && req.method === "GET") {
    return Promise.resolve(
      new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

/** Start the server and return the Deno.HttpServer instance. */
export function startServer(port: number): Deno.HttpServer {
  const server = Deno.serve({ port, onListen: () => {} }, router);
  return server;
}

// ---------- entry point ----------
if (import.meta.main) {
  const PORT = parseInt(Deno.env.get("PORT") ?? "8080", 10);
  console.log(`cc-harnass listening on http://localhost:${PORT}`);
  console.log(`  claude binary : ${Deno.env.get("CLAUDE_PATH") ?? "claude"}`);
  startServer(PORT);
}
