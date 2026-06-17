import type { SessionMeta } from '../api.js';

export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: SessionMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const MODE_LABEL: Record<string, string> = { analyse: 'Analyse', build: 'Build', recommend: 'Recommend' };
  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">History</span>
        <button className="btn-new" onClick={onNew}>
          + New
        </button>
      </div>
      {sessions.length === 0 && <div className="sidebar__empty">Nothing saved yet.</div>}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`session${s.id === activeId ? ' session--active' : ''}`}
          onClick={() => onSelect(s.id)}
        >
          <span className="session__main">
            <span className={`session__mode session__mode--${s.mode}`}>{MODE_LABEL[s.mode] ?? s.mode}</span>
            <span className="session__title">{s.title}</span>
          </span>
          <button
            className="session__del"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(s.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </aside>
  );
}
