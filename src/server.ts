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
import { handleMcp } from "./mcp.ts";
import { setupClaudeTools } from "./setup.ts";
import type { PromptRequest } from "./types.ts";
import { startWorker } from "./worker.ts";

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

  // `as-user` is hyphenated so must be extracted via index access
  // deno-lint-ignore no-explicit-any
  const raw = (body as any) ?? {};
  const { prompt, dir, continue: cont = false } = raw;
  const asUser: string | undefined = raw["as-user"] || undefined;

  if (!prompt || typeof prompt !== "string") {
    return json400("`prompt` is required and must be a non-empty string");
  }
  if (!dir || typeof dir !== "string") {
    return json400("`dir` is required and must be a non-empty string");
  }
  if (asUser !== undefined && typeof asUser !== "string") {
    return json400("`as-user` must be a non-empty string when provided");
  }

  // Claude must never run as root. If the server itself is root, `as-user` is
  // mandatory so we always drop privileges before spawning Claude.
  const isRoot = Deno.uid() === 0;
  if (isRoot && !asUser) {
    return json400(
      "`as-user` is required: the server is running as root and Claude cannot run as root",
    );
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
            { prompt, dir, continue: cont, asUser },
            abort.signal,
          )
        ) {
          ctrl.enqueue(sseEvent(line));
        }
        const outputFiles = await listOutputFiles();
        ctrl.enqueue(sseEvent(JSON.stringify({ type: "done", files: outputFiles })));
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

/** List files in $HOME/output/ — returns empty array if dir is absent/empty. */
async function listOutputFiles(): Promise<string[]> {
  const home = Deno.env.get("HOME");
  if (!home) return [];
  const outputDir = `${home}/output`;
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(outputDir)) {
      if (entry.isFile) names.push(entry.name);
    }
    return names.sort();
  } catch {
    return [];
  }
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
  if (pathname === "/mcp") return handleMcp(req);

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

// ---------- .env loader -------------------------------------------------------

/**
 * Load a .env file from the current working directory, giving precedence to
 * variables already set in the process environment (CLI wins over .env).
 * Silently ignored when the file does not exist.
 */
async function loadDotEnv(): Promise<void> {
  let text: string;
  try {
    text = await Deno.readTextFile(".env");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double)
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) val = val.slice(1, -1);
    if (key && !Deno.env.has(key)) Deno.env.set(key, val);
  }
}

// ---------- entry point ----------
if (import.meta.main) {
  await loadDotEnv();
  const PORT = parseInt(Deno.env.get("PORT") ?? "8080", 10);
  // Run optional Claude tool setup before accepting requests.
  await setupClaudeTools();

  // Start the retrieve worker if a URL is configured (fire-and-forget).
  const retrieveUrl = Deno.env.get("RETRIEVE_PROMPT_URL");
  if (retrieveUrl) {
    const retrieveToken = Deno.env.get("RETRIEVE_PROMPT_TOKEN") || undefined;
    startWorker(retrieveUrl, retrieveToken); // intentionally not awaited
  }

  console.log(`cc-harnass listening on http://localhost:${PORT}`);
  console.log(`  claude binary : ${Deno.env.get("CLAUDE_PATH") ?? "claude"}`);
  startServer(PORT);
}
