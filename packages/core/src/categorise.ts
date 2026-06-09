import type {
  Card,
  CategorizedCard,
  CategorizedDeck,
  DeckSection,
  Section,
} from '@commander-oracle/shared';

/**
 * Pure categorisation + counting. Buckets resolved cards by their Scryfall
 * `type_line`, sums quantities (never counts list items), and totals price.
 * The model never does any of this — it receives the finished `CategorizedDeck`.
 */

/** Display order for the echo. `Commander` is reported separately, not here. */
const SECTION_ORDER: readonly Section[] = [
  'Creatures',
  'Sorceries',
  'Instants',
  'Artifacts',
  'Enchantments',
  'Planeswalkers',
  'Battles',
  'Lands',
  'Other',
];

/**
 * Assign a card to a section from its full type line, following the handoff's
 * precedence: Creature beats everything (so "Artifact Creature" and
 * "Enchantment Creature" are Creatures); Land beats the remaining non-creature
 * types; then Planeswalker, Battle, Instant, Sorcery, Artifact, Enchantment.
 *
 * Scryfall type lines are Title Case, so matching is case-sensitive on purpose
 * to avoid false hits on lowercase words inside names.
 */
export function categoriseCard(typeLine: string): Section {
  if (typeLine.includes('Creature')) return 'Creatures';
  if (typeLine.includes('Land')) return 'Lands';
  if (typeLine.includes('Planeswalker')) return 'Planeswalkers';
  if (typeLine.includes('Battle')) return 'Battles';
  if (typeLine.includes('Instant')) return 'Instants';
  if (typeLine.includes('Sorcery')) return 'Sorceries';
  if (typeLine.includes('Artifact')) return 'Artifacts';
  if (typeLine.includes('Enchantment')) return 'Enchantments';
  return 'Other';
}

export function categorise(
  items: CategorizedCard[],
  commander: Card[] = [],
  unresolved: string[] = [],
): CategorizedDeck {
  const buckets = new Map<Section, CategorizedCard[]>();
  for (const s of SECTION_ORDER) buckets.set(s, []);

  for (const item of items) {
    const section = categoriseCard(item.card.typeLine);
    buckets.get(section)!.push(item);
  }

  const sections: DeckSection[] = [];
  for (const section of SECTION_ORDER) {
    const cards = buckets.get(section)!;
    if (cards.length === 0) continue;
    cards.sort((a, b) => a.card.name.localeCompare(b.card.name));
    sections.push({ section, count: sumQty(cards), cards });
  }

  const nonCommanderTotal = sumQty(items);
  const landSection = sections.find((s) => s.section === 'Lands');

  const priceTotalUsd = round2(
    items.reduce((sum, c) => sum + (c.card.priceUsd ?? 0) * c.qty, 0) +
      commander.reduce((sum, c) => sum + (c.priceUsd ?? 0), 0),
  );

  return {
    commander,
    sections,
    nonCommanderTotal,
    grandTotal: nonCommanderTotal + commander.length,
    landCount: landSection?.count ?? 0,
    priceTotalUsd,
    unresolved,
  };
}

function sumQty(cards: CategorizedCard[]): number {
  return cards.reduce((sum, c) => sum + c.qty, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
