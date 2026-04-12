export default function TabBar({ sessions, activeId, onSelect, onClose }) {
  if (sessions.length === 0) {
    return <div className="tab-bar" style={{ minHeight: 35 }} />
  }

  return (
    <div className="tab-bar">
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
