import { useState } from 'react';
import type { Card } from '@commander-oracle/shared';
import { api } from '../api.js';
import { useDeck } from './deck.js';
import { CardTile } from './DeckGrid.js';

/**
 * Recommend mode: describe a strategy → real, on-colour cards grouped by role.
 * No deck stats (there's no full deck) — each card has an "Add" action that puts
 * it into the shared deck state, so switching to Analyze/Build shows it there.
 */
export function RecommendPane() {
  const { addCard, cards } = useDeck();
  const [strategy, setStrategy] = useState('');
  const [commander, setCommander] = useState('');
  const [groups, setGroups] = useState<{ role: string; cards: Card[] }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inDeck = new Set(cards.map((e) => e.card.name.toLowerCase()));

  async function find() {
    if (!strategy.trim() || busy) return;
    setBusy(true);
    setError(null);
    setGroups(null);
    try {
      const r = await api.recommendCards(strategy.trim(), commander.trim() || undefined);
      setGroups(r.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="recommend">
      <div className="recommend__bar">
        <input
          className="paste__field"
          style={{ marginTop: 0 }}
          placeholder="Strategy or keyword (e.g. treasure sacrifice payoffs)"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && find()}
        />
        <input
          className="paste__field recommend__cmdr"
          style={{ marginTop: 0 }}
          placeholder="Commander (optional)"
          value={commander}
          onChange={(e) => setCommander(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && find()}
        />
        <button className="paste__go recommend__go" onClick={find} disabled={busy || !strategy.trim()} type="button">
          {busy ? 'Finding…' : 'Find cards'}
        </button>
      </div>

      {error && <div className="paste__error">⚠ {error}</div>}

      {!groups && !busy && !error && (
        <div className="empty">
          <div className="empty__card">
            <h2 className="empty__title">Find cards</h2>
            <p className="empty__body">
              Describe a strategy (and optionally a commander) to get real, on-colour cards grouped by role —
              ramp, removal, payoffs, and more — that you can add straight to your deck.
            </p>
          </div>
        </div>
      )}

      {busy && <div className="building__status" style={{ marginTop: 24 }}>Searching Scryfall by role…</div>}

      {groups?.length === 0 && <div className="build__loading">No cards matched — try a broader strategy.</div>}

      {groups?.map((g) => (
        <section key={g.role} className="deckgrid__section">
          <h3 className="deckgrid__heading">
            {g.role} <span className="deckgrid__count">{g.cards.length}</span>
          </h3>
          <div className="deckgrid__cards">
            {g.cards.map((card) => {
              const added = inDeck.has(card.name.toLowerCase());
              return (
                <CardTile
                  key={card.name}
                  card={card}
                  action={{ label: added ? 'Added ✓' : 'Add', onClick: () => addCard(card) }}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
