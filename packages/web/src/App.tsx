import { useEffect, useRef, useState } from 'react';
import type { Card, CategorizedDeck } from '@commander-oracle/shared';
import {
  api,
  streamAnalyse,
  streamBuild,
  streamChat,
  streamRecommend,
  type BuildStrategy,
  type Health,
  type RecommendMeta,
  type SessionMeta,
} from './api.js';
import { Header } from './components/Header.js';
import { Sidebar } from './components/Sidebar.js';
import { DeckEcho } from './components/DeckEcho.js';
import { Markdown } from './components/Markdown.js';

type Tab = 'analyse' | 'build' | 'recommend';

type Item =
  | { role: 'user'; content: string }
  | { role: 'deck'; deck: CategorizedDeck }
  | { role: 'assistant'; content: string };

const TABS: { id: Tab; label: string }[] = [
  { id: 'analyse', label: 'Analyse' },
  { id: 'build', label: 'Build' },
  { id: 'recommend', label: 'Recommend' },
];

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTab] = useState<Tab>('analyse');
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef('');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    refreshSessions();
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: contentRef.current.scrollHeight });
  }, [items, streaming]);

  function refreshSessions() {
    api.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
  }

  function resetThread() {
    setItems([]);
    setStreaming('');
    setError(null);
    setActiveSession(null);
  }

  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    resetThread();
  }

  async function openSession(id: string) {
    setError(null);
    const { session, messages } = await api.getSession(id);
    setTab(session.mode === 'build' ? 'build' : 'analyse');
    setActiveSession(id);
    setStreaming('');
    setItems(
      messages.map((m): Item => {
        if (m.role === 'deck') return { role: 'deck', deck: JSON.parse(m.content) as CategorizedDeck };
        if (m.role === 'assistant') return { role: 'assistant', content: m.content };
        return { role: 'user', content: m.content };
      }),
    );
  }

  async function deleteSession(id: string) {
    await api.deleteSession(id);
    if (id === activeSession) resetThread();
    refreshSessions();
  }

  /** Stream a model response into the thread, persisting to a session. */
  function runStream(
    sessionMode: Tab,
    title: string,
    userItem: Item,
    deckItem: Item | null,
    start: (h: {
      onDelta: (t: string) => void;
      onDone: () => void;
      onError: (m: string) => void;
    }) => void,
  ) {
    setBusy(true);
    setError(null);
    streamRef.current = '';

    const newItems: Item[] = deckItem ? [userItem, deckItem] : [userItem];
    setItems((prev) => [...prev, ...newItems]);

    (async () => {
      // Ensure a session exists, then persist the input messages.
      let sid = activeSession;
      if (!sid) {
        const { session } = await api.createSession(sessionMode, title);
        sid = session.id;
        setActiveSession(sid);
        refreshSessions();
      }
      await api.addMessage(sid, userItem.role, userItem.role === 'user' ? userItem.content : '');
      if (deckItem && deckItem.role === 'deck') {
        await api.addMessage(sid, 'deck', JSON.stringify(deckItem.deck));
      }

      start({
        onDelta: (t) => {
          streamRef.current += t;
          setStreaming(streamRef.current);
        },
        onDone: () => {
          const full = streamRef.current;
          setItems((prev) => [...prev, { role: 'assistant', content: full }]);
          setStreaming('');
          setBusy(false);
          if (sid) void api.addMessage(sid, 'assistant', full);
        },
        onError: (m) => {
          setError(m);
          setStreaming('');
          setBusy(false);
        },
      });
    })().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  }

  // --- Analyse: phase 1 echo (deterministic), then phase 2 stream ---
  async function handleAnalyse(text: string, commander: string) {
    setBusy(true);
    setError(null);
    try {
      const { deck } = await api.echo(text, commander.trim() || undefined);
      const title =
        deck.commander[0]?.name || commander.trim() || text.split('\n')[0]?.slice(0, 40) || 'Deck analysis';
      const content = commander.trim() ? `Commander: ${commander.trim()}\n\n${text}` : text;
      runStream('analyse', title, { role: 'user', content }, { role: 'deck', deck }, (h) =>
        streamAnalyse(deck, h),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // Follow-up chat after the initial analysis: re-send the verified deck plus
  // the conversation so far, stream the reply, and persist both turns.
  function handleFollowup(text: string) {
    const deckItem = items.find((i) => i.role === 'deck');
    if (!deckItem || deckItem.role !== 'deck') return;

    setBusy(true);
    setError(null);
    streamRef.current = '';

    const base: Item[] = [...items, { role: 'user', content: text }];
    setItems(base);

    const deckIdx = base.findIndex((i) => i.role === 'deck');
    const history = base
      .slice(deckIdx + 1)
      .filter((i) => i.role !== 'deck')
      .map((i) => ({
        role: i.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: 'content' in i ? i.content : '',
      }));

    const sid = activeSession;
    if (sid) void api.addMessage(sid, 'user', text);

    streamChat(deckItem.deck, history, {
      onDelta: (t) => {
        streamRef.current += t;
        setStreaming(streamRef.current);
      },
      onDone: () => {
        const full = streamRef.current;
        setItems((prev) => [...prev, { role: 'assistant', content: full }]);
        setStreaming('');
        setBusy(false);
        if (sid) void api.addMessage(sid, 'assistant', full);
      },
      onError: (m) => {
        setError(m);
        setStreaming('');
        setBusy(false);
      },
    });
  }

  // Every card in the active deck (commander + all sections), with image data —
  // used to reliably highlight card names in the analysis without lookups.
  const deckItemForCards = items.find((i) => i.role === 'deck');
  const deckCards =
    deckItemForCards && deckItemForCards.role === 'deck'
      ? [
          ...deckItemForCards.deck.commander,
          ...deckItemForCards.deck.sections.flatMap((s) => s.cards.map((c) => c.card)),
        ]
      : [];

  return (
    <div className="app">
      <Header model={health?.model} hasApiKey={health?.hasApiKey} />
      <Sidebar
        sessions={sessions}
        activeId={activeSession}
        onSelect={openSession}
        onNew={resetThread}
        onDelete={deleteSession}
      />
      <main className="main">
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? ' tab--active' : ''}`}
              onClick={() => switchTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'recommend' ? (
          <RecommendTab />
        ) : tab === 'build' ? (
          <BuildTab />
        ) : (
          <>
            <div className="content" ref={contentRef}>
              <div className="thread">
                {items.length === 0 && !streaming && (
                  <div className="placeholder">
                    <h2>Analyse a deck</h2>
                    <p>Add your commander and 99-card decklist below.</p>
                  </div>
                )}
                {items.map((item, i) =>
                  item.role === 'deck' ? (
                    <DeckEcho key={i} deck={item.deck} />
                  ) : item.role === 'assistant' ? (
                    <div className="bubble bubble--assistant" key={i}>
                      <Markdown text={item.content} cards={deckCards} />
                    </div>
                  ) : (
                    <div className="bubble bubble--user" key={i}>
                      {item.content}
                    </div>
                  ),
                )}
                {streaming && (
                  <div className="bubble bubble--assistant">
                    <Markdown text={streaming} streaming cards={deckCards} />
                  </div>
                )}
                {error && <div className="error-banner">⚠ {error}</div>}
              </div>
            </div>
            {items.some((i) => i.role === 'assistant') ? (
              <ChatComposer busy={busy} onSubmit={handleFollowup} />
            ) : (
              <AnalyseComposer busy={busy} onSubmit={handleAnalyse} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function AnalyseComposer({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (text: string, commander: string) => void;
}) {
  const [text, setText] = useState('');
  const [commander, setCommander] = useState('');
  return (
    <div className="composer">
      <div className="composer__row">
        <input
          type="text"
          placeholder="Commander (required)"
          value={commander}
          onChange={(e) => setCommander(e.target.value)}
        />
      </div>
      <div className="composer__inner">
        <textarea
          placeholder={'Paste your 99-card decklist…\n1 Sol Ring\n1 Arcane Signet\n...'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <button
          className="btn-send"
          disabled={busy || !text.trim() || !commander.trim()}
          onClick={() => onSubmit(text, commander)}
        >
          {busy ? 'Analysing…' : 'Analyse'}
        </button>
      </div>
      <div className="composer__hint">
        Counts and categories are computed deterministically from live Scryfall data — the model does
        judgment only.
      </div>
    </div>
  );
}

function ChatComposer({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  function send() {
    if (text.trim() && !busy) {
      onSubmit(text.trim());
      setText('');
    }
  }
  return (
    <div className="composer">
      <div className="composer__inner">
        <textarea
          placeholder="Ask a follow-up — e.g. “suggest cuts”, “show the mana curve”, “what are my biggest imbalances?”"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        <button className="btn-send" disabled={busy || !text.trim()} onClick={send}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
      <div className="composer__hint">Ask anything about this deck — cuts, additions, imbalances, the curve.</div>
    </div>
  );
}

function BuildTab() {
  const [commander, setCommander] = useState('');
  const [commanderCard, setCommanderCard] = useState<Card | null>(null);
  const [strategies, setStrategies] = useState<BuildStrategy[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acc = useRef('');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: contentRef.current.scrollHeight });
  }, [text, strategies, chosen]);

  async function explore() {
    if (!commander.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStrategies(null);
    setChosen(null);
    setText('');
    try {
      const r = await api.buildStrategies(commander.trim());
      setCommanderCard(r.commander);
      setStrategies(r.strategies);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function choose(strategy: string) {
    if (!strategy.trim() || busy) return;
    setChosen(strategy);
    setText('');
    acc.current = '';
    setBusy(true);
    setError(null);
    streamBuild(
      { commander: commander.trim(), strategy },
      {
        onDelta: (t) => {
          acc.current += t;
          setText(acc.current);
        },
        onDone: () => setBusy(false),
        onError: (m) => {
          setError(m);
          setBusy(false);
        },
      },
    );
  }

  return (
    <>
      <div className="content" ref={contentRef}>
        <div className="thread">
          {!strategies && !busy && !text && (
            <div className="placeholder">
              <h2>Build a deck</h2>
              <p>Name a commander to see distinct ways to build around it, then pick a direction.</p>
            </div>
          )}

          {commanderCard && strategies && !chosen && (
            <div className="echo">
              <div className="echo__head">
                <span className="echo__title">{commanderCard.name}</span>
                <span className="echo__meta">{commanderCard.typeLine}</span>
              </div>
              <p style={{ marginTop: 0, color: 'var(--inkMid)' }}>Choose a direction to build around:</p>
              {strategies.map((s) => (
                <button
                  key={s.name}
                  className="strategy-card"
                  onClick={() => choose(`${s.name}: ${s.description}`)}
                >
                  <strong>{s.name}</strong>
                  <span>{s.description}</span>
                </button>
              ))}
              <div className="composer__row" style={{ margin: '12px 0 0' }}>
                <input
                  type="text"
                  placeholder="…or describe your own direction"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && choose(custom)}
                />
                <button className="btn-send" disabled={!custom.trim()} onClick={() => choose(custom)}>
                  Build
                </button>
              </div>
            </div>
          )}

          {chosen && (
            <>
              <div className="bubble bubble--user">Building around: {chosen}</div>
              {text && (
                <div className="bubble bubble--assistant">
                  <Markdown text={text} streaming={busy} />
                </div>
              )}
              {!busy && strategies && (
                <button className="linkish" onClick={() => setChosen(null)}>
                  ← choose a different direction
                </button>
              )}
            </>
          )}

          {error && <div className="error-banner">⚠ {error}</div>}
        </div>
      </div>
      <div className="composer">
        <div className="composer__inner">
          <input
            type="text"
            placeholder="Commander (e.g. Krenko, Mob Boss)"
            value={commander}
            onChange={(e) => setCommander(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && explore()}
          />
          <button className="btn-send" disabled={busy || !commander.trim()} onClick={explore}>
            {busy && !strategies ? 'Exploring…' : 'Explore strategies'}
          </button>
        </div>
        <div className="composer__hint">
          Pick a build direction, then get real, on-strategy card recommendations sourced from Scryfall.
        </div>
      </div>
    </>
  );
}

function RecommendTab() {
  const [commander, setCommander] = useState('');
  const [strategy, setStrategy] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<RecommendMeta | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const acc = useRef('');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: contentRef.current.scrollHeight });
  }, [text, meta]);

  function run() {
    if (!strategy.trim()) return;
    setBusy(true);
    setError(null);
    setMeta(null);
    setText('');
    acc.current = '';
    streamRecommend(
      { commander: commander.trim() || undefined, strategy: strategy.trim() },
      {
        onMeta: setMeta,
        onDelta: (t) => {
          acc.current += t;
          setText(acc.current);
        },
        onDone: () => setBusy(false),
        onError: (m) => {
          setError(m);
          setBusy(false);
        },
      },
    );
  }

  return (
    <>
      <div className="content" ref={contentRef}>
        <div className="thread">
          {!text && !busy && !error && (
            <div className="placeholder">
              <h2>Recommend cards</h2>
              <p>
                Describe a strategy or keyword (and optionally a commander) — Commander Oracle searches
                live Scryfall for real matching cards, then curates them by role.
              </p>
            </div>
          )}
          {meta && (
            <div className="echo" style={{ padding: '12px 16px' }}>
              <span className="echo__title">Searched Scryfall</span>
              <div className="echo__meta" style={{ marginTop: 6 }}>
                <strong>{meta.candidateCount}</strong> candidate cards considered
              </div>
              {meta.queries.map((q) => (
                <div key={q} className="echo__card" style={{ marginTop: 4 }}>
                  <code>{q}</code>
                </div>
              ))}
            </div>
          )}
          {text && (
            <div className="bubble bubble--assistant">
              <Markdown text={text} streaming={busy} />
            </div>
          )}
          {error && <div className="error-banner">⚠ {error}</div>}
        </div>
      </div>
      <div className="composer">
        <div className="composer__row">
          <input
            type="text"
            placeholder="Commander (optional, constrains colour identity)"
            value={commander}
            onChange={(e) => setCommander(e.target.value)}
          />
        </div>
        <div className="composer__inner">
          <textarea
            placeholder="Strategy or keyword (e.g. “treasure tokens and sacrifice payoffs”, “lifegain triggers”)"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            rows={2}
          />
          <button className="btn-send" disabled={busy || !strategy.trim()} onClick={run}>
            {busy ? 'Finding…' : 'Recommend'}
          </button>
        </div>
        <div className="composer__hint">
          Candidate cards come from a live Scryfall search; the model only curates real results.
        </div>
      </div>
    </>
  );
}
