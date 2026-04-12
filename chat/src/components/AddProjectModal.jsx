import { useState, useEffect, useCallback } from 'react'

export default function AddProjectModal({ onAdd, onClose }) {
  const [typedPath, setTypedPath] = useState('')
  const [browsePath, setBrowsePath] = useState(null)   // null = not yet loaded
  const [entries, setEntries] = useState([])
  const [browseError, setBrowseError] = useState(null)
  const [loading, setLoading] = useState(false)

  const browse = useCallback(async (dir) => {
    setLoading(true)
    setBrowseError(null)
    try {
      const res = await fetch(`/api/browse?dir=${encodeURIComponent(dir)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Browse failed')
      setBrowsePath(data.path)
      setEntries(data.entries)
      setTypedPath(data.path)
    } catch (err) {
      setBrowseError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load initial directory on mount
  useEffect(() => { browse('.') }, [browse])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') browse(typedPath)
    if (e.key === 'Escape') onClose()
  }

  const handleNavigate = (path) => {
    browse(path)
  }

  const handleUp = () => {
    if (browsePath) {
      const parent = browsePath.split('/').slice(0, -1).join('/') || '/'
      browse(parent)
    }
  }

  const handleConfirm = () => {
    const dir = typedPath.trim()
    if (dir) onAdd(dir)
  }

  const isRoot = browsePath === '/'

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h3>Add Project</h3>

        <input
          className="modal-path-input"
          type="text"
          placeholder="Type or browse to a directory…"
          value={typedPath}
          onChange={e => setTypedPath(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />

        <div className="modal-browser">
          {loading && (
            <div className="browser-empty">Loading…</div>
          )}
          {browseError && (
            <div className="browser-error">⚠ {browseError}</div>
          )}
          {!loading && !browseError && (
            <>
              {!isRoot && (
                <div className="browser-row up" onClick={handleUp}>
                  <span className="folder-icon">↑</span>
                  <span className="dir-name">..</span>
                </div>
              )}
              {entries.length === 0 && !browseError && (
                <div className="browser-empty">No subdirectories</div>
              )}
              {entries.map(entry => (
                <div
                  key={entry.path}
                  className="browser-row"
                  onClick={() => handleNavigate(entry.path)}
                >
                  <span className="folder-icon">📁</span>
                  <span className="dir-name">{entry.name}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-modal cancel" onClick={onClose}>Cancel</button>
          <button
            className="btn-modal confirm"
            onClick={handleConfirm}
            disabled={!typedPath.trim()}
          >Add Project</button>
        </div>
      </div>
    </div>
  )
}
