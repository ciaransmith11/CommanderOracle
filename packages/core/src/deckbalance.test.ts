import { describe, expect, it } from 'vitest';
import { balanceResolvedDeck, type ResolvedDeckEntry } from './deckbalance.js';

const sum = (es: { qty: number }[]) => es.reduce((n, e) => n + e.qty, 0);

/** Helper: N distinct non-land cards, one copy each. */
function spells(n: number): ResolvedDeckEntry[] {
  return Array.from({ length: n }, (_, i) => ({ name: `Spell ${i + 1}`, qty: 1, isLand: false }));
}

describe('balanceResolvedDeck', () => {
  it('fills basics to 99 when the non-land count is healthy (lands land in band)', () => {
    // 61 non-land + 8 nonbasic lands → needs 30 basics → 38 lands, 99 total.
    const r = balanceResolvedDeck(
      [...spells(61), { name: 'Command Tower', qty: 8, isLand: true }],
      ['R'],
    );
    expect(r.total).toBe(99);
    expect(r.nonlandCount).toBe(61);
    expect(r.landCount).toBe(38);
    expect(r.entries.find((e) => e.name === 'Mountain')?.qty).toBe(30);
    expect(r.reconciled).toBe(true);
    expect(r.overBy).toBe(0);
    expect(r.shortBy).toBe(0);
  });

  it('discards the model’s basic guess and recomputes it', () => {
    // Model listed 61 spells + 50 Mountains (=111); basics are recomputed, not trimmed piecemeal.
    const r = balanceResolvedDeck(
      [...spells(61), { name: 'Mountain', qty: 50, isLand: true }],
      ['R'],
    );
    expect(r.total).toBe(99);
    expect(r.landCount).toBe(38);
    expect(r.entries.find((e) => e.name === 'Mountain')?.qty).toBe(38);
    expect(r.reconciled).toBe(true);
  });

  it('does NOT bloat lands when too few non-land cards — caps at the sweet spot and flags a shortfall', () => {
    // Only 50 non-land + 8 nonbasic lands. Naive padding would make 41 lands; instead cap at 38.
    const r = balanceResolvedDeck(
      [...spells(50), { name: 'Command Tower', qty: 8, isLand: true }],
      ['G'],
    );
    expect(r.landCount).toBe(38); // capped, not 49
    expect(r.total).toBe(88); // left short on purpose
    expect(r.nonlandCount).toBe(50);
    expect(r.shortBy).toBe(9); // 59 − 50
    expect(r.overBy).toBe(0);
    expect(r.reconciled).toBe(false);
  });

  it('flags an over-list WITHOUT cutting the lands (holds them at the sweet spot)', () => {
    const r = balanceResolvedDeck(
      [...spells(70), { name: 'Command Tower', qty: 8, isLand: true }],
      ['R'],
    );
    expect(r.nonlandCount).toBe(70);
    expect(r.landCount).toBe(38); // NOT squeezed to 99 − 70 = 29
    expect(r.overBy).toBe(8); // 70 − 62
    expect(r.shortBy).toBe(0);
    expect(r.reconciled).toBe(false);
  });

  it('creates basics from the colour identity when none are present', () => {
    const r = balanceResolvedDeck(spells(61), ['W', 'U']);
    expect(r.total).toBe(99);
    // 38 basics split across the two colours.
    expect(r.entries.find((e) => e.name === 'Plains')?.qty).toBe(19);
    expect(r.entries.find((e) => e.name === 'Island')?.qty).toBe(19);
    expect(r.reconciled).toBe(true);
  });

  it('uses Wastes for a colourless commander with no basics', () => {
    const r = balanceResolvedDeck(spells(61), []);
    expect(r.entries.find((e) => e.name === 'Wastes')?.qty).toBe(38);
    expect(r.total).toBe(99);
  });

  it('merges duplicate entries before counting', () => {
    const r = balanceResolvedDeck(
      [
        { name: 'Sol Ring', qty: 1, isLand: false },
        { name: 'Sol Ring', qty: 1, isLand: false },
        ...spells(59),
      ],
      ['R'],
    );
    expect(r.entries.find((e) => e.name === 'Sol Ring')?.qty).toBe(2);
    expect(r.nonlandCount).toBe(61);
    expect(sum(r.entries)).toBe(99);
  });
});
