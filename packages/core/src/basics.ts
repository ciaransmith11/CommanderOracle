import type { Card } from '@commander-oracle/shared';

/**
 * Basic lands can be categorised and counted without a Scryfall fetch — they
 * are matched by exact name. (The server uses this to skip network lookups for
 * them; the core layer uses it for type inference when no card data is present.)
 */
export const BASIC_LANDS: ReadonlySet<string> = new Set([
  'Plains',
  'Island',
  'Swamp',
  'Mountain',
  'Forest',
  'Wastes',
  'Snow-Covered Plains',
  'Snow-Covered Island',
  'Snow-Covered Swamp',
  'Snow-Covered Mountain',
  'Snow-Covered Forest',
  'Snow-Covered Wastes',
]);

export function isBasicLand(name: string): boolean {
  return BASIC_LANDS.has(name);
}

const BASIC_COLOR_IDENTITY: Record<string, string[]> = {
  Plains: ['W'],
  Island: ['U'],
  Swamp: ['B'],
  Mountain: ['R'],
  Forest: ['G'],
  Wastes: [],
};

/**
 * Synthesize a `Card` for a basic land without hitting Scryfall. Deterministic
 * and pure, so it stays in the core layer. Returns null for non-basics.
 *
 * (Basics carry no price or EDHREC rank worth fetching; the only fields that
 * matter downstream are the type line — for categorisation — and the colour
 * identity, both of which are fixed and known.)
 */
export function basicLandCard(name: string): Card | null {
  if (!isBasicLand(name)) return null;

  const snow = name.startsWith('Snow-Covered ');
  const baseName = snow ? name.slice('Snow-Covered '.length) : name;
  const colorIdentity = BASIC_COLOR_IDENTITY[baseName] ?? [];
  const pip = colorIdentity[0];

  // Wastes has no land subtype; the rest do.
  const typeLine =
    baseName === 'Wastes'
      ? `Basic ${snow ? 'Snow ' : ''}Land`
      : `Basic ${snow ? 'Snow ' : ''}Land — ${baseName}`;

  return {
    name,
    typeLine,
    manaCost: null,
    cmc: 0,
    colorIdentity,
    oracleText: pip ? `({T}: Add {${pip}}.)` : '{T}: Add {C}.',
    legalCommander: false,
    edhrecRank: null,
    priceUsd: null,
    imageUrl: null,
    scryfallUri: null,
  };
}
