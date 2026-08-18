import { useDeck, deckStats } from './deck.js';
import { StatsRow } from './StatsRow.js';
import { DeckGrid } from './DeckGrid.js';

/**
 * The deck dashboard — header + stats row + card grid, all reading from deck
 * state. Shared by Analyze and (once a build finishes) Build.
 */
export function Dashboard() {
  const { name, commander, cards, removeCard } = useDeck();
  const stats = deckStats(cards, commander);
  const title = commander?.name ?? name;
  const colorLabel =
    stats.colors.length === 0 ? 'Colourless' : stats.colors.length === 1 ? 'Mono' : `${stats.colors.length}-colour`;

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <div className="dashboard__id">
          <h1 className="dashboard__name" title={title}>
            {title}
          </h1>
          <div className="dashboard__sub">
            {commander ? 'Commander' : 'Deck'} · {stats.total} cards · {colorLabel}
          </div>
        </div>
        <span className="badge" title="Power bracket — coming from the advisor later">
          Bracket —
        </span>
      </div>

      <StatsRow cards={cards} commander={commander} />
      <DeckGrid cards={cards} commander={commander} onRemove={removeCard} />
    </div>
  );
}
