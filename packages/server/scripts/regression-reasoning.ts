/**
 * Reasoning regression harness.
 *
 * Replays known card-evaluation cases (deck + commander + question) through the
 * REAL model path (Scryfall echo -> chatDeck) and asserts the response gets the
 * sequence-of-play / categorisation right. Run after any prompt change:
 *
 *   pnpm --filter @commander-oracle/server verify:reasoning
 *
 * Not a unit test — it makes live model + Scryfall calls and needs ANTHROPIC_API_KEY.
 * Model output is probabilistic, so checks are deliberately tolerant (keyword /
 * phrase based): they guard against the SPECIFIC mistakes we've seen, not exact
 * wording. An occasional flake is expected; a consistent fail is a regression.
 */
import { categorise, parseDecklist } from '@commander-oracle/core';
import { fetchCollection, resolveEntries } from '../src/scryfall.js';
import { chatDeck } from '../src/analyse.js';
import { hasApiKey } from '../src/env.js';

interface Check {
  label: string;
  /** Receives the response, lowercased with curly apostrophes normalised. */
  pass: (text: string) => boolean;
}

interface Case {
  name: string;
  commander: string;
  cards: string;
  question: string;
  checks: Check[];
}

const has = (t: string, ...subs: string[]) => subs.some((s) => t.includes(s));
const hasAll = (t: string, ...subs: string[]) => subs.every((s) => t.includes(s));

const CASES: Case[] = [
  {
    name: 'Rot-Curse Rakshasa — decayed negated by Jon’s gift',
    commander: 'Jon Irenicus, Shattered One',
    cards: '1 Rot-Curse Rakshasa\n40 Swamp\n58 Island',
    question:
      'Is Rot-Curse Rakshasa good in this deck? Trace the interaction with the commander step by step.',
    checks: [
      {
        label: "recognises 'can't be sacrificed' makes decayed dead text",
        pass: (t) => hasAll(t, 'decay') && has(t, "can't be sacrificed", 'cannot be sacrificed'),
      },
      {
        label: 'does NOT dismiss it as low synergy',
        pass: (t) => !has(t, 'low synergy', 'weak synergy', 'poor synergy'),
      },
    ],
  },
  {
    name: 'Rot-Curse Rakshasa — Renew counts as Mass Disruption',
    commander: 'Jon Irenicus, Shattered One',
    cards: '1 Rot-Curse Rakshasa\n40 Swamp\n58 Island',
    question:
      'What slot-audit roles does Rot-Curse Rakshasa fill, including its Renew ability? Be brief.',
    checks: [
      {
        label: 'flags Renew (decayed counters on X creatures) as Mass Disruption',
        pass: (t) => hasAll(t, 'mass disruption') && has(t, 'renew', 'decayed counter'),
      },
    ],
  },
  {
    name: 'Rotting Regisaur — upkeep discard avoided by cast-and-donate same turn',
    commander: 'Jon Irenicus, Shattered One',
    cards: '1 Rotting Regisaur\n40 Swamp\n58 Island',
    question:
      "Does Rotting Regisaur's upkeep discard hurt me in this deck? Trace the timing. Be brief.",
    checks: [
      {
        label: 'uses turn structure (upkeep already passed / cast and donate same turn)',
        pass: (t) =>
          has(t, 'upkeep') && has(t, 'already passed', 'same turn', 'end step', 'main phase'),
      },
      {
        label: 'concludes the discard does NOT hit you',
        pass: (t) =>
          !has(t, 'hits you first', 'hurts you', 'you discard each') &&
          has(t, 'not you', 'never', 'only its new controller', "doesn't hurt", 'does not hurt'),
      },
    ],
  },
];

async function buildDeck(commander: string, cards: string) {
  const { entries } = parseDecklist(cards);
  const [resolved, cmd] = await Promise.all([resolveEntries(entries), fetchCollection([commander])]);
  return categorise(resolved.items, cmd.cards, [...resolved.unresolved, ...cmd.notFound]);
}

function normalise(text: string): string {
  return text.replace(/[’]/g, "'").toLowerCase();
}

async function runCase(c: Case): Promise<boolean> {
  const deck = await buildDeck(c.commander, c.cards);
  const history = [
    { role: 'assistant' as const, content: '(initial analysis done)' },
    { role: 'user' as const, content: c.question },
  ];
  let full = '';
  for await (const ev of chatDeck(deck, history)) {
    if (typeof ev === 'string') full += ev;
    else if (ev.type === 'text') full += ev.text;
  }
  const text = normalise(full);

  let allPass = true;
  console.log(`\n● ${c.name}`);
  for (const check of c.checks) {
    const ok = check.pass(text);
    allPass = allPass && ok;
    console.log(`    ${ok ? '✓' : '✗'} ${check.label}`);
  }
  if (!allPass) {
    console.log('    --- response ---');
    console.log(
      full
        .split('\n')
        .map((l) => `    | ${l}`)
        .join('\n'),
    );
  }
  return allPass;
}

async function main(): Promise<void> {
  if (!hasApiKey()) {
    console.error('ANTHROPIC_API_KEY not set — cannot run reasoning regression.');
    process.exit(1);
  }
  let failed = 0;
  for (const c of CASES) {
    const ok = await runCase(c).catch((err) => {
      console.error(`    ! error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
    if (!ok) failed++;
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} cases passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
