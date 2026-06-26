import { describe, expect, it } from 'vitest';
import { balanceBasicsToTarget } from './deckbalance.js';

const sum = (es: { qty: number }[]) => es.reduce((n, e) => n + e.qty, 0);

describe('balanceBasicsToTarget', () => {
  it('leaves an already-correct deck unchanged', () => {
    const r = balanceBasicsToTarget([{ qty: 1, name: 'Sol Ring' }, { qty: 98, name: 'Mountain' }], 99, ['R']);
    expect(r.total).toBe(99);
    expect(r.adjustment).toBe(0);
    expect(r.reconciled).toBe(true);
  });

  it('trims basic lands when over target (104 -> 99)', () => {
    const r = balanceBasicsToTarget(
      [{ qty: 64, name: 'Sol Ring' }, { qty: 40, name: 'Mountain' }],
      99,
      ['R'],
    );
    expect(r.total).toBe(99);
    expect(r.adjustment).toBe(-5);
    expect(r.entries.find((e) => e.name === 'Mountain')?.qty).toBe(35);
    expect(r.reconciled).toBe(true);
  });

  it('adds basic lands when under target (94 -> 99) to existing basics', () => {
    const r = balanceBasicsToTarget(
      [{ qty: 60, name: 'Sol Ring' }, { qty: 34, name: 'Forest' }],
      99,
      ['G'],
    );
    expect(r.total).toBe(99);
    expect(r.adjustment).toBe(5);
    expect(r.entries.find((e) => e.name === 'Forest')?.qty).toBe(39);
    expect(r.reconciled).toBe(true);
  });

  it('creates basics from the colour identity when none are present', () => {
    const r = balanceBasicsToTarget([{ qty: 95, name: 'Some Spell' }], 99, ['W', 'U']);
    expect(r.total).toBe(99);
    expect(r.adjustment).toBe(4);
    // distributes across the two colours
    expect(r.entries.find((e) => e.name === 'Plains')?.qty).toBe(2);
    expect(r.entries.find((e) => e.name === 'Island')?.qty).toBe(2);
  });

  it('uses Wastes for a colourless commander with no basics', () => {
    const r = balanceBasicsToTarget([{ qty: 96, name: 'Some Artifact' }], 99, []);
    expect(r.total).toBe(99);
    expect(r.entries.find((e) => e.name === 'Wastes')?.qty).toBe(3);
  });

  it('distributes spread across multiple existing basics (round-robin)', () => {
    const r = balanceBasicsToTarget(
      [{ qty: 95, name: 'X' }, { qty: 1, name: 'Mountain' }, { qty: 1, name: 'Forest' }],
      99,
      ['R', 'G'],
    );
    expect(r.total).toBe(99);
    // 2 more cards split across Mountain/Forest
    expect((r.entries.find((e) => e.name === 'Mountain')?.qty ?? 0) + (r.entries.find((e) => e.name === 'Forest')?.qty ?? 0)).toBe(4);
  });

  it('merges duplicate entries before counting', () => {
    const r = balanceBasicsToTarget([{ qty: 50, name: 'Mountain' }, { qty: 49, name: 'Mountain' }], 99, ['R']);
    expect(r.entries).toHaveLength(1);
    expect(r.total).toBe(99);
    expect(r.adjustment).toBe(0);
  });

  it('flags reconciled=false when basics cannot absorb the overage', () => {
    const r = balanceBasicsToTarget([{ qty: 110, name: 'Some Spell' }, { qty: 2, name: 'Mountain' }], 99, ['R']);
    // only 2 basics to remove; 112 -> 110, still over
    expect(r.reconciled).toBe(false);
    expect(sum(r.entries)).toBe(110);
  });
});
