/**
 * setup.ts
 *
 * Optional Claude tool integration, controlled by FORCE_CLAUDE_TOOLS.
 *
 * When FORCE_CLAUDE_TOOLS=true the harness automatically writes the chosen
 * site-crawling MCP server into ~/.claude/settings.json before accepting any
 * requests.  Two backends are supported:
 *
 *   CLAUDE_SITE_TOOL=playbig
 *     – Registers the local playbig Playwright/Chromium MCP server.
 *     – Requires: PLAYBIG_API_KEY, playbig running on 127.0.0.1:10001.
 *
 *   CLAUDE_SITE_TOOL=sitegulp
 *     – Registers the remote sitegulp MCP server.
 *     – Requires: SITEGULP_API_KEY, SITEGULP_URL (default https://hl2i6br8.vibecode.my).
 *
 * The function bails (process.exit 1) with a clear message if any required
 * variable is missing or if the expected service is unreachable.
 */

const HOME = Deno.env.get("HOME") ?? "";
const CLAUDE_SETTINGS_PATH = `${HOME}/.claude/settings.json`;

/** Entry point — call once at server startup. */
export async function setupClaudeTools(): Promise<void> {
  const forceTools = Deno.env.get("FORCE_CLAUDE_TOOLS");
  if (forceTools !== "true") return;

  const siteTool = Deno.env.get("CLAUDE_SITE_TOOL");
  if (siteTool) {
    if (siteTool !== "playbig" && siteTool !== "sitegulp") {
      bail(
        `CLAUDE_SITE_TOOL must be 'playbig' or 'sitegulp', got '${siteTool}'`,
      );
    }
    if (siteTool === "playbig") {
      await setupPlaybig();
    } else {
      await setupSitegulp();
    }
  }
}

// ─── playbig ──────────────────────────────────────────────────────────────────

async function setupPlaybig(): Promise<void> {
  const apiKey = Deno.env.get("PLAYBIG_API_KEY");
  if (!apiKey) {
    bail(
      "CLAUDE_SITE_TOOL=playbig requires PLAYBIG_API_KEY to be set in the environment",
    );
  }

  // Verify the service is actually running before touching any config.
  await assertPlaybigRunning();

  await writeClaudeMcpServer("playbig", {
    type: "http",
    url: "http://127.0.0.1:10001/mcp",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  console.log(
    "  site tool     : playbig  (MCP → http://127.0.0.1:10001/mcp)",
  );
}

async function assertPlaybigRunning(): Promise<void> {
  let ok = false;
  let reason = "connection refused";
  try {
    const resp = await fetch("http://127.0.0.1:10001/health", {
      signal: AbortSignal.timeout(3_000),
    });
    if (resp.ok) {
      ok = true;
    } else {
      reason = `HTTP ${resp.status}`;
    }
    // Drain to avoid resource leak.
    await resp.body?.cancel();
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  if (!ok) {
    bail(
      `playbig is not running on 127.0.0.1:10001 (${reason}).\n` +
        "  Start playbig first, or unset FORCE_CLAUDE_TOOLS to skip this check.",
    );
  }
}

// ─── sitegulp ─────────────────────────────────────────────────────────────────

async function setupSitegulp(): Promise<void> {
  const apiKey = Deno.env.get("SITEGULP_API_KEY");
  if (!apiKey) {
    bail(
      "CLAUDE_SITE_TOOL=sitegulp requires SITEGULP_API_KEY to be set in the environment",
    );
  }

  const baseUrl = Deno.env.get("SITEGULP_URL") ??
    "https://hl2i6br8.vibecode.my";
  const mcpUrl = `${baseUrl.replace(/\/$/, "")}/docs/mcp`;

  await writeClaudeMcpServer("sitegulp", {
    type: "http",
    url: mcpUrl,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  console.log(`  site tool     : sitegulp (MCP → ${mcpUrl})`);
}

// ─── shared helpers ───────────────────────────────────────────────────────────

/**
 * Read ~/.claude/settings.json, inject (or overwrite) one mcpServers entry,
 * and write it back.  Creates the file if it does not yet exist.
 */
async function writeClaudeMcpServer(
  name: string,
  config: Record<string, unknown>,
): Promise<void> {
  // Read existing settings (tolerate missing file or parse errors).
  let settings: Record<string, unknown> = {};
  try {
    const text = await Deno.readTextFile(CLAUDE_SETTINGS_PATH);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // File absent or malformed — start from scratch.
  }

  // Ensure mcpServers key exists and is an object.
  if (
    !settings.mcpServers ||
    typeof settings.mcpServers !== "object" ||
    Array.isArray(settings.mcpServers)
  ) {
    settings.mcpServers = {};
  }

  (settings.mcpServers as Record<string, unknown>)[name] = config;

  await Deno.writeTextFile(
    CLAUDE_SETTINGS_PATH,
    JSON.stringify(settings, null, 2) + "\n",
  );
}

/** Print an error and exit with code 1. */
function bail(message: string): never {
  console.error(`\n[cc-harnass] FATAL: ${message}\n`);
  Deno.exit(1);
}
