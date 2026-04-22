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

### Core variables

| Variable      | Default   | Description                          |
|---------------|-----------|--------------------------------------|
| `PORT`        | `8080`    | TCP port the server listens on       |
| `CLAUDE_PATH` | `claude`  | Path to the Claude CLI binary        |

```bash
PORT=3000 CLAUDE_PATH=/opt/claude/bin/claude ./dist/cc-harnass
```

Copy `.env.example` to `.env` and fill in the values you need.

---

### Site-crawling tool integration (optional)

Setting `FORCE_CLAUDE_TOOLS=true` tells the harness to automatically write an
MCP server entry into `~/.claude/settings.json` before accepting any requests,
so that Claude Code can use a site-crawling/browser tool out of the box.

The harness **exits with a clear error** if any required variable is missing or
if the expected service is unreachable — nothing is configured half-way.

#### `CLAUDE_SITE_TOOL=playbig`

Registers the local [playbig](../playbig) Playwright/Chromium browser service
as an MCP server.

**Prerequisites:**
- `PLAYBIG_API_KEY` — a valid access key (obtain via `POST /admin/keys` on the
  playbig service; requires `ADMIN_SECRET` to be set there).
- playbig running and healthy on `http://127.0.0.1:10001` before the harness
  starts.

What gets written to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "playbig": {
      "type": "http",
      "url": "http://127.0.0.1:10001/mcp",
      "headers": { "Authorization": "Bearer <PLAYBIG_API_KEY>" }
    }
  }
}
```

Example:
```bash
FORCE_CLAUDE_TOOLS=true \
CLAUDE_SITE_TOOL=playbig \
PLAYBIG_API_KEY=my-key \
./dist/cc-harnass
```

#### `CLAUDE_SITE_TOOL=sitegulp`

Registers the remote sitegulp site-crawling MCP service.

**Prerequisites:**
- `SITEGULP_API_KEY` — API key for the sitegulp service.
- `SITEGULP_URL` (optional) — base URL of the service.  
  Default: `https://sitegulp.com`  
  The MCP endpoint is `${SITEGULP_URL}/docs/mcp`.

What gets written to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "sitegulp": {
      "type": "http",
      "url": "https://sitegulp.com/docs/mcp",
      "headers": { "Authorization": "Bearer <SITEGULP_API_KEY>" }
    }
  }
}
```

Example:
```bash
FORCE_CLAUDE_TOOLS=true \
CLAUDE_SITE_TOOL=sitegulp \
SITEGULP_API_KEY=my-key \
SITEGULP_URL=https://sitegulp.com \
./dist/cc-harnass
```

#### Error cases

| Situation | Behaviour |
|-----------|-----------|
| `FORCE_CLAUDE_TOOLS=true` but `CLAUDE_SITE_TOOL` not set | No-op — other tools may still be configured |
| `CLAUDE_SITE_TOOL` set to unknown value | Fatal error, exit 1 |
| `playbig` but `PLAYBIG_API_KEY` missing | Fatal error, exit 1 |
| `playbig` but `127.0.0.1:10001` not responding | Fatal error, exit 1 |
| `sitegulp` but `SITEGULP_API_KEY` missing | Fatal error, exit 1 |
| `FORCE_CLAUDE_TOOLS=false` (or unset) | Feature skipped, no config changes |

---

### AI tools — STT, TTS, Vision (openwrapper backend)

The harness exposes its own MCP server at `GET /mcp` (discovery) and
`POST /mcp` (JSON-RPC 2.0). Three AI tools are available, each independently
optional. All three call [openwrapper](../openwrapper), which proxies to
OpenRouter.

#### Shared prerequisites

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENWRAPPER_API_KEY` | yes (if any tool is set) | Client key issued by openwrapper (`POST /admin/keys`) |
| `OPENWRAPPER_URL` | no | openwrapper base URL. Default: `http://127.0.0.1:8000` |

#### Individual tools

| Env var | MCP tool name | What it calls on openwrapper |
|---------|---------------|------------------------------|
| `CLAUDE_STT_TOOL=<model>` | `stt_transcribe` | `POST /v1/audio/transcriptions` |
| `CLAUDE_TTS_TOOL=<model>` | `tts_speak` | `POST /v1/audio/speech` |
| `CLAUDE_VISION_TOOL=<model>` | `vision_analyze` | `POST /v1/chat/completions` (with image) |

Model values are OpenRouter model IDs, e.g.:
- STT: `openai/whisper-1`
- TTS: `openai/tts-1`
- Vision: `openai/gpt-4o`

Example:
```bash
FORCE_CLAUDE_TOOLS=true \
OPENWRAPPER_API_KEY=sk-ow-... \
CLAUDE_STT_TOOL=openai/whisper-1 \
CLAUDE_VISION_TOOL=openai/gpt-4o \
./dist/cc-harnass
```

When `FORCE_CLAUDE_TOOLS=true` the harness writes itself into
`~/.claude/settings.json` as an MCP server:

```json
{
  "mcpServers": {
    "cc-harnass": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

#### MCP tool details

**`stt_transcribe`** — speech to text
- `audio_path` (string) — absolute path to an audio file, **or**
- `audio_base64` (string) — base64-encoded audio (no data-URL prefix)
- `mime_type` (string, optional) — e.g. `audio/wav`, `audio/mpeg`. Default: `audio/wav`
- `language` (string, optional) — BCP-47 code, e.g. `en`. Auto-detected if omitted.

**`tts_speak`** — text to speech
- `text` (string, **required**) — text to synthesize
- `voice` (string, optional) — e.g. `alloy`, `echo`, `nova`. Default: `alloy`
- `speed` (number, optional) — 0.25 – 4.0. Default: `1.0`
- `response_format` (string, optional) — `mp3` | `opus` | `aac` | `flac` | `wav` | `pcm`. Default: `mp3`

Returns base64-encoded audio as a data-URI resource.

**`vision_analyze`** — image analysis
- `prompt` (string, **required**) — what to analyze or ask about the image
- `image_url` (string) — publicly accessible URL, **or**
- `image_base64` (string) — base64-encoded image (no data-URL prefix)
- `mime_type` (string, optional) — e.g. `image/png`, `image/jpeg`. Default: `image/png`

#### Error cases (AI tools)

| Situation | Behaviour |
|-----------|-----------|
| Tool model var set but `OPENWRAPPER_API_KEY` missing | Fatal error, exit 1 (when `FORCE_CLAUDE_TOOLS=true`) |
| No tool model vars set | No-op — `/mcp` still served but returns empty tools list |
| openwrapper unreachable at call time | Tool returns `isError: true` with message |

### nsjail process sandbox (claudep)

`claudep` can run each `claude` invocation inside [nsjail](https://github.com/google/nsjail), giving each call an isolated filesystem view and a fresh home directory. This prevents runaway tools from touching files outside the project, reading other users' credentials, or persisting changes to `~/.claude` between sessions.

**Enable it:**

```bash
ENABLE_NSJAIL=true claudep -p "your prompt"
```

Or set it persistently in `.env`:

```ini
ENABLE_NSJAIL=true
```

**What happens on first use:**

`claudep` will automatically:

1. Clone `google/nsjail` into `./3rdparty/nsjail`
2. Build the `nsjail` binary (`make -j$(nproc)`)
3. Run future `claude` calls through `scripts/nsjail-wrapper`

Build dependencies (Debian/Ubuntu):

```bash
sudo apt-get install bison flex libprotobuf-dev protobuf-compiler \
     libnl-3-dev libnl-route-3-dev pkg-config libcap-dev
```

**Sandbox model:**

| Resource | Access |
|----------|--------|
| Host root (`/`) | Read-only bind |
| `/tmp` | Isolated tmpfs (host `/tmp` not visible) |
| Work directory (`$PWD`) | Read-write bind |
| `$HOME` | Per-invocation copy in `/tmp/claude-sandbox-*`, deleted on exit |
| Network | Host namespace (API calls reach Anthropic / openwrapper) |
| Credentials | Copied into sandbox home on startup (when not using openwrapper) |

Only `HOME`, `USER`, `PATH`, `TERM`, `LANG`, `ANTHROPIC_*`, and `CLAUDE_*` env vars are forwarded; everything else is stripped.

**Combining with openwrapper:**

When `OPENWRAPPER_AUTO=true` and `ENABLE_NSJAIL=true`, credentials are **not** copied into the sandbox — all API traffic is routed through openwrapper so the sandboxed `claude` never needs to read `~/.claude/.credentials.json`.

---

### Using rust-agent as the backend

[rust-agent](../rust-agent) ships a `claudec` wrapper that is a compatible
drop-in for the real `claude` binary:

```bash
CLAUDE_PATH=/path/to/rust-agent/claudec ./dist/cc-harnass
```

`claudec` accepts the same flags the harness passes and emits the same
`stream-json` event format.  Session history follows `--continue` semantics:
without it each call is a fresh session; with it a JSONL journal is written so
the session can be resumed.

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
