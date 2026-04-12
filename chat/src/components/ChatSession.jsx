import { useState, useRef, useEffect, useCallback } from 'react'
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
// hljs stylesheet is injected dynamically by App.jsx (theme-aware)

// Configure marked once
const renderer = new marked.Renderer()
renderer.link = function ({ href, text }) {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
}
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext'
    return hljs.highlight(code, { language }).value
  }
}))
marked.use({ renderer, gfm: true, breaks: true })

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function isTextFile(name) {
  return /\.(txt|md|js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|css|html|json|yaml|yml|toml|sh|bash|zsh|fish|sql|graphql|vue|svelte|xml|env|gitignore|dockerfile)$/i.test(name)
}

function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)
}

function fileIcon(att) {
  if (att.type === 'image') return '🖼️'
  if (att.type === 'text') return '📄'
  return '📎'
}

// Read a text file as string
function readAsText(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader()
    reader.onload = e => res(e.target.result)
    reader.onerror = rej
    reader.readAsText(file)
  })
}

// Read a file as data URL (for image preview)
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader()
    reader.onload = e => res(e.target.result)
    reader.onerror = rej
    reader.readAsDataURL(file)
  })
}

// Read a file as ArrayBuffer (for upload)
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader()
    reader.onload = e => res(e.target.result)
    reader.onerror = rej
    reader.readAsArrayBuffer(file)
  })
}

export default function ChatSession({ session, onUpdate }) {
  const [text, setText] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState([])
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef(null)
  const messageListRef = useRef(null)
  const fileInputRef = useRef(null)
  const sessionRef = useRef(null)
  const inputAreaRef = useRef(null)

  // JS layout enforcement: if CSS flex chain fails to constrain height,
  // explicitly set message-list height so the input area stays visible.
  useEffect(() => {
    const enforce = () => {
      const session = sessionRef.current
      const input = inputAreaRef.current
      const list = messageListRef.current
      if (!session || !input || !list) return
      const sessionH = session.clientHeight
      const inputH = input.offsetHeight
      if (sessionH > 0) {
        list.style.height = Math.max(0, sessionH - inputH) + 'px'
        list.style.flex = 'none'
      }
    }
    enforce()
    const ro = new ResizeObserver(enforce)
    if (sessionRef.current) ro.observe(sessionRef.current)
    if (inputAreaRef.current) ro.observe(inputAreaRef.current)
    return () => ro.disconnect()
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = messageListRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
  }, [])

  // Scroll when a new message is added
  useEffect(() => {
    if (session.messages.length > 0) scrollToBottom(true)
  }, [session.messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll as streaming content grows
  const lastMsg = session.messages[session.messages.length - 1]
  const lastContent = lastMsg?.content ?? ''
  useEffect(() => {
    if (session.streaming) scrollToBottom(false)
  }, [lastContent]) // eslint-disable-line react-hooks/exhaustive-deps

  const processFiles = useCallback(async (files) => {
    const results = []
    for (const file of files) {
      if (isImageFile(file.name)) {
        const preview = await readAsDataURL(file)
        // Upload to project dir
        try {
          const buf = await readAsArrayBuffer(file)
          await fetch(`/api/upload?dir=${encodeURIComponent(session.dir)}&filename=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: buf
          })
        } catch { /* non-fatal */ }
        results.push({ id: genId(), name: file.name, type: 'image', preview, content: null })
      } else if (isTextFile(file.name)) {
        const content = await readAsText(file)
        results.push({ id: genId(), name: file.name, type: 'text', preview: null, content })
      } else {
        // Binary: upload to project dir
        try {
          const buf = await readAsArrayBuffer(file)
          await fetch(`/api/upload?dir=${encodeURIComponent(session.dir)}&filename=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf
          })
        } catch { /* non-fatal */ }
        results.push({ id: genId(), name: file.name, type: 'binary', preview: null, content: null })
      }
    }
    setPendingAttachments(prev => [...prev, ...results])
  }, [session.dir])

  const handleDragOver = (e) => {
    e.preventDefault()
    setDragging(true)
  }
  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false)
  }
  const handleDrop = async (e) => {
    e.preventDefault()
    setDragging(false)
    await processFiles([...e.dataTransfer.files])
  }
  const handleFileSelect = async (e) => {
    if (e.target.files.length) await processFiles([...e.target.files])
    e.target.value = ''
  }

  const removeAttachment = (id) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id))
  }

  const buildPrompt = (userText, attachments) => {
    let prompt = userText
    const textAtts = attachments.filter(a => a.type === 'text' && a.content)
    const imageAtts = attachments.filter(a => a.type === 'image')
    const binaryAtts = attachments.filter(a => a.type === 'binary')

    if (textAtts.length > 0) {
      prompt += '\n\n' + textAtts.map(a => {
        const ext = a.name.split('.').pop() || ''
        return `**Attached file: \`${a.name}\`**\n\`\`\`${ext}\n${a.content}\n\`\`\``
      }).join('\n\n')
    }
    if (imageAtts.length > 0) {
      prompt += '\n\n' + imageAtts.map(a =>
        `[Image attached: \`${a.name}\` — saved to project directory]`
      ).join('\n')
    }
    if (binaryAtts.length > 0) {
      prompt += '\n\n' + binaryAtts.map(a =>
        `[File attached: \`${a.name}\` — saved to project directory]`
      ).join('\n')
    }
    return prompt
  }

  const sendMessage = async () => {
    const trimmed = text.trim()
    if ((!trimmed && pendingAttachments.length === 0) || session.streaming) return

    const attachments = [...pendingAttachments]
    const prompt = buildPrompt(trimmed, attachments)
    const isFirst = session.isFirst

    const userMsgId = genId()
    const asstMsgId = genId()

    setText('')
    setPendingAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    onUpdate(s => ({
      ...s,
      messages: [
        ...s.messages,
        { id: userMsgId, role: 'user', content: trimmed, attachments },
        { id: asstMsgId, role: 'assistant', content: '', streaming: true, error: null }
      ],
      streaming: true,
      isFirst: false,
    }))

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, dir: session.dir, continue: !isFirst })
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event
          try { event = JSON.parse(line.slice(6)) } catch { continue }

          if (
            event.type === 'stream_event' &&
            event.event?.type === 'content_block_delta' &&
            event.event?.delta?.type === 'text_delta'
          ) {
            const chunk = event.event.delta.text
            onUpdate(s => ({
              ...s,
              messages: s.messages.map(m =>
                m.id === asstMsgId ? { ...m, content: m.content + chunk } : m
              )
            }))
          }

          if (event.type === 'error') {
            onUpdate(s => ({
              ...s,
              messages: s.messages.map(m =>
                m.id === asstMsgId
                  ? { ...m, streaming: false, error: event.error?.message || 'Unknown error' }
                  : m
              ),
              streaming: false
            }))
            return
          }
        }
      }

      // Done
      onUpdate(s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === asstMsgId ? { ...m, streaming: false } : m
        ),
        streaming: false
      }))
    } catch (err) {
      onUpdate(s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === asstMsgId
            ? { ...m, streaming: false, error: err.message }
            : m
        ),
        streaming: false
      }))
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleTextInput = (e) => {
    setText(e.target.value)
    const el = textareaRef.current
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  return (
    <div className="chat-session" ref={sessionRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* message list */}
      <div className="message-list" ref={messageListRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {session.messages.length === 0 && (
          <div className="session-empty">
            <div style={{ fontSize: 28 }}>💬</div>
            <p>Start a conversation in <strong>{session.name}</strong></p>
            <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>{session.dir}</p>
          </div>
        )}
        {session.messages.map(msg => (
          <Message key={msg.id} msg={msg} />
        ))}
      </div>

      {/* input area */}
      <div
        className="input-area"
        ref={inputAreaRef}
        style={{ flexShrink: 0 }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className={`drop-zone${dragging ? ' dragging' : ''}`}>
          <div className="drop-hint">Drop files here</div>
          {pendingAttachments.length > 0 && (
            <div className="pending-attachments">
              {pendingAttachments.map(att => (
                <div key={att.id} className="att-chip">
                  <span className="att-chip-icon">{fileIcon(att)}</span>
                  <span className="att-chip-name">{att.name}</span>
                  <button
                    className="att-chip-remove"
                    onClick={() => removeAttachment(att.id)}
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="input-row">
          <button
            className="btn-attach"
            onClick={() => fileInputRef.current?.click()}
            title="Attach files"
            disabled={session.streaming}
          >📎</button>
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={session.streaming ? 'Waiting for response…' : 'Message (Enter ↵ send · Shift+Enter newline)'}
            value={text}
            onChange={handleTextInput}
            onKeyDown={handleKeyDown}
            disabled={session.streaming}
            rows={1}
          />
          <button
            className="btn-send"
            onClick={sendMessage}
            disabled={session.streaming || (!text.trim() && pendingAttachments.length === 0)}
            title="Send (Enter)"
          >↑</button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
      </div>
    </div>
  )
}

function Message({ msg }) {
  const isUser = msg.role === 'user'
  const html = msg.content ? marked.parse(msg.content) : ''

  return (
    <div className={`message ${msg.role}`}>
      <div className="message-avatar">
        {isUser ? 'U' : 'C'}
      </div>
      <div className="message-body">
        <div className="message-role">{isUser ? 'You' : 'Claude'}</div>
        {/* attachments shown above content for user messages */}
        {isUser && msg.attachments?.length > 0 && (
          <div className="message-attachments">
            {msg.attachments.map(att => (
              <div key={att.id} className="att-thumb">
                {att.type === 'image' && att.preview
                  ? <img src={att.preview} alt={att.name} />
                  : <span>{fileIcon(att)}</span>}
                <span>{att.name}</span>
              </div>
            ))}
          </div>
        )}
        {isUser ? (
          /* user messages: plain text with whitespace preserved */
          <div className="message-content" style={{ whiteSpace: 'pre-wrap' }}>
            {msg.content}
          </div>
        ) : (
          /* assistant messages: rendered markdown */
          <div
            className={`message-content${msg.streaming ? ' streaming-cursor' : ''}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {msg.error && (
          <div className="message-error">⚠ {msg.error}</div>
        )}
      </div>
    </div>
  )
}
