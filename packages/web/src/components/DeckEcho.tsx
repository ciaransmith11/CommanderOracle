import type { CategorizedDeck } from '@commander-oracle/shared';
import { CardName } from './CardName.js';
import { ColorPips } from './ManaPips.js';

/**
 * The deterministic, categorised echo (handoff §3 phase 1). Rendered entirely
 * from the verified `CategorizedDeck` — the model is not involved here.
 */
export function DeckEcho({ deck }: { deck: CategorizedDeck }) {
  return (
    <div className="echo">
      <div className="echo__head">
        <span className="echo__title">Decklist</span>
        <span className="echo__meta">
          <strong>{deck.grandTotal}</strong> cards · <strong>{deck.landCount}</strong> lands ·{' '}
          <span className="echo__price">${deck.priceTotalUsd.toFixed(2)}</span>
        </span>
      </div>

      {deck.commander.length > 0 && (
        <Section title="Commander" count={deck.commander.length}>
          {deck.commander.map((card) => (
            <li className="echo__card" key={card.name}>
              <CardName card={card} /> <ColorPips identity={card.colorIdentity} />
            </li>
          ))}
        </Section>
      )}

      {deck.sections.map((section) => (
        <Section key={section.section} title={section.section} count={section.count}>
          {section.cards.map(({ qty, card }) => (
            <li className="echo__card" key={card.name}>
              <span className="echo__qty">{qty}×</span> <CardName card={card} />
            </li>
          ))}
        </Section>
      ))}

      {deck.unresolved.length > 0 && (
        <div className="echo__unresolved">
          ⚠ Could not look up: {deck.unresolved.join(', ')}
        </div>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="echo__section">
      <div className="echo__section-head">
        {title} <span className="count">({count})</span>
      </div>
      <ul className="echo__cards">{children}</ul>
    </div>
  );
}
