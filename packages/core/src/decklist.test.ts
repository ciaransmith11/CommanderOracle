import { describe, expect, it } from 'vitest';
import { parseDecklist } from './decklist.js';

describe('parseDecklist — quantity formats', () => {
  it('parses "1 Name", "1x Name", and bare "Name" as a single copy', () => {
    const { entries } = parseDecklist('1 Sol Ring\n1x Arcane Signet\nMana Crypt');
    expect(entries).toEqual([
      { qty: 1, name: 'Sol Ring' },
      { qty: 1, name: 'Arcane Signet' },
      { qty: 1, name: 'Mana Crypt' },
    ]);
  });

  it('SUMS quantities — "14x Plains" is 14 cards, not 1', () => {
    const { entries } = parseDecklist('14x Plains');
    expect(entries).toEqual([{ qty: 14, name: 'Plains' }]);
  });

  it('merges duplicate lines by summing quantities', () => {
    const { entries } = parseDecklist('10 Forest\n4 Forest');
    expect(entries).toEqual([{ qty: 14, name: 'Forest' }]);
  });
});

describe('parseDecklist — set-code and collector suffixes', () => {
  it('strips "(SET) collector" suffixes', () => {
    const { entries } = parseDecklist('1 Sol Ring (C21) 263');
    expect(entries).toEqual([{ qty: 1, name: 'Sol Ring' }]);
  });

  it('strips a bare "(SET)" suffix', () => {
    const { entries } = parseDecklist('1 Cultivate (M21)');
    expect(entries).toEqual([{ qty: 1, name: 'Cultivate' }]);
  });

  it('strips trailing foil markers, alone or after a collector number', () => {
    const { entries } = parseDecklist('1 Sol Ring (C21) 263 *F*\n1 Mana Crypt *F*');
    expect(entries).toEqual([
      { qty: 1, name: 'Sol Ring' },
      { qty: 1, name: 'Mana Crypt' },
    ]);
  });

  it('does NOT truncate a name whose own parenthetical contains spaces', () => {
    const { entries } = parseDecklist('1 B.F.M. (Big Furry Monster)');
    expect(entries).toEqual([{ qty: 1, name: 'B.F.M. (Big Furry Monster)' }]);
  });
});

describe('parseDecklist — section headers', () => {
  it('skips headers, with or without counts/colons', () => {
    const list = ['Creatures (2)', '1 Llanowar Elves', '1 Birds of Paradise', 'Lands:', '5 Forest'].join(
      '\n',
    );
    const { entries } = parseDecklist(list);
    expect(entries).toEqual([
      { qty: 1, name: 'Llanowar Elves' },
      { qty: 1, name: 'Birds of Paradise' },
      { qty: 5, name: 'Forest' },
    ]);
  });

  it('ignores blank lines and // or # comments', () => {
    const { entries } = parseDecklist('// my deck\n\n1 Sol Ring\n# note\n1 Forest');
    expect(entries).toEqual([
      { qty: 1, name: 'Sol Ring' },
      { qty: 1, name: 'Forest' },
    ]);
  });
});

describe('parseDecklist — commander detection', () => {
  it('detects a commander under a Commander header and keeps it out of entries', () => {
    const list = ['Commander', '1 Atraxa, Praetors’ Voice', '', 'Deck', '1 Sol Ring'].join('\n');
    const { entries, commanders } = parseDecklist(list);
    expect(commanders).toEqual(['Atraxa, Praetors’ Voice']);
    expect(entries).toEqual([{ qty: 1, name: 'Sol Ring' }]);
  });

  it('does NOT truncate a commander name with a comma after the Commander header', () => {
    const list = ['Commander', '1 Jon Irenicus, Shattered One', '', '1 Sol Ring'].join('\n');
    const { commanders } = parseDecklist(list);
    expect(commanders).toEqual(['Jon Irenicus, Shattered One']);
  });

  it('strips set code from a commander line under the header', () => {
    const list = ['Commander', '1 Krenko, Mob Boss (2X2) 145', '', '1 Mountain'].join('\n');
    const { commanders, entries } = parseDecklist(list);
    expect(commanders).toEqual(['Krenko, Mob Boss']);
    expect(entries).toEqual([{ qty: 1, name: 'Mountain' }]);
  });

  it('detects inline *CMDR*, (Commander) and [Commander] tags and cleans the name', () => {
    const list = [
      '1 Atraxa, Praetors’ Voice *CMDR*',
      '1 Edgar Markov (Commander)',
      '1 Yuriko [Commander]',
      '1 Sol Ring',
    ].join('\n');
    const { commanders, entries } = parseDecklist(list);
    expect(commanders).toEqual(['Atraxa, Praetors’ Voice', 'Edgar Markov', 'Yuriko']);
    expect(entries).toEqual([{ qty: 1, name: 'Sol Ring' }]);
  });

  it('captures two partner commanders listed consecutively under the header', () => {
    const list = ['Commander', '1 Tana, the Bloodsower', '1 Tymna the Weaver', '', 'Deck', '1 Sol Ring'].join(
      '\n',
    );
    const { commanders } = parseDecklist(list);
    expect(commanders).toEqual(['Tana, the Bloodsower', 'Tymna the Weaver']);
  });

  it('ends the commander block at a blank line when no Deck header follows', () => {
    const list = ['Commander', '1 Krenko, Mob Boss', '', '1 Mountain', '1 Goblin Recruiter'].join('\n');
    const { commanders, entries } = parseDecklist(list);
    expect(commanders).toEqual(['Krenko, Mob Boss']);
    expect(entries).toEqual([
      { qty: 1, name: 'Mountain' },
      { qty: 1, name: 'Goblin Recruiter' },
    ]);
  });
});

describe('parseDecklist — a realistic export', () => {
  it('parses a Moxfield-style list and sums to the expected totals', () => {
    const list = [
      'Commander',
      '1 Krenko, Mob Boss (2X2) 145 *F*',
      '',
      'Deck',
      '1 Sol Ring (C21) 263',
      '1x Goblin Chieftain',
      '1 Skirk Prospector',
      '24 Mountain',
    ].join('\n');
    const { commanders, entries } = parseDecklist(list);
    expect(commanders).toEqual(['Krenko, Mob Boss']);
    const total = entries.reduce((n, e) => n + e.qty, 0);
    expect(total).toBe(27); // 1 + 1 + 1 + 24
    expect(entries.find((e) => e.name === 'Mountain')).toEqual({ qty: 24, name: 'Mountain' });
  });
});
