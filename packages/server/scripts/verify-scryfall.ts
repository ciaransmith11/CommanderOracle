/**
 * Manual verification that the Scryfall path returns LIVE data (not recall).
 * Run with: pnpm --filter @commander-oracle/server verify:scryfall
 *
 * Not part of the unit suite — it makes real network calls. It parses a small
 * decklist, resolves it through Scryfall, categorises deterministically, and
 * prints verifiable facts (CMC, type line, price) for spot-checking.
 */
import { categorise, parseDecklist } from '@commander-oracle/core';
import { fetchCollection, resolveEntries } from '../src/scryfall.js';

const SAMPLE = `Commander
1 Krenko, Mob Boss (2X2) 145

Deck
1 Sol Ring (C21) 263
1 Goblin Chieftain
1 Skirk Prospector
1 Purphoros, God of the Forge
1 Goblin Recruiter
6 Mountain
`;

async function main(): Promise<void> {
  const { entries, commanders } = parseDecklist(SAMPLE);
  console.log(`Parsed ${entries.length} entries, commander(s): ${commanders.join(', ') || '(none)'}`);

  const [{ items, unresolved }, commanderResult] = await Promise.all([
    resolveEntries(entries),
    commanders.length ? fetchCollection(commanders) : Promise.resolve({ cards: [], notFound: [] }),
  ]);

  const deck = categorise(items, commanderResult.cards, [...unresolved, ...commanderResult.notFound]);

  console.log('\n=== Categorised echo ===');
  if (deck.commander.length) {
    console.log(`Commander (${deck.commander.length})`);
    for (const c of deck.commander) console.log(`  ${c.name} — ${c.typeLine} — CMC ${c.cmc}`);
  }
  for (const section of deck.sections) {
    console.log(`${section.section} (${section.count})`);
    for (const { qty, card } of section.cards) {
      const price = card.priceUsd != null ? `$${card.priceUsd.toFixed(2)}` : 'n/a';
      console.log(`  ${qty}x ${card.name} — ${card.typeLine} — CMC ${card.cmc} — ${price}`);
    }
  }
  console.log(`\nNon-commander total: ${deck.nonCommanderTotal}`);
  console.log(`Grand total: ${deck.grandTotal}`);
  console.log(`Lands: ${deck.landCount}`);
  console.log(`Deck price (USD): $${deck.priceTotalUsd.toFixed(2)}`);
  if (deck.unresolved.length) console.log(`Unresolved: ${deck.unresolved.join(', ')}`);

  // Spot-check live facts that recall historically got wrong.
  const krenko = deck.commander.find((c) => c.name.startsWith('Krenko'));
  console.log('\n=== Live-data spot checks ===');
  console.log(`Krenko type line: ${krenko?.typeLine}`);
  console.log(`Krenko oracle text present: ${Boolean(krenko?.oracleText)}`);
  const solRing = deck.sections.flatMap((s) => s.cards).find((c) => c.card.name === 'Sol Ring');
  console.log(`Sol Ring categorised under: ${deck.sections.find((s) => s.cards.includes(solRing!))?.section}`);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
