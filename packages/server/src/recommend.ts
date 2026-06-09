import type { Card } from '@commander-oracle/shared';
import { searchCards } from './scryfall.js';
import { callModelJSON, streamModel } from './anthropic.js';
import { querySystemBlocks, recommendSystemBlocks } from './prompt.js';

/**
 * Card recommendations for a strategy/keyword. The model never sources cards
 * from memory: it writes Scryfall queries (judgment about which mechanics
 * matter), the server runs them against live Scryfall (the real candidates),
 * and the model then curates only those real results.
 */

const MAX_QUERIES = 4;
const PER_QUERY_LIMIT = 25;
const MAX_CANDIDATES = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the model for Scryfall query fragments (mechanics only). */
export async function generateQueries(strategy: string, commanderName?: string): Promise<string[]> {
  const data = await callModelJSON({
    systemBlocks: querySystemBlocks(),
    userContent: [
      `Strategy / keyword: ${strategy}`,
      commanderName ? `Commander (thematic context): ${commanderName}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const queries = (data as { queries?: unknown })?.queries;
  if (!Array.isArray(queries)) return [];
  return queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, MAX_QUERIES);
}

/**
 * Run the query fragments against Scryfall, enforcing commander legality, the
 * commander's colour identity, and no basics — in code, not via the model.
 * Dedupes by name and caps the pool.
 */
export async function gatherCandidates(
  queryFragments: string[],
  colorIdentity?: string[],
): Promise<{ candidates: Card[]; queries: string[] }> {
  const seen = new Set<string>();
  const candidates: Card[] = [];
  const queries: string[] = [];

  for (let i = 0; i < queryFragments.length; i++) {
    if (i > 0) await sleep(100); // be kind to Scryfall

    const ci = colorIdentity && colorIdentity.length ? ` id<=${colorIdentity.join('').toLowerCase()}` : '';
    const fullQuery = `(${queryFragments[i]}) legal:commander -type:basic${ci}`;
    queries.push(fullQuery);

    const cards = await searchCards(fullQuery, PER_QUERY_LIMIT);
    for (const card of cards) {
      const key = card.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(card);
      }
    }
  }

  return { candidates: candidates.slice(0, MAX_CANDIDATES), queries };
}

function candidateLine(card: Card): string {
  const ci = card.colorIdentity.length ? card.colorIdentity.join('') : 'C';
  const rank = card.edhrecRank != null ? `#${card.edhrecRank}` : 'unranked';
  const price = card.priceUsd != null ? `$${card.priceUsd.toFixed(2)}` : 'n/a';
  const oracle = card.oracleText.replace(/\s*\n+\s*/g, ' ').trim();
  return `${card.name} | [${card.typeLine}] | MV ${card.cmc} | CI:${ci} | EDHREC:${rank} | ${price} :: ${oracle}`;
}

/** Stream curated recommendations over the real candidate pool. */
export function recommendStream(opts: {
  strategy: string;
  commander?: Card;
  candidates: Card[];
}): AsyncGenerator<string> {
  const header = [
    `Strategy / keyword: ${opts.strategy}`,
    opts.commander
      ? `Commander: ${opts.commander.name} (colour identity ${opts.commander.colorIdentity.join('') || 'C'})`
      : 'No commander specified.',
    '',
    `# CANDIDATE CARDS (${opts.candidates.length} real Scryfall results — recommend ONLY from these)`,
  ].join('\n');

  const pool = opts.candidates.map(candidateLine).join('\n');

  return streamModel({
    systemBlocks: recommendSystemBlocks(),
    messages: [{ role: 'user', content: `${header}\n${pool}` }],
  });
}
