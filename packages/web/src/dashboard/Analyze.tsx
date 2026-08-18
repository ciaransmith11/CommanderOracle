import { useState } from 'react';
import { api } from '../api.js';
import { useDeck } from './deck.js';
import { Dashboard } from './Dashboard.js';

/**
 * Analyze mode: an empty state that takes a pasted decklist, resolves it via
 * /api/echo, and loads it into deck state — at which point the shared Dashboard
 * (stats row + card grid) takes over.
 */
export function AnalyzePane() {
  const { isEmpty, loadDeck, reset } = useDeck();
  const [text, setText] = useState('');
  const [commander, setCommander] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { deck } = await api.echo(text, commander.trim() || undefined);
      loadDeck({
        commander: deck.commander[0] ?? null,
        cards: deck.sections.flatMap((s) => s.cards),
        name: deck.commander[0]?.name,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!isEmpty) {
    return (
      <div className="dashboard-wrap">
        <button className="linkbtn" onClick={reset} type="button">
          ← analyze a different deck
        </button>
        <Dashboard />
      </div>
    );
  }

  return (
    <div className="paste">
      <div className="paste__card">
        <h2 className="empty__title">Analyze a deck</h2>
        <p className="empty__body">
          Paste a decklist to see its mana curve, colour identity, and deck health — with the full card grid
          below.
        </p>
        <input
          className="paste__field"
          placeholder="Commander (optional — auto-detected from the list)"
          value={commander}
          onChange={(e) => setCommander(e.target.value)}
        />
        <textarea
          className="paste__field paste__list"
          placeholder={'1 Sol Ring\n1 Arcane Signet\n1 Cultivate\n...'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
        />
        {error && <div className="paste__error">⚠ {error}</div>}
        <button className="paste__go" onClick={analyze} disabled={busy || !text.trim()} type="button">
          {busy ? 'Analyzing…' : 'Analyze deck'}
        </button>
        <div className="paste__note">Counts and categories are computed from live Scryfall data.</div>
      </div>
    </div>
  );
}
