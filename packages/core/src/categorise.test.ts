import { describe, expect, it } from 'vitest';
import type { Card, CategorizedCard } from '@commander-oracle/shared';
import { categorise, categoriseCard } from './categorise.js';

/** Minimal Card factory — only the fields categorisation/counting touch. */
function card(name: string, typeLine: string, priceUsd: number | null = null): Card {
  return {
    name,
    typeLine,
    manaCost: null,
    cmc: 0,
    colorIdentity: [],
    oracleText: '',
    legalCommander: true,
    edhrecRank: null,
    priceUsd,
    imageUrl: null,
    scryfallUri: null,
  };
}

function item(qty: number, name: string, typeLine: string, price: number | null = null): CategorizedCard {
  return { qty, card: card(name, typeLine, price) };
}

describe('categoriseCard — type precedence', () => {
  it('treats any Creature as a Creature, even Artifact/Enchantment Creatures', () => {
    expect(categoriseCard('Artifact Creature — Construct')).toBe('Creatures');
    expect(categoriseCard('Enchantment Creature — God')).toBe('Creatures');
    expect(categoriseCard('Legendary Creature — Human Wizard')).toBe('Creatures');
  });

  it('treats a non-creature Land as a Land (Artifact Land included)', () => {
    expect(categoriseCard('Land')).toBe('Lands');
    expect(categoriseCard('Artifact Land')).toBe('Lands');
    expect(categoriseCard('Basic Land — Forest')).toBe('Lands');
  });

  it('orders the remaining types: Planeswalker, Battle, Instant, Sorcery, Artifact, Enchantment', () => {
    expect(categoriseCard('Legendary Planeswalker — Teferi')).toBe('Planeswalkers');
    expect(categoriseCard('Battle — Siege')).toBe('Battles');
    expect(categoriseCard('Instant')).toBe('Instants');
    expect(categoriseCard('Sorcery')).toBe('Sorceries');
    expect(categoriseCard('Artifact — Equipment')).toBe('Artifacts');
    expect(categoriseCard('Enchantment — Aura')).toBe('Enchantments');
  });

  it('falls back to Other for unknown type lines', () => {
    expect(categoriseCard('Dungeon')).toBe('Other');
  });
});

describe('categorise — bucketing, counting, ordering', () => {
  const deck = [
    item(1, 'Llanowar Elves', 'Creature — Elf Druid'),
    item(1, 'Sol Ring', 'Artifact'),
    item(1, 'Cultivate', 'Sorcery'),
    item(1, 'Swords to Plowshares', 'Instant'),
    item(24, 'Forest', 'Basic Land — Forest'),
    item(1, 'Solemn Simulacrum', 'Artifact Creature — Golem'), // creature, not artifact
  ];

  it('sums quantities per section rather than counting list items', () => {
    const result = categorise(deck);
    const lands = result.sections.find((s) => s.section === 'Lands');
    expect(lands?.count).toBe(24);
    expect(lands?.cards).toHaveLength(1);
  });

  it('routes Artifact Creatures to Creatures, not Artifacts', () => {
    const result = categorise(deck);
    const creatures = result.sections.find((s) => s.section === 'Creatures');
    expect(creatures?.cards.map((c) => c.card.name)).toContain('Solemn Simulacrum');
    const artifacts = result.sections.find((s) => s.section === 'Artifacts');
    expect(artifacts?.cards.map((c) => c.card.name)).not.toContain('Solemn Simulacrum');
  });

  it('reports landCount and totals correctly', () => {
    const result = categorise(deck);
    expect(result.landCount).toBe(24);
    expect(result.nonCommanderTotal).toBe(29); // 1+1+1+1+24+1
    expect(result.grandTotal).toBe(29); // no commander supplied
  });

  it('sorts cards alphabetically within a section', () => {
    const result = categorise([
      item(1, 'Birds of Paradise', 'Creature — Bird'),
      item(1, 'Avenger of Zendikar', 'Creature — Plant Elemental'),
      item(1, 'Craterhoof Behemoth', 'Creature — Beast'),
    ]);
    const creatures = result.sections.find((s) => s.section === 'Creatures');
    expect(creatures?.cards.map((c) => c.card.name)).toEqual([
      'Avenger of Zendikar',
      'Birds of Paradise',
      'Craterhoof Behemoth',
    ]);
  });

  it('omits empty sections', () => {
    const result = categorise([item(1, 'Sol Ring', 'Artifact')]);
    expect(result.sections.map((s) => s.section)).toEqual(['Artifacts']);
  });
});

describe('categorise — commander and price totals', () => {
  it('adds the commander to grandTotal but not the type sections or nonCommanderTotal', () => {
    const result = categorise([item(1, 'Mountain', 'Basic Land — Mountain')], [card('Krenko, Mob Boss', 'Legendary Creature — Goblin')]);
    expect(result.commander.map((c) => c.name)).toEqual(['Krenko, Mob Boss']);
    expect(result.nonCommanderTotal).toBe(1);
    expect(result.grandTotal).toBe(2);
    expect(result.sections.find((s) => s.section === 'Creatures')).toBeUndefined();
  });

  it('totals price as priceUsd * qty across cards and commander', () => {
    const result = categorise(
      [item(24, 'Forest', 'Basic Land — Forest', 0.1), item(1, 'Sol Ring', 'Artifact', 1.5)],
      [card('Krenko, Mob Boss', 'Legendary Creature — Goblin', 2.0)],
    );
    // 24*0.10 + 1*1.50 + 2.00 = 2.4 + 1.5 + 2.0 = 5.9
    expect(result.priceTotalUsd).toBe(5.9);
  });

  it('treats null prices as zero', () => {
    const result = categorise([item(1, 'Sol Ring', 'Artifact', null)]);
    expect(result.priceTotalUsd).toBe(0);
  });

  it('passes through unresolved names', () => {
    const result = categorise([], [], ['Definitely Not A Real Card']);
    expect(result.unresolved).toEqual(['Definitely Not A Real Card']);
  });
});
