export default function TabBar({ sessions, activeId, onSelect, onClose, onMenuOpen }) {
  if (sessions.length === 0) {
    return (
      <div className="tab-bar" style={{ minHeight: 35 }}>
        <button className="btn-hamburger" onClick={onMenuOpen} title="Open sidebar">☰</button>
      </div>
    )
  }

  return (
    <div className="tab-bar">
      <button className="btn-hamburger" onClick={onMenuOpen} title="Open sidebar">☰</button>
      {sessions.map(session => (
        <div
          key={session.id}
          className={`tab${session.id === activeId ? ' active' : ''}`}
          onClick={() => onSelect(session.id)}
          title={session.dir}
        >
          {session.streaming && <span className="tab-streaming-dot" />}
          <span className="tab-name">{session.name}</span>
          <button
            className="tab-close"
            onClick={e => { e.stopPropagation(); onClose(session.id) }}
            title="Close tab"
          >×</button>
        </div>
      ))}
    </div>
  )
}
