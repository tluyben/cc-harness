# cc-harnass

A minimal Deno HTTP server that wraps **Claude Code** (or any compatible CLI AI
tool) and exposes it as a streaming **Server-Sent Events** endpoint.

Send a prompt + working directory → receive a real-time SSE stream of Claude's
token-by-token response, finishing with a final `result` event.

---

## Quick start

```bash
# Development (live reload)
deno task dev
# or
npm run dev          # if you have Deno installed and prefer npm scripts

# Production binary (single self-contained executable, current architecture)
npm run build        # → dist/cc-harnass
./dist/cc-harnass
```

---

## API

### `POST /prompt`

Stream a new (or continued) conversation.

**Request body** (JSON):

| Field      | Type    | Required | Description                                           |
|------------|---------|----------|-------------------------------------------------------|
| `prompt`   | string  | ✅        | The message to send to Claude                        |
| `dir`      | string  | ✅        | Absolute path to the project working directory        |
| `continue` | boolean | ❌        | `true` → append to the most recent conversation (`-c`). Default: `false` |

**Response** — `text/event-stream` (SSE)

Each `data:` line is a newline-delimited JSON object emitted by
`claude --output-format stream-json --include-partial-messages`.
Common event shapes:

```
data: {"type":"system","subtype":"init","session_id":"..."}
data: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Hello"}}}
data: {"type":"result","subtype":"success","result":"Hello!","session_id":"..."}
data: {"type":"done"}                           ← synthetic, harness clean exit
data: {"type":"error","error":{"type":"…","message":"…"}}  ← on unrecoverable error
```

### `GET /health`

Returns `{"status":"ok"}` — useful for readiness probes.

---

## Configuration

| Variable     | Default   | Description                          |
|--------------|-----------|--------------------------------------|
| `PORT`       | `8080`    | TCP port the server listens on       |
| `CLAUDE_PATH`| `claude`  | Path to the Claude CLI binary        |

```bash
PORT=3000 CLAUDE_PATH=/opt/claude/bin/claude ./dist/cc-harnass
```

---

## Example usage

```bash
# New conversation
curl -N -X POST http://localhost:8080/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Just say hello","dir":"/tmp/myproject"}'

# Continue the same conversation
curl -N -X POST http://localhost:8080/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What did you just say?","dir":"/tmp/myproject","continue":true}'
```

---

## Running tests

Tests are **real integration tests** — they spawn live `claude` processes and
assert on actual responses. No mocks.

```bash
deno task test
# or
npm test
```

Tests cover:
1. Basic prompt → result event
2. `continue: true` — Claude correctly recalls the prior turn
3. Streaming — multiple partial `assistant` events arrive before `result`
4. Health endpoint
5. Input validation (400 on missing fields)

---

## Error handling & retries

The harness follows the
[Claude API error taxonomy](https://platform.claude.com/docs/en/api/errors)
and applies different recovery strategies automatically:

| Error | Strategy |
|---|---|
| `529 overloaded_error` | **Retry forever** — exponential back-off (2 s base, 120 s cap, full jitter). The API will eventually clear. |
| `500 api_error` | **Retry up to 8 times** — exponential back-off (1 s base, 60 s cap). |
| `504 timeout_error` | Same as `api_error`. |
| `429 rate_limit_error` | Same as `api_error`. |
| `401 authentication_error` | **Credential rotation** (see below). |
| `402 billing_error` | **Credential rotation** (see below). |
| `400 invalid_request_error` | **Fatal** — bad input; no retry. |
| `403 permission_error` | **Fatal** — no retry. |
| `404 not_found_error` | **Fatal** — no retry. |
| `413 request_too_large` | **Fatal** — no retry. |

Retries are transparent: the client sees no error events unless all retry
attempts are exhausted.  If an error occurs _after_ content has already started
streaming, it is forwarded immediately (partial data cannot be "un-sent").

### Credential rotation

When an auth or billing error is hit, the harness looks for numbered credential
files in `$HOME/.claude/`:

```
$HOME/.claude/.credentials.json   ← active credential (read/written by Claude)
$HOME/.claude/credentials_1.json  ← credential slot 1
$HOME/.claude/credentials_2.json  ← credential slot 2
...
```

Algorithm:
1. Compare `.credentials.json` to each `credentials_N.json` to find the
   current slot index.
2. Remember that as the _start_ index.
3. Advance to the next slot (wraps: 1 → 2 → … → N → 1).
4. Copy the new slot file over `.credentials.json` and retry immediately.
5. If the next slot would be the start index again, all credentials have been
   tried → emit a final error event and stop.

Once a rotated credential produces a successful response, the rotation state
is forgotten (the new credential is simply the active one going forward).

---

## Building a binary

```bash
npm run build        # produces dist/cc-harnass for the current OS/arch
```

Internally this runs:
```
deno compile --allow-all --output dist/cc-harnass src/server.ts
```

The binary bundles the Deno runtime — no separate Deno installation required
on the target machine.

---

## How it works

1. Client `POST /prompt` with `{ prompt, dir, continue? }`
2. Server validates inputs and spawns:
   ```
   claude --dangerously-skip-permissions \
          --output-format stream-json \
          --include-partial-messages \
          [--continue] \
          -p "<prompt>"
   ```
   in the requested working directory.
3. Each newline-delimited JSON event emitted on Claude's stdout is forwarded
   verbatim as an SSE `data:` line.
4. A synthetic `{"type":"done"}` event is appended on clean exit.
5. If the client disconnects, an `AbortSignal` terminates the subprocess.

Claude stores conversation history in
`$HOME/.claude/projects/<encoded-dir>/*.jsonl` — passing `--continue` makes
Claude resume that history automatically.
