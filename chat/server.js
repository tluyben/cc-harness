import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const HARNESS_URL = process.env.HARNESS_URL || 'http://localhost:8080'
const PORT = process.env.PORT || 3001

app.use(express.json({ limit: '50mb' }))

// Always serve the built frontend from dist/
// index.html: no-cache so the browser always fetches the latest hashed asset URLs
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store')
    }
  }
}))

// Proxy chat to harness, forwarding SSE stream
app.post('/api/chat', async (req, res) => {
  const { prompt, dir, continue: cont } = req.body
  if (!prompt || !dir) {
    return res.status(400).json({ error: 'prompt and dir required' })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let upstream
  try {
    upstream = await fetch(`${HARNESS_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, dir, continue: cont ?? false }),
    })
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: { message: `Cannot reach harness: ${err.message}` } })}\n\n`)
    res.end()
    return
  }

  if (!upstream.ok) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: { message: `Harness returned ${upstream.status}` } })}\n\n`)
    res.end()
    return
  }

  const reader = upstream.body.getReader()
  req.on('close', () => reader.cancel())

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.writableEnded) res.write(Buffer.from(value))
    }
  } catch {
    // client disconnected
  }
  if (!res.writableEnded) res.end()
})

// Browse server directories
app.get('/api/browse', (req, res) => {
  const dir = req.query.dir || process.cwd()
  try {
    const resolved = path.resolve(dir)
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
    res.json({
      path: resolved,
      parent: path.dirname(resolved),
      entries: entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Upload a file into a project directory
app.post('/api/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const { dir, filename } = req.query
  if (!dir || !filename) return res.status(400).json({ error: 'dir and filename required' })
  try {
    const safeName = path.basename(filename) // prevent traversal
    const dest = path.join(path.resolve(dir), safeName)
    fs.writeFileSync(dest, req.body)
    res.json({ saved: dest, filename: safeName })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// SPA fallback — must come after all API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`\n  chat server  →  http://localhost:${PORT}`)
  console.log(`  harness      →  ${HARNESS_URL}\n`)
})
