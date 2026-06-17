import type { Card, CategorizedDeck } from '@commander-oracle/shared';

/** Client for the Commander Oracle backend. The frontend only ever talks here. */

export interface Health {
  ok: boolean;
  model: string;
  hasApiKey: boolean;
}

export interface SessionMeta {
  id: string;
  title: string;
  mode: string;
  created_at: number;
  updated_at: number;
  /** Serialized UI state for the tab (JSON); null until first save. */
  state: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch('/api/health').then(json<Health>),

  lookupCard: (name: string) =>
    fetch(`/api/card?name=${encodeURIComponent(name)}`).then(json<{ card: Card }>),

  /** Batch-resolve card names (one request, collection endpoint server-side). */
  lookupCards: (names: string[]) =>
    fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    }).then(json<{ cards: Card[] }>),

  buildStrategies: (commander: string) =>
    fetch('/api/build/strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commander }),
    }).then(json<{ commander: Card; strategies: BuildStrategy[] }>),

  echo: (text: string, commander?: string) =>
    fetch('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, commander }),
    }).then(json<{ deck: CategorizedDeck }>),

  // --- Sessions (unified history across all tabs) ---
  listSessions: () => fetch('/api/sessions').then(json<{ sessions: SessionMeta[] }>),
  createSession: (mode: string, title: string) =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, title }),
    }).then(json<{ session: SessionMeta }>),
  getSession: (id: string) => fetch(`/api/sessions/${id}`).then(json<{ session: SessionMeta }>),
  /** Save the title + serialized tab state for a session. */
  saveSession: (id: string, title: string, state: string) =>
    fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, state }),
    }).then(json<{ ok: boolean }>),
  deleteSession: (id: string) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),
};

export interface RecommendMeta {
  queries: string[];
  candidateCount: number;
}

export interface BuildStrategy {
  name: string;
  description: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  onMeta?: (meta: RecommendMeta) => void;
  /** Live status of silent background work (e.g. "Searching Scryfall…"). */
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
}

/** POST a body and consume the SSE stream (delta / done / error events). */
async function streamPost(url: string, body: unknown, h: StreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: h.signal,
    });
  } catch (err) {
    h.onError(err instanceof Error ? err.message : String(err));
    return;
  }

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    h.onError((data as { error?: string }).error ?? `Request failed (${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Parse SSE frames separated by blank lines. Each frame has an `event:` line
  // and one or more `data:` lines (joined with \n per the SSE spec).
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      handleFrame(frame, h);
    }
  }
}

function handleFrame(frame: string, h: StreamHandlers): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  const raw = dataLines.join('\n');

  if (event === 'delta') {
    try {
      h.onDelta((JSON.parse(raw) as { text: string }).text);
    } catch {
      /* ignore malformed frame */
    }
  } else if (event === 'meta') {
    try {
      h.onMeta?.(JSON.parse(raw) as RecommendMeta);
    } catch {
      /* ignore malformed frame */
    }
  } else if (event === 'status') {
    try {
      h.onStatus?.((JSON.parse(raw) as { text: string }).text);
    } catch {
      /* ignore malformed frame */
    }
  } else if (event === 'done') {
    h.onDone();
  } else if (event === 'error') {
    let message = raw;
    try {
      message = (JSON.parse(raw) as { message: string }).message;
    } catch {
      /* keep raw */
    }
    h.onError(message);
  }
}

export function streamAnalyse(deck: CategorizedDeck, h: StreamHandlers): void {
  void streamPost('/api/analyse', { deck }, h);
}

export function streamBuild(
  input: {
    commander: string;
    strategy: string;
    messages?: { role: 'user' | 'assistant'; content: string }[];
  },
  h: StreamHandlers,
): void {
  void streamPost('/api/build', input, h);
}

export function streamRecommend(input: { commander?: string; strategy: string }, h: StreamHandlers): void {
  void streamPost('/api/recommend', input, h);
}

export function streamChat(
  deck: CategorizedDeck,
  messages: { role: 'user' | 'assistant'; content: string }[],
  h: StreamHandlers,
): void {
  void streamPost('/api/chat', { deck, messages }, h);
}

export function streamRules(
  messages: { role: 'user' | 'assistant'; content: string }[],
  h: StreamHandlers,
): void {
  void streamPost('/api/rules', { messages }, h);
}
