/**
 * executor.ts
 *
 * Spawns a `claude` CLI subprocess and streams its output as newline-delimited
 * JSON events.  Wraps the low-level spawn with full error-handling:
 *
 *   • overloaded_error           → retry forever, exponential back-off
 *   • api_error / timeout_error
 *     / rate_limit_error         → retry up to MAX_LIMITED_RETRIES, back-off
 *   • authentication_error
 *     / billing_error            → rotate credentials_N.json, retry
 *   • invalid_request_error
 *     / permission_error
 *     / not_found_error
 *     / request_too_large        → fatal, propagate immediately
 *
 * Key CLI flags:
 *   --output-format stream-json   one JSON object per stdout line
 *   --verbose                     required alongside stream-json + -p
 *   --include-partial-messages    token-by-token streaming
 *   --dangerously-skip-permissions headless / non-interactive
 *   --continue                    resume most-recent conversation in cwd
 */

import type { PromptRequest } from "./types.ts";
import {
  backoffMs,
  classifyError,
  CredentialRotator,
  MAX_LIMITED_RETRIES,
  sleep,
} from "./errors.ts";

// ─── low-level spawn ──────────────────────────────────────────────────────────

/**
 * Resolve the home directory of `username` by querying `getent passwd`.
 * Throws a clear error if the user does not exist.
 */
async function getUserHome(username: string): Promise<string> {
  const result = await new Deno.Command("getent", {
    args: ["passwd", username],
    stdout: "piped",
    stderr: "null",
  }).output();
  const line = new TextDecoder().decode(result.stdout).trim();
  const parts = line.split(":");
  // passwd format: name:password:uid:gid:gecos:home:shell (7 fields)
  if (parts.length < 6 || !parts[5]) {
    throw new Error(`as-user: OS user not found: ${username}`);
  }
  return parts[5];
}

/**
 * Spawn `claude` once and yield each non-empty stdout line.
 * Throws if the process exits with a non-zero code.
 */
async function* spawnClaude(
  request: PromptRequest,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const claudePath = Deno.env.get("CLAUDE_PATH") || "claude";

  const claudeArgs: string[] = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose", // required by CLI when combining stream-json + -p
    "--include-partial-messages",
  ];

  // Load MCP servers from .mcp.json if present in workdir
  const mcpConfigPath = `${request.dir}/.mcp.json`;
  try {
    await Deno.stat(mcpConfigPath);
    claudeArgs.push("--mcp-config", "./.mcp.json");
  } catch {
    // .mcp.json doesn't exist - skip MCP config
  }

  if (request.systemPrompt) {
    claudeArgs.push("--system-prompt", request.systemPrompt);
  }

  if (request.continue) {
    claudeArgs.push("--continue");
  }

  claudeArgs.push("-p", request.prompt);

  // When `asUser` is set, drop privileges via `runuser` and update the
  // user-scoped env vars so Claude finds the right ~/.claude config.
  let cmd: string;
  let args: string[];
  let env = Deno.env.toObject();

  if (request.asUser) {
    const userHome = await getUserHome(request.asUser);
    env = { ...env, HOME: userHome, USER: request.asUser, LOGNAME: request.asUser };
    cmd = "runuser";
    args = ["-u", request.asUser, "--", claudePath, ...claudeArgs];
  } else {
    cmd = claudePath;
    args = claudeArgs;
  }

  const command = new Deno.Command(cmd, {
    args,
    cwd: request.dir,
    stdout: "piped",
    stderr: "piped",
    env,
  });

  const proc = command.spawn();

  // Drain stderr in background to prevent OS pipe-buffer deadlock.
  const stderrChunks: string[] = [];
  const stderrDone = (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(dec.decode(value));
      }
    } finally {
      reader.releaseLock();
    }
  })();

  const onAbort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  };
  signal?.addEventListener("abort", onAbort);

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";

  try {
    outer: while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
        if (signal?.aborted) break outer;
      }
    }

    const remaining = buf.trim();
    if (remaining) yield remaining;
  } finally {
    reader.releaseLock();
    signal?.removeEventListener("abort", onAbort);
    await stderrDone;

    const status = await proc.status;
    if (!status.success && !signal?.aborted) {
      const stderr = stderrChunks.join("").trim();
      throw new Error(
        `claude exited with code ${status.code}` + (stderr ? `\n${stderr}` : ""),
      );
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

interface ParsedError {
  errorType: string;
  message: string;
}

/**
 * If `line` is a Claude `{"type":"error",...}` event, return the structured
 * error.  Otherwise return null.
 */
function parseErrorEvent(line: string): ParsedError | null {
  try {
    const obj = JSON.parse(line);
    if (obj?.type === "error" && obj?.error?.type) {
      return { errorType: obj.error.type, message: obj.error.message ?? line };
    }
    // result with subtype error (e.g. {"type":"result","subtype":"error",...})
    if (obj?.type === "result" && obj?.subtype === "error") {
      return {
        errorType: obj.error?.type ?? "api_error",
        message: obj.error?.message ?? obj.result ?? line,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Try to extract a structured error from the raw process-exit error message
 * (which typically contains stderr from the CLI).
 */
function parseProcessError(err: unknown): ParsedError {
  const msg = err instanceof Error ? err.message : String(err);
  // Look for a known error type string anywhere in the message.
  const match = msg.match(
    /\b(overloaded_error|authentication_error|billing_error|rate_limit_error|api_error|timeout_error|invalid_request_error|permission_error|not_found_error|request_too_large)\b/,
  );
  return { errorType: match?.[1] ?? "api_error", message: msg };
}

/**
 * Returns true if `line` represents the start of generated content — i.e. the
 * first `content_block_delta` stream event.  Once this has been seen, we can
 * no longer silently retry (the client has already received partial data).
 */
function isContentDelta(line: string): boolean {
  try {
    const obj = JSON.parse(line);
    return (
      obj?.type === "stream_event" &&
      obj?.event?.type === "content_block_delta"
    );
  } catch {
    return false;
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Execute a Claude prompt with automatic retry and credential rotation.
 *
 * Yields each raw JSON line from `claude`'s stdout.  A synthetic
 * `{"type":"done"}` event is appended by the caller (server.ts) after the
 * generator completes.
 *
 * Error events are swallowed when a retry is possible and the client has not
 * yet received any content.  If an error occurs after content has started
 * streaming, it is forwarded to the caller as-is (we cannot "un-send" data).
 */
export async function* executeClause(
  request: PromptRequest,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const rotator = new CredentialRotator();
  let limitedAttempt = 0; // tracks RETRY_LIMITED + RETRY_FOREVER attempts for back-off

  main: while (true) {
    if (signal?.aborted) return;

    let contentStarted = false;
    // Buffer lines received before the first content_block_delta so we can
    // discard them on retry without the client seeing anything.
    const preBuffer: string[] = [];
    let pendingError: ParsedError | null = null;

    try {
      for await (const line of spawnClaude(request, signal)) {
        // Check for an inline error event from the CLI.
        const err = parseErrorEvent(line);
        if (err) {
          pendingError = err;
          break; // stop reading; handle below
        }

        if (!contentStarted) {
          if (isContentDelta(line)) {
            // Real content is arriving — flush pre-buffer and switch to live mode.
            for (const b of preBuffer) yield b;
            preBuffer.length = 0;
            contentStarted = true;
            yield line;
          } else {
            preBuffer.push(line);
          }
        } else {
          yield line;
        }
      }
    } catch (procErr) {
      pendingError = parseProcessError(procErr);
    }

    if (!pendingError) {
      // ── Success ──────────────────────────────────────────────────────────
      // Flush anything still in the pre-buffer (responses short enough to
      // have no content_block_delta events land entirely here).
      for (const b of preBuffer) yield b;
      rotator.reset(); // forget any rotation state
      return;
    }

    // ── Error handling ──────────────────────────────────────────────────────

    if (contentStarted) {
      // We already sent partial content — cannot retry transparently.
      // Forward the error event and stop.
      console.error(
        `[cc-harnass] ${pendingError.errorType} after content started; forwarding to client`,
      );
      yield JSON.stringify({
        type: "error",
        error: { type: pendingError.errorType, message: pendingError.message },
      });
      return;
    }

    // Error before any content — we can retry silently.
    const cls = classifyError(pendingError.errorType);

    if (cls === "forever") {
      const delay = backoffMs(limitedAttempt++, 2_000, 120_000);
      console.error(
        `[cc-harnass] ${pendingError.errorType} (overloaded) — retrying in ${delay}ms …`,
      );
      await sleep(delay);
      continue main;
    }

    if (cls === "limited") {
      if (limitedAttempt >= MAX_LIMITED_RETRIES) {
        console.error(
          `[cc-harnass] ${pendingError.errorType} — giving up after ${MAX_LIMITED_RETRIES} retries`,
        );
        yield JSON.stringify({
          type: "error",
          error: {
            type: pendingError.errorType,
            message: `Failed after ${MAX_LIMITED_RETRIES} retries: ${pendingError.message}`,
          },
        });
        return;
      }
      const delay = backoffMs(limitedAttempt++, 1_000, 60_000);
      console.error(
        `[cc-harnass] ${pendingError.errorType} — attempt ${limitedAttempt}/${MAX_LIMITED_RETRIES}, retrying in ${delay}ms …`,
      );
      await sleep(delay);
      continue main;
    }

    if (cls === "rotate") {
      const advanced = await rotator.advance();
      if (!advanced) {
        console.error(
          `[cc-harnass] ${pendingError.errorType} — all credentials exhausted`,
        );
        yield JSON.stringify({
          type: "error",
          error: {
            type: pendingError.errorType,
            message: `All credentials exhausted: ${pendingError.message}`,
          },
        });
        return;
      }
      // No delay needed — the credential switch is the recovery action.
      continue main;
    }

    // cls === "fatal"
    console.error(
      `[cc-harnass] ${pendingError.errorType} (fatal) — not retrying`,
    );
    yield JSON.stringify({
      type: "error",
      error: { type: pendingError.errorType, message: pendingError.message },
    });
    return;
  }
}
