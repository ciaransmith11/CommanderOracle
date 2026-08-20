import type { Card } from '@commander-oracle/shared';
import { searchCards } from './scryfall.js';
import { callModelJSON, streamModel } from './anthropic.js';
import { querySystemBlocks, recommendSystemBlocks, roleQuerySystemBlocks } from './prompt.js';

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

// --- Role-grouped recommendations (structured, for the dashboard grid) ------

const MAX_ROLES = 6;
const PER_ROLE_LIMIT = 12;

export interface RoleQuery {
  role: string;
  query: string;
}
export interface RoleGroup {
  role: string;
  cards: Card[];
}

/** Ask the model for Scryfall query fragments labelled by deck role. */
export async function generateRoleQueries(strategy: string, commanderName?: string): Promise<RoleQuery[]> {
  const data = await callModelJSON({
    systemBlocks: roleQuerySystemBlocks(),
    userContent: [
      `Strategy / keyword: ${strategy}`,
      commanderName ? `Commander (thematic context): ${commanderName}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const groups = (data as { groups?: unknown })?.groups;
  if (!Array.isArray(groups)) return [];
  return groups
    .filter(
      (g): g is RoleQuery =>
        !!g && typeof (g as RoleQuery).role === 'string' && typeof (g as RoleQuery).query === 'string' && (g as RoleQuery).query.trim().length > 0,
    )
    .slice(0, MAX_ROLES);
}

/**
 * Run each role's query against Scryfall (colour identity + legality + no basics
 * enforced in code) and return real cards grouped by role. A card is shown under
 * only ONE role (the first that surfaces it), so groups don't repeat cards.
 */
export async function gatherRoleGroups(
  roleQueries: RoleQuery[],
  colorIdentity?: string[],
): Promise<RoleGroup[]> {
  const seen = new Set<string>();
  const groups: RoleGroup[] = [];
  const ci = colorIdentity && colorIdentity.length ? ` id<=${colorIdentity.join('').toLowerCase()}` : '';

  for (let i = 0; i < roleQueries.length; i++) {
    if (i > 0) await sleep(100); // be kind to Scryfall
    const { role, query } = roleQueries[i]!;
    const fullQuery = `(${query}) legal:commander -type:basic${ci}`;
    const cards = await searchCards(fullQuery, PER_ROLE_LIMIT + 8);
    const fresh: Card[] = [];
    for (const card of cards) {
      const key = card.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(card);
      if (fresh.length >= PER_ROLE_LIMIT) break;
    }
    if (fresh.length) groups.push({ role, cards: fresh });
  }
  return groups;
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
