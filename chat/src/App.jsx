import { useState, useCallback, useEffect, useRef } from 'react'
import Sidebar from './components/Sidebar.jsx'
import TabBar from './components/TabBar.jsx'
import ChatSession from './components/ChatSession.jsx'
import AddProjectModal from './components/AddProjectModal.jsx'
import githubDarkUrl from 'highlight.js/styles/github-dark.css?url'
import githubUrl from 'highlight.js/styles/github.css?url'

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function loadProjects() {
  try { return JSON.parse(localStorage.getItem('cc-chat-projects') || '[]') }
  catch { return [] }
}

function saveProjects(projects) {
  localStorage.setItem('cc-chat-projects', JSON.stringify(projects))
}

function loadTheme() {
  return localStorage.getItem('cc-chat-theme') || 'dark'
}

function loadDrafts() {
  try { return JSON.parse(localStorage.getItem('cc-chat-drafts') || '{}') }
  catch { return {} }
}

function saveDrafts(drafts) {
  try { localStorage.setItem('cc-chat-drafts', JSON.stringify(drafts)) }
  catch { /* quota exceeded — skip silently */ }
}

export default function App() {
  const [projects, setProjects] = useState(loadProjects)
  const [sessions, setSessions] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [theme, setThemeState] = useState(loadTheme)
  const [drafts, setDrafts] = useState(loadDrafts)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Apply theme to <html> and swap hljs stylesheet
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('cc-chat-theme', theme)

    let link = document.getElementById('hljs-theme')
    if (!link) {
      link = document.createElement('link')
      link.id = 'hljs-theme'
      link.rel = 'stylesheet'
      document.head.appendChild(link)
    }
    link.href = theme === 'dark' ? githubDarkUrl : githubUrl
  }, [theme])

  const toggleTheme = useCallback(() => {
    setThemeState(t => t === 'dark' ? 'light' : 'dark')
  }, [])

  const addProject = useCallback((dir) => {
    const name = dir.replace(/\/+$/, '').split('/').filter(Boolean).pop() || dir
    const project = { id: genId(), name, dir }
    setProjects(prev => {
      const next = [...prev, project]
      saveProjects(next)
      return next
    })
    setShowAdd(false)
  }, [])

  const updateDraft = useCallback((projectId, draft) => {
    setDrafts(prev => {
      const next = { ...prev, [projectId]: draft }
      saveDrafts(next)
      return next
    })
  }, [])

  const removeProject = useCallback((projectId) => {
    setProjects(prev => {
      const next = prev.filter(p => p.id !== projectId)
      saveProjects(next)
      return next
    })
    setSessions(prev => {
      const removed = new Set(prev.filter(s => s.projectId === projectId).map(s => s.id))
      const next = prev.filter(s => s.projectId !== projectId)
      setActiveId(cur => removed.has(cur) ? (next[next.length - 1]?.id ?? null) : cur)
      return next
    })
    setDrafts(prev => {
      const next = { ...prev }
      delete next[projectId]
      saveDrafts(next)
      return next
    })
  }, [])

  const openProject = useCallback((project) => {
    setSessions(prev => {
      const existing = prev.find(s => s.projectId === project.id)
      if (existing) {
        setActiveId(existing.id)
        return prev
      }
      const session = {
        id: genId(),
        projectId: project.id,
        name: project.name,
        dir: project.dir,
        messages: [],
        streaming: false,
        isFirst: true,
      }
      setActiveId(session.id)
      return [...prev, session]
    })
  }, [])

  const closeSession = useCallback((sessionId) => {
    setSessions(prev => {
      const idx = prev.findIndex(s => s.id === sessionId)
      const next = prev.filter(s => s.id !== sessionId)
      setActiveId(cur => {
        if (cur !== sessionId) return cur
        return next[Math.min(idx, next.length - 1)]?.id ?? null
      })
      return next
    })
  }, [])

  const updateSession = useCallback((id, updater) => {
    setSessions(prev => prev.map(s => s.id === id ? updater(s) : s))
  }, [])

  const activeSession = sessions.find(s => s.id === activeId)

  return (
    <div className="app">
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        projects={projects}
        sessions={sessions}
        theme={theme}
        isOpen={sidebarOpen}
        onOpenProject={(p) => { openProject(p); setSidebarOpen(false) }}
        onRemoveProject={removeProject}
        onAddProject={() => setShowAdd(true)}
        onToggleTheme={toggleTheme}
      />
      <div className="main">
        <TabBar
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={closeSession}
          onMenuOpen={() => setSidebarOpen(true)}
        />
        <div className="chat-area" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {activeSession ? (
            <ChatSession
              key={activeSession.id}
              session={activeSession}
              onUpdate={(updater) => updateSession(activeSession.id, updater)}
              draft={drafts[activeSession.projectId] ?? { text: '', attachments: [] }}
              onDraftChange={(d) => updateDraft(activeSession.projectId, d)}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-icon">⌘</div>
              <p>Select a project from the sidebar to start chatting</p>
            </div>
          )}
        </div>
      </div>
      {showAdd && (
        <AddProjectModal onAdd={addProject} onClose={() => setShowAdd(false)} />
      )}
    </div>
  )
}
