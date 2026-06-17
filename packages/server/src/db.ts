import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ENV } from './env.js';

/**
 * SQLite persistence for the §9 sidebar sessions. Plain, synchronous, single
 * file. Uses Node's built-in `node:sqlite` — no native module to compile.
 * No model or Scryfall concerns here — just storage.
 */

const db = new DatabaseSync(ENV.dbPath);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    mode        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`);

// Migration: a session now carries its full UI state as a JSON blob so any tab
// (analyse / build / recommend) can be saved and reloaded. Safe to re-run.
try {
  db.exec('ALTER TABLE sessions ADD COLUMN state TEXT');
} catch {
  /* column already exists */
}

export interface Session {
  id: string;
  title: string;
  mode: string;
  created_at: number;
  updated_at: number;
  state: string | null;
}

export interface Message {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

export const sessions = {
  list(): Session[] {
    return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as Session[];
  },
  get(id: string): Session | undefined {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as Session | undefined;
  },
  create(mode: string, title: string): Session {
    const now = Date.now();
    const session: Session = { id: randomUUID(), title, mode, created_at: now, updated_at: now, state: null };
    db.prepare(
      'INSERT INTO sessions (id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(session.id, session.title, session.mode, session.created_at, session.updated_at);
    return session;
  },
  rename(id: string, title: string): void {
    db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
  },
  /** Save the title + serialized UI state (the whole conversation/result for that tab). */
  save(id: string, title: string, state: string): void {
    db.prepare('UPDATE sessions SET title = ?, state = ?, updated_at = ? WHERE id = ?').run(
      title,
      state,
      Date.now(),
      id,
    );
  },
  touch(id: string): void {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  },
  remove(id: string): void {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  },
};

export const messages = {
  list(sessionId: string): Message[] {
    return db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as unknown as Message[];
  },
  add(sessionId: string, role: string, content: string): Message {
    const message: Message = {
      id: randomUUID(),
      session_id: sessionId,
      role,
      content,
      created_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(message.id, message.session_id, message.role, message.content, message.created_at);
    sessions.touch(sessionId);
    return message;
  },
};
