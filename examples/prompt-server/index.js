/**
 * examples/prompt-server/index.js
 *
 * Standalone demo wiring cc-harness to a small local prompt-server.
 *
 * What it does
 * ────────────
 *  • Generates a random Bearer token.
 *  • Starts cc-harness (on HARNESS_PORT=3333) with
 *      RETRIEVE_PROMPT_URL=http://localhost:2222/prompts
 *      RETRIEVE_PROMPT_TOKEN=<token>
 *  • Runs a prompt-server (on PROMPT_PORT=2222) that:
 *      GET  /prompts  – SSE stream the harness subscribes to for jobs
 *      POST /prompts  – harness streams Claude response NDJSON back here
 *  • Reads prompts from stdin, one per Enter.
 *  • For each prompt creates a fresh /tmp/cc-<hex> work directory, sends the
 *    job to the harness via SSE, and prints Claude's output in real-time.
 */

import http from 'node:http'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── config ────────────────────────────────────────────────────────────────────

const PROMPT_PORT = 2222
const HARNESS_PORT = 3333
const TOKEN = randomBytes(24).toString('hex')
const RETRIEVE_URL = `http://localhost:${PROMPT_PORT}/prompts`
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..')

// ── state ─────────────────────────────────────────────────────────────────────

/** All active harness SSE connections. */
const sseClients = new Set()

/**
 * Resolve function for the currently in-flight job.
 * We process exactly one job at a time.
 */
let jobResolve = null

// ── prompt-server HTTP ────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Token check on every request
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized')
    return
  }

  const url = new URL(req.url, `http://localhost:${PROMPT_PORT}`)
  if (url.pathname !== '/prompts') {
    res.writeHead(404).end()
    return
  }

  if (req.method === 'GET') {
    // ── SSE: harness subscribes here to receive prompt jobs ──────────────────
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()

    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))

    // Keep-alive ping every 15 s to prevent proxy timeouts
    const ka = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n') }, 15_000)
    req.on('close', () => clearInterval(ka))
    return
  }

  if (req.method === 'POST') {
    // ── NDJSON: harness streams Claude response events back here ─────────────
    res.writeHead(200).end()          // ack immediately so harness can keep writing

    let buf = ''
    req.on('data', chunk => {
      buf += chunk.toString()
      // Process every complete line as it arrives (real-time streaming)
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) handleEvent(line.trim())
      }
    })
    req.on('end', () => {
      if (buf.trim()) handleEvent(buf.trim())
    })
    return
  }

  res.writeHead(405).end()
})

/** Decode a single NDJSON response line from the harness and display it. */
function handleEvent(line) {
  let ev
  try { ev = JSON.parse(line) } catch { return }

  if (ev.type === 'stream_event') {
    // Real-time token streaming from Claude
    const delta = ev.event?.delta
    if (delta?.type === 'text_delta' && delta?.text) {
      process.stdout.write(delta.text)
    }
    return
  }

  if (ev.type === 'error') {
    const msg = typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error)
    process.stderr.write(`\n[error] ${msg}\n`)
    finishJob()
    return
  }

  if (ev.type === 'done') {
    process.stdout.write('\n')
    finishJob()
  }
}

function finishJob() {
  if (jobResolve) {
    const resolve = jobResolve
    jobResolve = null
    resolve()
  }
}

// ── harness subprocess ────────────────────────────────────────────────────────

function startHarness() {
  const harnessEnv = {
    ...process.env,
    PORT: String(HARNESS_PORT),
    RETRIEVE_PROMPT_URL: RETRIEVE_URL,
    RETRIEVE_PROMPT_TOKEN: TOKEN,
  }

  const harness = spawn('npm', ['start'], {
    cwd: ROOT_DIR,
    env: harnessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  harness.stdout.on('data', d => process.stdout.write(prefix('[harness] ', d.toString())))
  harness.stderr.on('data', d => process.stderr.write(prefix('[harness] ', d.toString())))
  harness.on('exit', code => {
    process.stderr.write(`[harness] process exited (code ${code})\n`)
    process.exit(1)
  })

  return harness
}

function prefix(tag, text) {
  return text.split('\n').map(l => l ? tag + l : l).join('\n')
}

// ── stdin prompt loop ─────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout })

rl.on('close', () => process.exit(0))

async function promptLoop() {
  // Give the harness a moment to boot and connect its SSE worker
  await waitForHarness()

  while (true) {
    const input = await question('\nprompt> ')
    const prompt = input.trim()
    if (!prompt) continue

    // Fresh isolated work directory for every prompt
    const workDir = join(tmpdir(), `cc-${randomBytes(6).toString('hex')}`)
    mkdirSync(workDir, { recursive: true })

    const job = {
      user: prompt,
      dir: workDir,
      continue: false,
    }

    process.stdout.write(`\n[→ claude]  dir: ${workDir}\n`)

    // Push the job to all connected harness workers
    const data = `data: ${JSON.stringify(job)}\n\n`
    for (const client of sseClients) {
      client.write(data)
    }

    // Wait until handleEvent calls finishJob()
    await new Promise(resolve => { jobResolve = resolve })
  }
}

/** Wait (with periodic checks) until at least one harness SSE client is connected. */
async function waitForHarness() {
  if (sseClients.size > 0) return
  process.stdout.write('[server] waiting for harness to connect …')
  while (sseClients.size === 0) {
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, 500))
  }
  process.stdout.write(' connected!\n')
}

/** readline question wrapped in a Promise. */
function question(q) {
  return new Promise(resolve => rl.question(q, resolve))
}

// ── main ──────────────────────────────────────────────────────────────────────

server.listen(PROMPT_PORT, '127.0.0.1', () => {
  console.log()
  console.log('  prompt-server  →  http://localhost:' + PROMPT_PORT)
  console.log('  cc-harness     →  http://localhost:' + HARNESS_PORT)
  console.log('  token          →  ' + TOKEN)
  console.log()
})

// Only spawn a harness if one isn't already listening on HARNESS_PORT.
fetch(`http://localhost:${HARNESS_PORT}/health`)
  .then(r => {
    if (r.ok) console.log(`  [harness] already running on port ${HARNESS_PORT}, skipping spawn`)
    else startHarness()
  })
  .catch(() => startHarness())

promptLoop().catch(err => {
  process.stderr.write(`[fatal] ${err}\n`)
  process.exit(1)
})
