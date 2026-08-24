import { useState } from 'react';
import type { Card, CategorizedCard } from '@commander-oracle/shared';
import { accentForColors } from './deck.js';

export function CardTile({
  card,
  qty,
  note,
  hoverNote,
  role,
  onRemove,
  action,
}: {
  card: Card;
  qty?: number;
  note?: string;
  hoverNote?: string;
  role?: string;
  onRemove?: () => void;
  action?: { label: string; onClick: () => void };
}) {
  // Prefer the full card face (image_uris.normal, DFC-aware on the server); fall
  // back to the illustration crop only if the full image is missing.
  const img = card.imageUrl ?? card.artCrop ?? null;
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="tile" title={hoverNote}>
      <a
        className={`tile__card${loaded ? ' is-loaded' : ''}`}
        href={card.scryfallUri ?? '#'}
        target="_blank"
        rel="noreferrer"
        title={card.name}
      >
        {img ? (
          <img
            src={img}
            alt={card.name}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setLoaded(true)}
          />
        ) : (
          <div className="tile__art-fallback">{card.name}</div>
        )}
        {role && (
          <span className="tile__role" style={{ borderColor: accentForColors(card.colorIdentity) }}>
            {role}
          </span>
        )}
        {qty && qty > 1 && <span className="tile__qty">{qty}×</span>}
        {onRemove && (
          <button
            className="tile__remove"
            onClick={(e) => {
              e.preventDefault();
              onRemove();
            }}
            aria-label={`Remove ${card.name}`}
            type="button"
          >
            ×
          </button>
        )}
      </a>
      {note && <span className="tile__note">{note}</span>}
      {action && (
        <button className="tile__action" onClick={action.onClick} type="button">
          {action.label}
        </button>
      )}
    </div>
  );
}

const TYPE_ORDER = [
  'Creatures',
  'Planeswalkers',
  'Sorceries',
  'Instants',
  'Artifacts',
  'Enchantments',
  'Battles',
  'Lands',
  'Other',
];
const ROLE_ORDER = ['Ramp', 'Card Advantage', 'Targeted Disruption', 'Mass Disruption', 'Plan', 'Lands'];

function typeSection(c: Card): string {
  const t = c.typeLine;
  if (t.includes('Creature')) return 'Creatures';
  if (t.includes('Land')) return 'Lands';
  if (t.includes('Planeswalker')) return 'Planeswalkers';
  if (t.includes('Battle')) return 'Battles';
  if (t.includes('Instant')) return 'Instants';
  if (t.includes('Sorcery')) return 'Sorceries';
  if (t.includes('Artifact')) return 'Artifacts';
  if (t.includes('Enchantment')) return 'Enchantments';
  return 'Other';
}

/**
 * The deck's card grid. Groups by FUNCTIONAL ROLE once the deck is classified;
 * falls back to card type while classification is pending or unavailable.
 */
export function DeckGrid({
  cards,
  commander,
  onRemove,
}: {
  cards: CategorizedCard[];
  commander: Card | null;
  onRemove?: (name: string) => void;
}) {
  const byRole = cards.some((c) => c.role);
  const order = byRole ? ROLE_ORDER : TYPE_ORDER;
  const sectionOf = (item: CategorizedCard): string =>
    byRole
      ? item.role ?? (/\bLand\b/.test(item.card.typeLine) ? 'Lands' : 'Plan')
      : typeSection(item.card);

  const groups = new Map<string, CategorizedCard[]>();
  for (const item of cards) {
    const s = sectionOf(item);
    (groups.get(s) ?? groups.set(s, []).get(s)!).push(item);
  }

  return (
    <div className="deckgrid">
      {commander && (
        <section className="deckgrid__section">
          <h3 className="deckgrid__heading">Commander</h3>
          <div className="deckgrid__cards">
            <CardTile card={commander} />
          </div>
        </section>
      )}
      {order.filter((s) => groups.has(s)).map((s) => {
        const items = groups.get(s)!.slice().sort((a, b) => a.card.name.localeCompare(b.card.name));
        const count = items.reduce((n, e) => n + e.qty, 0);
        return (
          <section key={s} className="deckgrid__section">
            <h3 className="deckgrid__heading">
              {s} <span className="deckgrid__count">{count}</span>
            </h3>
            <div className="deckgrid__cards">
              {items.map((item) => (
                <CardTile
                  key={item.card.name}
                  card={item.card}
                  qty={item.qty}
                  role={byRole ? s : undefined}
                  hoverNote={item.note}
                  onRemove={onRemove ? () => onRemove(item.card.name) : undefined}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
