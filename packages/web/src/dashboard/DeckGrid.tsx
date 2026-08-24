import type { Card, CategorizedCard } from '@commander-oracle/shared';

/** Colour-accent bar keyed to a card's colour identity (gold if multi, grey if colourless). */
function accentBar(colorIdentity: string[]): string {
  const COLOR: Record<string, string> = {
    W: '#e9dba6',
    U: '#2f6fb0',
    B: '#4a4550',
    R: '#b0432f',
    G: '#3f8a58',
  };
  if (colorIdentity.length === 0) return '#b9c0c7';
  if (colorIdentity.length === 1) return COLOR[colorIdentity[0]!] ?? '#b9c0c7';
  const stops = colorIdentity.map((c) => COLOR[c] ?? '#b9c0c7');
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** The short type — "Legendary Creature — Goblin" → "Creature". */
function shortType(typeLine: string): string {
  const face = typeLine.split('//')[0]!;
  const main = face.split('—')[0]!.trim();
  const words = main.split(/\s+/).filter((w) => !['Legendary', 'Basic', 'Snow', 'Tribal', 'World'].includes(w));
  return words[words.length - 1] ?? main;
}

export function CardTile({
  card,
  qty,
  note,
  hoverNote,
  onRemove,
  action,
}: {
  card: Card;
  qty?: number;
  note?: string;
  hoverNote?: string;
  onRemove?: () => void;
  action?: { label: string; onClick: () => void };
}) {
  const art = card.artCrop ?? card.imageUrl ?? null;
  return (
    <div className="tile" title={hoverNote}>
      <div className="tile__accent" style={{ background: accentBar(card.colorIdentity) }} />
      <div className="tile__art">
        {art ? (
          <img src={art} alt="" loading="lazy" />
        ) : (
          <div className="tile__art-fallback">{card.name}</div>
        )}
        {qty && qty > 1 && <span className="tile__qty">{qty}×</span>}
        {onRemove && (
          <button className="tile__remove" onClick={onRemove} aria-label={`Remove ${card.name}`} type="button">
            ×
          </button>
        )}
      </div>
      <div className="tile__meta">
        <a className="tile__name" href={card.scryfallUri ?? '#'} target="_blank" rel="noreferrer" title={card.name}>
          {card.name}
        </a>
        <span className="tile__type">{shortType(card.typeLine)}</span>
        {note && <span className="tile__note">{note}</span>}
      </div>
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
