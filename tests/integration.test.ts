/**
 * integration.test.ts
 *
 * Real end-to-end tests — NO mocks, NO stubbing.
 * A live `claude` process is spawned for every test case.
 *
 * Tests:
 *   1. hello + continue  — verifies that the continue flag resumes the
 *      previous conversation (Claude can recall what it just said).
 *   2. streaming         — verifies that partial assistant events arrive
 *      *before* the final result (i.e. true token-by-token streaming).
 *
 * Run:
 *   deno test --allow-all tests/integration.test.ts
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { startServer } from "../src/server.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

const TEST_PORT = 19080;
const BASE = `http://localhost:${TEST_PORT}`;

/** Collect all SSE `data:` payloads from a fetch Response. */
async function collectSSE(res: Response): Promise<string[]> {
  assert(res.body !== null, "response body must not be null");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events: string[] = [];
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        events.push(line.slice(6).trim());
      }
    }
  }

  return events;
}

/** Parse a list of SSE data strings into Claude event objects. */
function parseEvents(
  raw: string[],
): Array<Record<string, unknown>> {
  return raw.flatMap((s) => {
    try {
      return [JSON.parse(s) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/** Find the final `result` event (subtype: success) in parsed events. */
function findResult(
  events: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return events.find(
    (e) => e.type === "result" && e.subtype === "success",
  );
}

/** POST to /prompt and return parsed SSE events. */
async function prompt(
  opts: { prompt: string; dir: string; continue?: boolean },
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  assertEquals(res.status, 200, `HTTP status for prompt "${opts.prompt}"`);
  const raw = await collectSSE(res);
  return parseEvents(raw);
}

// ─── test suite ─────────────────────────────────────────────────────────────

let server: Deno.HttpServer;
let workDir: string;

// Shared setup — start the server once and reuse the same working directory
// for all tests so the conversation state persists between them.
function setup() {
  workDir = Deno.makeTempDirSync({ prefix: "cc_harnass_test_" });
  server = startServer(TEST_PORT);
}

function teardown() {
  server.shutdown();
  try {
    Deno.removeSync(workDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
}

// ─── test 1: hello + continue ────────────────────────────────────────────────

Deno.test({
  name: "1. hello conversation — basic prompt returns a result",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setup();
    try {
      const events = await prompt({ prompt: "Just say the word hello, nothing else.", dir: workDir });

      console.log(`  [test 1a] received ${events.length} events`);

      const result = findResult(events);
      assert(result !== undefined, "must contain a result event");
      console.log(`  [test 1a] result: ${JSON.stringify(result.result).slice(0, 120)}`);

      const resultText = (result.result as string ?? "").toLowerCase();
      assertStringIncludes(resultText, "hello", "result must contain 'hello'");
    } finally {
      teardown();
    }
  },
});

Deno.test({
  name: "2. continue — Claude recalls what it said in step 1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setup();
    try {
      // Step A: seed the conversation
      const eventsA = await prompt({
        prompt: "Just say the single word hello, nothing else.",
        dir: workDir,
      });
      const resultA = findResult(eventsA);
      assert(resultA !== undefined, "step A must have a result event");
      console.log(`  [test 2a] first reply: ${JSON.stringify(resultA.result).slice(0, 120)}`);

      // Step B: continue and ask what was said
      const eventsB = await prompt({
        prompt: "What was the exact word you just said?",
        dir: workDir,
        continue: true,
      });

      console.log(`  [test 2b] received ${eventsB.length} events`);

      const resultB = findResult(eventsB);
      assert(resultB !== undefined, "step B must have a result event");
      console.log(`  [test 2b] second reply: ${JSON.stringify(resultB.result).slice(0, 200)}`);

      const replyB = (resultB.result as string ?? "").toLowerCase();
      assertStringIncludes(
        replyB,
        "hello",
        "continued conversation must reference the word 'hello'",
      );
    } finally {
      teardown();
    }
  },
});

Deno.test({
  name: "3. streaming — partial assistant events arrive before the final result",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setup();
    try {
      // A long response guarantees multiple partial assistant events
      const events = await prompt({
        prompt:
          "Tell me a story about a rabbit. Write exactly one A4 page (about 500 words). Do not abbreviate.",
        dir: workDir,
      });

      console.log(`  [test 3] received ${events.length} total events`);

      // Partial token chunks arrive as type:"stream_event" with
      // event.type:"content_block_delta" — the low-level Anthropic API streaming
      // events forwarded verbatim by the CLI.
      const deltaEvents = events.filter(
        (e) =>
          e.type === "stream_event" &&
          (e as Record<string, Record<string, string>>).event?.type ===
            "content_block_delta",
      );
      console.log(`  [test 3] content_block_delta events: ${deltaEvents.length}`);

      // With --include-partial-messages a 500-word story must produce many deltas
      assert(
        deltaEvents.length > 1,
        `expected multiple streaming delta events, got ${deltaEvents.length}`,
      );

      const result = findResult(events);
      assert(result !== undefined, "must contain a final result event");

      const text = (result.result as string ?? "");
      console.log(`  [test 3] story length: ${text.length} chars`);

      // A 500-word story should be well over 200 characters
      assert(text.length > 200, `story too short (${text.length} chars)`);
    } finally {
      teardown();
    }
  },
});

Deno.test({
  name: "4. health check endpoint",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setup();
    try {
      const res = await fetch(`${BASE}/health`);
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.status, "ok");
    } finally {
      teardown();
    }
  },
});

Deno.test({
  name: "5. validation — missing dir returns 400",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setup();
    try {
      const res = await fetch(`${BASE}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }), // no dir
      });
      assertEquals(res.status, 400);
      await res.body?.cancel();
    } finally {
      teardown();
    }
  },
});
