export default function Sidebar({ projects, sessions, theme, isOpen, onOpenProject, onRemoveProject, onAddProject, onToggleTheme }) {
  return (
    <div className={`sidebar${isOpen ? ' open' : ''}`}>
      <div className="sidebar-header">
        <h2>Projects</h2>
        <button
          className="btn-theme-toggle"
          onClick={onToggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >{theme === 'dark' ? '☀' : '☾'}</button>
        <button
          className="btn-add-project"
          onClick={onAddProject}
          title="Add project"
        >+</button>
      </div>

      <div className="project-list">
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            No projects yet.<br />Click + to add one.
          </div>
        ) : (
          projects.map(project => {
            const session = sessions.find(s => s.projectId === project.id)
            return (
              <div
                key={project.id}
                className={`project-item${session ? ' has-session' : ''}${session?.id === sessions.find(s => s.projectId === project.id)?.id ? '' : ''}`}
                onClick={() => onOpenProject(project)}
                title={project.dir}
              >
                <div className="project-dot" />
                <div className="project-info">
                  <div className="project-name">{project.name}</div>
                  <div className="project-dir">{project.dir}</div>
                </div>
                <button
                  className="btn-remove-project"
                  onClick={e => { e.stopPropagation(); onRemoveProject(project.id) }}
                  title="Remove project"
                >×</button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
