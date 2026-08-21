import type { Card } from '@commander-oracle/shared';

/**
 * Rules mode main area: no dashboard. The chat lives in the advisor; here we show
 * the real cards the latest answer referenced — image + name + oracle text — so
 * the player can see them without leaving the conversation.
 */
export function RulesReference({ cards, busy }: { cards: Card[]; busy: boolean }) {
  if (cards.length === 0) {
    return (
      <div className="empty">
        <div className="empty__card">
          <h2 className="empty__title">Rules &amp; interactions</h2>
          <p className="empty__body">
            Ask a rules or interaction question in the advisor. Answers cite the Comprehensive Rules, and any
            cards involved appear here with their oracle text.
          </p>
          {busy && <p className="empty__hint">Looking up the cards…</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="refs">
      <h3 className="deckgrid__heading">
        Cards in this answer <span className="deckgrid__count">{cards.length}</span>
      </h3>
      <div className="refs__list">
        {cards.map((c) => (
          <div className="ref" key={c.name}>
            {c.imageUrl && <img className="ref__img" src={c.imageUrl} alt={c.name} loading="lazy" />}
            <div className="ref__body">
              <a className="ref__name" href={c.scryfallUri ?? '#'} target="_blank" rel="noreferrer">
                {c.name}
              </a>
              <div className="ref__type">{c.typeLine}</div>
              <div className="ref__oracle">{c.oracleText}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
