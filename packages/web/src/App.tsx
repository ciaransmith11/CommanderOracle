import { useEffect, useRef, useState } from 'react';
import type { Card, CategorizedDeck } from '@commander-oracle/shared';
import {
  api,
  streamAnalyse,
  streamBuild,
  streamChat,
  streamRecommend,
  streamRules,
  type BuildStrategy,
  type Health,
  type RecommendMeta,
  type SessionMeta,
} from './api.js';
import { Header } from './components/Header.js';
import { Sidebar } from './components/Sidebar.js';
import { DeckEcho } from './components/DeckEcho.js';
import { Markdown } from './components/Markdown.js';

type Tab = 'analyse' | 'build' | 'recommend' | 'rules';

const TABS: { id: Tab; label: string }[] = [
  { id: 'analyse', label: 'Analyse' },
  { id: 'build', label: 'Build' },
  { id: 'recommend', label: 'Recommend' },
  { id: 'rules', label: 'Rules' },
];

/** Persist a tab's full state under a session; creates one on first save. Returns the id. */
type Persist = (mode: Tab, title: string, state: unknown, existingId: string | null) => Promise<string>;

/** The first Markdown heading in a response, cleaned up — used to title a session. */
function firstHeading(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m && m[1]) {
      return m[1]
        .replace(/[*_`]/g, '')
        .replace(/[#]+$/, '')
        .trim()
        .slice(0, 60);
    }
  }
  return null;
}

interface TabProps {
  initial: unknown | null;
  sessionId: string | null;
  persist: Persist;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTab] = useState<Tab>('analyse');
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<{ id: string; mode: string; state: unknown } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    refreshSessions();
  }, []);

  function refreshSessions() {
    api.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
  }

  const persist: Persist = async (mode, title, state, existingId) => {
    let id = existingId;
    if (!id) {
      const { session } = await api.createSession(mode, title);
      id = session.id;
    }
    await api.saveSession(id, title, JSON.stringify(state));
    refreshSessions();
    return id;
  };

  async function openSession(id: string) {
    const { session } = await api.getSession(id);
    const state = session.state ? JSON.parse(session.state) : null;
    setTab(session.mode as Tab);
    setSelected({ id, mode: session.mode, state });
  }

  function newSession() {
    setSelected(null);
    setNonce((n) => n + 1);
  }

  async function deleteSession(id: string) {
    await api.deleteSession(id);
    if (selected?.id === id) newSession();
    refreshSessions();
  }

  // The active tab is remounted (via key) whenever a session is opened or "New"
  // is pressed, so it initialises cleanly from the selected session's state.
  const matched = selected && selected.mode === tab ? selected : null;
  const key = `${tab}:${matched ? matched.id : `new-${nonce}`}`;
  const tabProps: TabProps = { initial: matched?.state ?? null, sessionId: matched?.id ?? null, persist };

  return (
    <div className="app">
      <Header model={health?.model} hasApiKey={health?.hasApiKey} />
      <Sidebar
        sessions={sessions}
        activeId={selected?.id ?? null}
        onSelect={openSession}
        onNew={newSession}
        onDelete={deleteSession}
      />
      <main className="main">
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab tab--${t.id}${tab === t.id ? ' tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'analyse' && <AnalyseTab key={key} {...tabProps} />}
        {tab === 'build' && <BuildTab key={key} {...tabProps} />}
        {tab === 'recommend' && <RecommendTab key={key} {...tabProps} />}
        {tab === 'rules' && <RulesTab key={key} {...tabProps} />}
      </main>
    </div>
  );
}

// --- Shared bits ----------------------------------------------------------

type Item =
  | { role: 'user'; content: string }
  | { role: 'deck'; deck: CategorizedDeck }
  | { role: 'assistant'; content: string };

function WorkingBubble({ label }: { label: string }) {
  return (
    <div className="bubble bubble--assistant working">
      <span>{label}</span>
      <span className="cursor" />
    </div>
  );
}

function ChatComposer({
  busy,
  placeholder,
  onSubmit,
}: {
  busy: boolean;
  placeholder: string;
  onSubmit: (text: string) => void;
}) {
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
          placeholder={placeholder}
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
    </div>
  );
}

// --- Analyse --------------------------------------------------------------

interface AnalyseState {
  items: Item[];
}

function AnalyseTab({ initial, sessionId, persist }: TabProps) {
  const init = (initial as AnalyseState | null) ?? null;
  const [items, setItems] = useState<Item[]>(init?.items ?? []);
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const acc = useRef('');
  const sid = useRef<string | null>(sessionId);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: contentRef.current.scrollHeight });
  }, [items, streaming, status]);

  const deckItem = items.find((i) => i.role === 'deck');
  const deckCards =
    deckItem && deckItem.role === 'deck'
      ? [...deckItem.deck.commander, ...deckItem.deck.sections.flatMap((s) => s.cards.map((c) => c.card))]
      : [];

  function save(next: Item[]) {
    const d = next.find((i) => i.role === 'deck');
    const title = (d && d.role === 'deck' && d.deck.commander[0]?.name) || 'Deck analysis';
    void persist('analyse', title, { items: next } satisfies AnalyseState, sid.current).then((id) => {
      sid.current = id;
    });
  }

  async function analyse(text: string, commander: string) {
    setBusy(true);
    setError(null);
    setStatus('');
    let deck: CategorizedDeck;
    try {
      ({ deck } = await api.echo(text, commander.trim() || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    const content = commander.trim() ? `Commander: ${commander.trim()}\n\n${text}` : text;
    const base: Item[] = [...items, { role: 'user', content }, { role: 'deck', deck }];
    setItems(base);
    acc.current = '';
    streamAnalyse(deck, {
      onStatus: setStatus,
      onDelta: (t) => {
        setStatus('');
        acc.current += t;
        setStreaming(acc.current);
      },
      onDone: () => {
        const next: Item[] = [...base, { role: 'assistant', content: acc.current }];
        setItems(next);
        setStreaming('');
        setStatus('');
        setBusy(false);
        save(next);
      },
      onError: (m) => {
        setError(m);
        setStreaming('');
        setStatus('');
        setBusy(false);
      },
    });
  }

  function followUp(text: string) {
    if (!deckItem || deckItem.role !== 'deck') return;
    setBusy(true);
    setError(null);
    setStatus('');
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
    acc.current = '';
    streamChat(deckItem.deck, history, {
      onStatus: setStatus,
      onDelta: (t) => {
        setStatus('');
        acc.current += t;
        setStreaming(acc.current);
      },
      onDone: () => {
        const next: Item[] = [...base, { role: 'assistant', content: acc.current }];
        setItems(next);
        setStreaming('');
        setStatus('');
        setBusy(false);
        save(next);
      },
      onError: (m) => {
        setError(m);
        setStreaming('');
        setStatus('');
        setBusy(false);
      },
    });
  }

  const hasAnalysis = items.some((i) => i.role === 'assistant');

  return (
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
          {busy && !streaming && <WorkingBubble label={status || 'Working…'} />}
          {error && <div className="error-banner">⚠ {error}</div>}
        </div>
      </div>
      {hasAnalysis ? (
        <ChatComposer
          busy={busy}
          placeholder="Ask a follow-up — e.g. “suggest cuts”, “show the mana curve”, “my biggest imbalances?”"
          onSubmit={followUp}
        />
      ) : (
        <AnalyseComposer busy={busy} onSubmit={analyse} />
      )}
    </>
  );
}

function AnalyseComposer({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string, commander: string) => void }) {
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
        Counts and categories are computed deterministically from live Scryfall data — the model does judgment only.
      </div>
    </div>
  );
}

// --- Build ----------------------------------------------------------------

type BuildMsg = { role: 'user' | 'assistant'; content: string };

interface BuildState {
  commander: string;
  commanderCard: Card | null;
  strategies: BuildStrategy[] | null;
  chosen: string | null;
  convo: BuildMsg[];
}

function BuildTab({ initial, sessionId, persist }: TabProps) {
  const init = (initial as BuildState | null) ?? null;
  const [commander, setCommander] = useState(init?.commander ?? '');
  const [commanderCard, setCommanderCard] = useState<Card | null>(init?.commanderCard ?? null);
  const [strategies, setStrategies] = useState<BuildStrategy[] | null>(init?.strategies ?? null);
  const [chosen, setChosen] = useState<string | null>(init?.chosen ?? null);
  const [custom, setCustom] = useState('');
  const [convo, setConvo] = useState<BuildMsg[]>(init?.convo ?? []);
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const acc = useRef('');
  const sid = useRef<string | null>(sessionId);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: contentRef.current.scrollHeight });
  }, [convo, streaming, strategies, status]);

  function save(nextConvo: BuildMsg[], nextChosen: string | null, card = commanderCard, strats = strategies) {
    const state: BuildState = {
      commander,
      commanderCard: card,
      strategies: strats,
      chosen: nextChosen,
      convo: nextConvo,
    };
    void persist('build', commander || 'Build', state, sid.current).then((id) => {
      sid.current = id;
    });
  }

  async function explore() {
    if (!commander.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStrategies(null);
    setChosen(null);
    setConvo([]);
    setStreaming('');
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

  function runTurn(strategy: string, nextConvo: BuildMsg[]) {
    setBusy(true);
    setError(null);
    setStreaming('');
    setStatus('');
    acc.current = '';
    streamBuild(
      { commander: commander.trim(), strategy, messages: nextConvo.slice(1) },
      {
        onStatus: setStatus,
        onDelta: (t) => {
          setStatus('');
          acc.current += t;
          setStreaming(acc.current);
        },
        onDone: () => {
          const done = [...nextConvo, { role: 'assistant' as const, content: acc.current }];
          setConvo(done);
          setStreaming('');
          setStatus('');
          setBusy(false);
          save(done, strategy);
        },
        onError: (m) => {
          setError(m);
          setStreaming('');
          setStatus('');
          setBusy(false);
        },
      },
    );
  }

  function choose(strategy: string) {
    if (!strategy.trim() || busy) return;
    setChosen(strategy);
    const start: BuildMsg[] = [{ role: 'user', content: `Build around: ${strategy}` }];
    setConvo(start);
    runTurn(strategy, start);
  }

  function followUp(text: string) {
    if (!chosen) return;
    const next: BuildMsg[] = [...convo, { role: 'user', content: text }];
    setConvo(next);
    runTurn(chosen, next);
  }

  return (
    <>
      <div className="content" ref={contentRef}>
        <div className="thread">
          {!strategies && !busy && (
            <div className="placeholder">
              <h2>Build a deck</h2>
              <p>Name a commander to see distinct ways to build around it, then pick a direction.</p>
            </div>
          )}

          {busy && !strategies && !chosen && <WorkingBubble label="Finding build directions…" />}

          {commanderCard && strategies && !chosen && (
            <div className="echo">
              <div className="echo__head">
                <span className="echo__title">{commanderCard.name}</span>
                <span className="echo__meta">{commanderCard.typeLine}</span>
              </div>
              <p style={{ marginTop: 0, color: 'var(--inkMid)' }}>Choose a direction to build around:</p>
              {strategies.map((s) => (
                <button key={s.name} className="strategy-card" onClick={() => choose(`${s.name}: ${s.description}`)}>
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

          {chosen &&
            convo.map((m, i) =>
              m.role === 'assistant' ? (
                <div className="bubble bubble--assistant" key={i}>
                  <Markdown text={m.content} />
                </div>
              ) : (
                <div className="bubble bubble--user" key={i}>
                  {m.content}
                </div>
              ),
            )}
          {chosen && busy && !streaming && (
            <WorkingBubble label={status || 'Searching Scryfall and assembling your build…'} />
          )}
          {streaming && (
            <div className="bubble bubble--assistant">
              <Markdown text={streaming} streaming />
            </div>
          )}
          {chosen && !busy && strategies && (
            <button className="linkish" onClick={() => setChosen(null)}>
              ← choose a different direction
            </button>
          )}

          {error && <div className="error-banner">⚠ {error}</div>}
        </div>
      </div>

      {chosen ? (
        <ChatComposer
          busy={busy}
          placeholder="Ask a follow-up — e.g. “budget swaps”, “make it faster”, “explain the combo”"
          onSubmit={followUp}
        />
      ) : (
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
      )}
    </>
  );
}

// --- Recommend ------------------------------------------------------------

interface RecommendState {
  commander: string;
  strategy: string;
  meta: RecommendMeta | null;
  text: string;
}

function RecommendTab({ initial, sessionId, persist }: TabProps) {
  const init = (initial as RecommendState | null) ?? null;
  const [commander, setCommander] = useState(init?.commander ?? '');
  const [strategy, setStrategy] = useState(init?.strategy ?? '');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<RecommendMeta | null>(init?.meta ?? null);
  const [status, setStatus] = useState('');
  const [text, setText] = useState(init?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const acc = useRef('');
  const metaRef = useRef<RecommendMeta | null>(init?.meta ?? null);
  const sid = useRef<string | null>(sessionId);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: contentRef.current.scrollHeight });
  }, [text, meta, status]);

  function run() {
    if (!strategy.trim()) return;
    setBusy(true);
    setError(null);
    setMeta(null);
    setStatus('');
    setText('');
    acc.current = '';
    metaRef.current = null;
    streamRecommend(
      { commander: commander.trim() || undefined, strategy: strategy.trim() },
      {
        onMeta: (m) => {
          metaRef.current = m;
          setMeta(m);
        },
        onStatus: setStatus,
        onDelta: (t) => {
          setStatus('');
          acc.current += t;
          setText(acc.current);
        },
        onDone: () => {
          setBusy(false);
          const state: RecommendState = {
            commander,
            strategy,
            meta: metaRef.current,
            text: acc.current,
          };
          const title =
            firstHeading(acc.current) || strategy.trim().slice(0, 50) || commander || 'Recommendations';
          void persist('recommend', title, state, sid.current).then((id) => {
            sid.current = id;
          });
        },
        onError: (m) => {
          setError(m);
          setStatus('');
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
                Describe a strategy or keyword (and optionally a commander) — Commander Oracle searches live
                Scryfall for real matching cards, then curates them by role.
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
          {busy && !text && <WorkingBubble label={status || 'Searching Scryfall…'} />}
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

// --- Rules ----------------------------------------------------------------

interface RulesState {
  convo: BuildMsg[];
}

function RulesTab({ initial, sessionId, persist }: TabProps) {
  const init = (initial as RulesState | null) ?? null;
  const [convo, setConvo] = useState<BuildMsg[]>(init?.convo ?? []);
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const acc = useRef('');
  const sid = useRef<string | null>(sessionId);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: contentRef.current.scrollHeight });
  }, [convo, streaming, status]);

  function save(done: BuildMsg[]) {
    const firstQ = done.find((m) => m.role === 'user')?.content ?? 'Rules question';
    void persist('rules', firstQ.slice(0, 70), { convo: done } satisfies RulesState, sid.current).then((id) => {
      sid.current = id;
    });
  }

  function send(text: string) {
    const next: BuildMsg[] = [...convo, { role: 'user', content: text }];
    setConvo(next);
    setBusy(true);
    setError(null);
    setStreaming('');
    setStatus('');
    acc.current = '';
    streamRules(next, {
      onStatus: setStatus,
      onDelta: (t) => {
        setStatus('');
        acc.current += t;
        setStreaming(acc.current);
      },
      onDone: () => {
        const done: BuildMsg[] = [...next, { role: 'assistant', content: acc.current }];
        setConvo(done);
        setStreaming('');
        setStatus('');
        setBusy(false);
        save(done);
      },
      onError: (m) => {
        setError(m);
        setStreaming('');
        setStatus('');
        setBusy(false);
      },
    });
  }

  return (
    <>
      <div className="content" ref={contentRef}>
        <div className="thread">
          {convo.length === 0 && !busy && (
            <div className="placeholder">
              <h2>Rules & gameplay</h2>
              <p>
                Ask any Magic rules or interaction question. Answers are grounded in real card text from
                Scryfall, with step-by-step reasoning.
              </p>
            </div>
          )}
          {convo.map((m, i) =>
            m.role === 'assistant' ? (
              <div className="bubble bubble--assistant" key={i}>
                <Markdown text={m.content} />
              </div>
            ) : (
              <div className="bubble bubble--user" key={i}>
                {m.content}
              </div>
            ),
          )}
          {streaming && (
            <div className="bubble bubble--assistant">
              <Markdown text={streaming} streaming />
            </div>
          )}
          {busy && !streaming && <WorkingBubble label={status || 'Checking the rules…'} />}
          {error && <div className="error-banner">⚠ {error}</div>}
        </div>
      </div>
      <ChatComposer
        busy={busy}
        placeholder="Ask a rules question — e.g. “If I flicker a creature in response to its own ETB trigger, what happens?”"
        onSubmit={send}
      />
    </>
  );
}
