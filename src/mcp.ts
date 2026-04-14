/**
 * mcp.ts
 *
 * The harness's own MCP server (streamable-HTTP, JSON-RPC 2.0).
 * Exposes AI tool capabilities that are fulfilled by calling openwrapper,
 * which in turn proxies to OpenRouter.
 *
 * Enabled tools — each is individually optional:
 *   stt_transcribe   CLAUDE_STT_TOOL=<openrouter-model>
 *   tts_speak        CLAUDE_TTS_TOOL=<openrouter-model>
 *   vision_analyze   CLAUDE_VISION_TOOL=<openrouter-model>
 *
 * All tools share:
 *   OPENWRAPPER_API_KEY   issued client key for openwrapper
 *   OPENWRAPPER_URL       openwrapper base URL (default http://127.0.0.1:8000)
 *
 * Endpoints (mounted at /mcp in server.ts):
 *   GET  /mcp  — discovery probe, lists enabled tool names
 *   POST /mcp  — JSON-RPC 2.0 MCP calls
 *
 * No auth — intended for localhost use only.
 */

// ── Config (read live so tests can override via env) ─────────────────────────

function owBase(): string {
  return (Deno.env.get("OPENWRAPPER_URL") ?? "http://127.0.0.1:8000").replace(
    /\/$/,
    "",
  );
}
function owKey(): string {
  return Deno.env.get("OPENWRAPPER_API_KEY") ?? "";
}
function sttModel(): string | undefined {
  return Deno.env.get("CLAUDE_STT_TOOL");
}
function ttsModel(): string | undefined {
  return Deno.env.get("CLAUDE_TTS_TOOL");
}
function visionModel(): string | undefined {
  return Deno.env.get("CLAUDE_VISION_TOOL");
}

/** True if at least one AI tool is configured via env vars. */
export function hasMcpTools(): boolean {
  return !!(sttModel() || ttsModel() || visionModel());
}

// ── Tool catalogue ────────────────────────────────────────────────────────────

const STT_TOOL = {
  name: "stt_transcribe",
  description:
    "Transcribe speech from an audio file to text. " +
    "Provide either audio_path (path to a local file) or audio_base64 (base64-encoded audio).",
  inputSchema: {
    type: "object",
    properties: {
      audio_path: {
        type: "string",
        description:
          "Absolute path to the audio file on disk (wav, mp3, ogg, flac, m4a, webm …).",
      },
      audio_base64: {
        type: "string",
        description: "Base64-encoded audio data (no data-URL prefix).",
      },
      mime_type: {
        type: "string",
        description:
          "MIME type of the audio (e.g. audio/wav, audio/mpeg). Default: audio/wav.",
      },
      language: {
        type: "string",
        description:
          "BCP-47 language code (e.g. 'en', 'fr'). Omit for auto-detection.",
      },
    },
  },
};

const TTS_TOOL = {
  name: "tts_speak",
  description:
    "Convert text to speech. Returns base64-encoded audio in the chosen format.",
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text: {
        type: "string",
        description: "Text to synthesize.",
      },
      voice: {
        type: "string",
        description:
          "Voice name (e.g. alloy, echo, fable, onyx, nova, shimmer). Default: alloy.",
      },
      speed: {
        type: "number",
        description: "Speed multiplier 0.25 – 4.0. Default: 1.0.",
      },
      response_format: {
        type: "string",
        enum: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
        description: "Audio format. Default: mp3.",
      },
    },
  },
};

const VISION_TOOL = {
  name: "vision_analyze",
  description:
    "Analyze or describe an image using a vision-capable model. " +
    "Provide image_url or image_base64 together with a prompt.",
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "What to analyze or ask about the image.",
      },
      image_url: {
        type: "string",
        description: "Publicly accessible URL of the image.",
      },
      image_base64: {
        type: "string",
        description: "Base64-encoded image data (no data-URL prefix).",
      },
      mime_type: {
        type: "string",
        description:
          "MIME type when using image_base64 (e.g. image/png, image/jpeg). Default: image/png.",
      },
    },
  },
};

function buildTools() {
  const tools = [];
  if (sttModel()) tools.push(STT_TOOL);
  if (ttsModel()) tools.push(TTS_TOOL);
  if (visionModel()) tools.push(VISION_TOOL);
  return tools;
}

// ── Tool implementations ──────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Args = Record<string, any>;

function ok(text: string) {
  return { content: [{ type: "text", text }] };
}
function fail(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

async function callStt(args: Args) {
  const mimeType = args.mime_type ?? "audio/wav";

  let audioBytes: Uint8Array;
  if (args.audio_path) {
    try {
      audioBytes = await Deno.readFile(args.audio_path as string);
    } catch (err) {
      return fail(
        `Cannot read '${args.audio_path}': ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  } else if (args.audio_base64) {
    try {
      const bin = atob(args.audio_base64 as string);
      audioBytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return fail("Invalid base64 in audio_base64.");
    }
  } else {
    return fail("Provide audio_path or audio_base64.");
  }

  const extMap: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp3": "mp3",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
  };
  const ext = extMap[mimeType] ?? "wav";

  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBytes.buffer as ArrayBuffer], { type: mimeType }),
    `audio.${ext}`,
  );
  form.append("model", sttModel()!);
  if (args.language) form.append("language", args.language as string);

  let resp: Response;
  try {
    resp = await fetch(`${owBase()}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owKey()}` },
      body: form,
    });
  } catch (err) {
    return fail(
      `Cannot reach openwrapper: ${err instanceof Error ? err.message : err}`,
    );
  }

  const body = await resp.text();
  if (!resp.ok) return fail(`STT error (HTTP ${resp.status}): ${body}`);

  try {
    return ok(JSON.parse(body).text ?? body);
  } catch {
    return ok(body);
  }
}

async function callTts(args: Args) {
  const voice = args.voice ?? "alloy";
  const fmt = args.response_format ?? "mp3";

  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg",
    opus: "audio/ogg; codecs=opus",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/pcm",
  };
  const mimeType = mimeMap[fmt] ?? "audio/mpeg";

  // First try the dedicated /v1/audio/speech endpoint (OpenAI-compatible TTS).
  // If that returns 404, fall back to chat completions with audio output
  // (used by OpenRouter for models like openai/gpt-audio-mini).
  let resp: Response;
  try {
    resp = await fetch(`${owBase()}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ttsModel(),
        input: args.text as string,
        voice,
        response_format: fmt,
      }),
    });
  } catch (err) {
    return fail(
      `Cannot reach openwrapper: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (resp.ok) {
    // Dedicated TTS endpoint returned audio bytes directly.
    const buf = await resp.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: `data:${mimeType};base64,${b64}`,
            mimeType,
            blob: b64,
          },
        },
      ],
    };
  }

  // Not a simple 404 — real error from the speech endpoint.
  if (resp.status !== 404) {
    const errBody = await resp.text().catch(() => "");
    return fail(`TTS error (HTTP ${resp.status}): ${errBody}`);
  }
  await resp.body?.cancel().catch(() => {});

  // Fallback: use chat completions with audio modality + streaming.
  // OpenRouter requires stream:true for audio output, and only pcm16 is
  // supported as the streaming audio format (mp3/opus etc. are rejected).
  let resp2: Response;
  try {
    resp2 = await fetch(`${owBase()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ttsModel(),
        modalities: ["text", "audio"],
        audio: { voice, format: "pcm16" },
        messages: [
          { role: "user", content: args.text as string },
        ],
        stream: true,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return fail(
      `TTS fallback failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (!resp2.ok) {
    const errBody = await resp2.text().catch(() => "");
    return fail(`TTS error (HTTP ${resp2.status}): ${errBody}`);
  }

  // Accumulate base64 PCM16 audio chunks from the SSE stream.
  const audioChunks: string[] = [];
  let textContent = "";
  const reader = resp2.body!.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";
  try {
    outer: while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      lineBuf += decoder.decode(chunk.value, { stream: true });
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") { break outer; }
        try {
          const evt = JSON.parse(raw);
          const delta = evt.choices?.[0]?.delta;
          if (delta?.audio?.data) audioChunks.push(delta.audio.data as string);
          if (typeof delta?.content === "string") textContent += delta.content;
        } catch { /* malformed chunk — skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const audioData = audioChunks.join("");
  if (!audioData) {
    // Model returned text instead of audio.
    return ok(textContent || "TTS: no audio in response");
  }
  // Return as PCM16 data-URI (the only format OpenRouter streams support).
  const pcmMime = "audio/pcm";
  return {
    content: [
      {
        type: "resource",
        resource: {
          uri: `data:${pcmMime};base64,${audioData}`,
          mimeType: pcmMime,
          blob: audioData,
        },
      },
    ],
  };
}

async function callVision(args: Args) {
  const mimeType = args.mime_type ?? "image/png";

  let imageContent: unknown;
  if (args.image_url) {
    imageContent = {
      type: "image_url",
      image_url: { url: args.image_url as string },
    };
  } else if (args.image_base64) {
    imageContent = {
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${args.image_base64}` },
    };
  } else {
    return fail("Provide image_url or image_base64.");
  }

  let resp: Response;
  try {
    resp = await fetch(`${owBase()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: visionModel(),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: args.prompt as string },
              imageContent,
            ],
          },
        ],
      }),
    });
  } catch (err) {
    return fail(
      `Cannot reach openwrapper: ${err instanceof Error ? err.message : err}`,
    );
  }

  const body = await resp.text();
  if (!resp.ok) return fail(`Vision error (HTTP ${resp.status}): ${body}`);

  try {
    const json = JSON.parse(body);
    const text = json.choices?.[0]?.message?.content;
    return ok(typeof text === "string" ? text : JSON.stringify(json));
  } catch {
    return ok(body);
  }
}

async function callTool(name: string, args: Args) {
  switch (name) {
    case "stt_transcribe":
      return callStt(args);
    case "tts_speak":
      return callTts(args);
    case "vision_analyze":
      return callVision(args);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ── JSON-RPC 2.0 dispatcher ───────────────────────────────────────────────────

function rpcErr(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26"]);

async function dispatch(method: string, params: Args) {
  switch (method) {
    case "initialize": {
      const req = params?.protocolVersion ?? "2024-11-05";
      return {
        protocolVersion: PROTOCOL_VERSIONS.has(req) ? req : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cc-harnass", version: "1.0.0" },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: buildTools() };
    case "tools/call": {
      const { name, arguments: toolArgs } = params ?? {};
      if (!name) {
        throw Object.assign(new Error("Missing tool name"), { code: -32602 });
      }
      return callTool(name as string, (toolArgs as Args) ?? {});
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), {
        code: -32601,
      });
  }
}

async function handleItem(item: unknown) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return rpcErr(null, -32600, "Invalid Request");
  }
  const { jsonrpc, id, method, params } = item as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return rpcErr(id ?? null, -32600, "Invalid Request");
  }
  const isNotification = !("id" in (item as object));
  try {
    const result = await dispatch(method, (params as Args) ?? {});
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (isNotification) return null;
    const e = err as { code?: number; message?: string };
    return rpcErr(id, e.code ?? -32603, e.message ?? "Internal error");
  }
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

export async function handleMcp(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return Response.json({
      name: "cc-harnass",
      transport: "streamable-http",
      endpoint: "POST /mcp",
      tools: buildTools().map((t) => t.name),
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400 });
  }

  if (Array.isArray(body)) {
    const results = await Promise.all(body.map(handleItem));
    const replies = results.filter(Boolean);
    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(replies);
  }

  const result = await handleItem(body);
  if (!result) return new Response(null, { status: 202 });
  return Response.json(result);
}
