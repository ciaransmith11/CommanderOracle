import { useState } from 'react';
import type { Card } from '@commander-oracle/shared';
import { api, streamBuild, type BuildStrategy } from '../api.js';
import { useDeck } from './deck.js';
import { Dashboard } from './Dashboard.js';

/** Pull the last ```decklist fenced block (or a "qty name" block) from build text. */
function extractDeckBlock(md: string): string | null {
  const fences = [...md.matchAll(/```([a-zA-Z]*)\s*\n([\s\S]*?)```/g)];
  const labeled = fences.filter((f) => /deck/i.test(f[1] ?? ''));
  const lists = fences.filter((f) => /^\s*\d+\s+\S/m.test(f[2] ?? ''));
  return (labeled.at(-1) ?? lists.at(-1))?.[2] ?? null;
}

/**
 * Build mode: conversational until a decklist exists, then the shared Dashboard.
 * Commander → strategy directions → stream the build → resolve the produced list
 * into deck state (the same loadDeck Analyze uses).
 */
export function BuildPane() {
  const { isEmpty, loadDeck, reset } = useDeck();
  const [commander, setCommander] = useState('');
  const [commanderCard, setCommanderCard] = useState<Card | null>(null);
  const [strategies, setStrategies] = useState<BuildStrategy[] | null>(null);
  const [custom, setCustom] = useState('');
  const [phase, setPhase] = useState<'idle' | 'strategies' | 'building'>('idle');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!isEmpty) {
    return (
      <div className="dashboard-wrap">
        <button className="linkbtn" onClick={reset} type="button">
          ← build a different deck
        </button>
        <Dashboard />
      </div>
    );
  }

  async function explore() {
    if (!commander.trim() || phase === 'strategies') return;
    setError(null);
    setPhase('strategies');
    setStrategies(null);
    try {
      const r = await api.buildStrategies(commander.trim());
      setCommanderCard(r.commander);
      setStrategies(r.strategies);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }

  function choose(strategy: string) {
    if (!strategy.trim()) return;
    setPhase('building');
    setProgress('');
    setStatus('');
    setError(null);
    let acc = '';
    streamBuild(
      { commander: commander.trim(), strategy, messages: [] },
      {
        onStatus: setStatus,
        onReset: () => {
          acc = '';
          setProgress('');
        },
        onDelta: (t) => {
          acc += t;
          setProgress(acc);
          setStatus('');
        },
        onError: (m) => {
          setError(m);
          setPhase('strategies');
        },
        onDone: async () => {
          const block = extractDeckBlock(acc);
          if (!block) {
            setError('The build finished without a decklist. Try again or pick another direction.');
            setPhase('strategies');
            return;
          }
          try {
            const { deck } = await api.echo(block, (commanderCard?.name ?? commander).trim());
            loadDeck({
              commander: deck.commander[0] ?? commanderCard ?? null,
              cards: deck.sections.flatMap((s) => s.cards),
              name: commanderCard?.name ?? commander,
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('strategies');
          }
        },
      },
    );
  }

  if (phase === 'building') {
    return (
      <div className="building">
        <div className="building__spinner" />
        <div className="building__status">{status || 'Assembling your deck…'}</div>
        {progress && <div className="building__progress">{progress.slice(-1200)}</div>}
      </div>
    );
  }

  if (phase === 'strategies') {
    return (
      <div className="build">
        <div className="build__card">
          <button className="linkbtn" onClick={() => setPhase('idle')} type="button">
            ← different commander
          </button>
          <h2 className="empty__title" style={{ marginTop: 8 }}>
            {commanderCard?.name ?? commander}
          </h2>
          <p className="empty__body">Choose a direction to build around:</p>
          {!strategies && <div className="build__loading">Finding build directions…</div>}
          {strategies?.map((s) => (
            <button key={s.name} className="strat" onClick={() => choose(`${s.name}: ${s.description}`)} type="button">
              <strong className="strat__name">{s.name}</strong>
              <span className="strat__desc">{s.description}</span>
            </button>
          ))}
          {strategies && (
            <div className="build__custom">
              <input
                className="paste__field"
                placeholder="…or describe your own direction"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && choose(custom)}
              />
              <button className="paste__go" style={{ marginTop: 10 }} disabled={!custom.trim()} onClick={() => choose(custom)} type="button">
                Build this
              </button>
            </div>
          )}
          {error && <div className="paste__error">⚠ {error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="paste">
      <div className="paste__card">
        <h2 className="empty__title">Build a deck</h2>
        <p className="empty__body">
          Name a commander and I'll propose distinct ways to build it. Pick a direction and the deck is
          assembled from real, on-colour cards — then it opens as a live dashboard.
        </p>
        <input
          className="paste__field"
          placeholder="Commander (e.g. Krenko, Mob Boss)"
          value={commander}
          onChange={(e) => setCommander(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && explore()}
        />
        {error && <div className="paste__error">⚠ {error}</div>}
        <button className="paste__go" onClick={explore} disabled={!commander.trim()} type="button">
          Explore directions
        </button>
      </div>
    </div>
  );
}
