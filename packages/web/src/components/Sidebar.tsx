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
  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">Decks</span>
        <button className="btn-new" onClick={onNew}>
          + New
        </button>
      </div>
      {sessions.length === 0 && <div className="sidebar__empty">No saved decks yet.</div>}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`session${s.id === activeId ? ' session--active' : ''}`}
          onClick={() => onSelect(s.id)}
        >
          <span className="session__title">{s.title}</span>
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
