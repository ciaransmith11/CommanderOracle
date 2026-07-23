import type Anthropic from '@anthropic-ai/sdk';
import type { Card } from '@commander-oracle/shared';
import { namedCard, searchCards } from './scryfall.js';

/**
 * Tools the follow-up chat can call so card ADDITIONS are grounded in real
 * Scryfall data instead of model recall. `search_cards` discovers candidates by
 * mechanic (colour identity + legality enforced in code); `get_card` verifies a
 * specific card's exact text before the model recommends or discusses it.
 */
export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_cards',
    description:
      'Search Scryfall for REAL Commander-legal cards matching a mechanic or theme. Use this to find ADDITIONS — never suggest a card to add from memory. The commander\'s colour identity, Commander legality, and basic-land exclusion are applied automatically; you only supply the mechanic.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A Scryfall query fragment for CARD MECHANICS ONLY — e.g. o:"create a Treasure", (t:artifact o:sacrifice), keyword:lifelink, o:"search your library for". Do NOT include colour (id:/c:) or legality (legal:) filters; they are added for you.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_card',
    description:
      "Look up ONE real card by name on Scryfall to confirm it exists and read its exact oracle text, type line, mana value, and colour identity before recommending or describing it.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact or approximate card name.' },
      },
      required: ['name'],
    },
  },
];

/** How a build should be constrained to a set. `set` is the code used to filter; `setName` is for display. */
export interface SetConstraint {
  set: string;
  setName?: string;
  mode: 'only' | 'mostly';
}

function cardLine(card: Card): string {
  const ci = card.colorIdentity.length ? card.colorIdentity.join('') : 'C';
  const rank = card.edhrecRank != null ? `#${card.edhrecRank}` : 'unranked';
  const price = card.priceUsd != null ? `$${card.priceUsd.toFixed(2)}` : 'n/a';
  const setTag = card.set ? ` | SET:${card.set}` : '';
  const oracle = card.oracleText.replace(/\s*\n+\s*/g, ' ').trim();
  return `${card.name} | [${card.typeLine}] | MV ${card.cmc} | CI:${ci} | EDHREC:${rank} | ${price}${setTag} :: ${oracle}`;
}

/**
 * Build the tool executor bound to a colour identity — search results are
 * constrained to it so suggested cards are always Commander-legal for the deck.
 */
export function makeToolRunner(
  colorIdentity: string[],
  constraint?: SetConstraint,
): (name: string, input: unknown) => Promise<string> {
  const colors = colorIdentity;

  return async (name, input) => {
    const args = (input ?? {}) as { query?: string; name?: string };
    console.log(`[chat tool] ${name}(${JSON.stringify(args)})`);

    if (name === 'search_cards') {
      const fragment = (args.query ?? '').trim();
      if (!fragment) return 'Provide a non-empty query fragment.';
      const ci = colors.length ? ` id<=${colors.join('').toLowerCase()}` : '';
      // "only" hard-limits results to the set; "mostly" leaves search broad and
      // lets the prompt steer preference (each result line shows its SET).
      const setFilter = constraint?.mode === 'only' ? ` set:${constraint.set.toLowerCase()}` : '';
      const query = `(${fragment}) legal:commander -type:basic${ci}${setFilter}`;
      const cards = await searchCards(query, 20);
      if (!cards.length) return `No Commander-legal cards matched: ${query}`;
      return `Real Scryfall matches for ${query} (recommend only from these):\n${cards.map(cardLine).join('\n')}`;
    }

    if (name === 'get_card') {
      const card = await namedCard((args.name ?? '').trim());
      return card ? cardLine(card) : `No card found named "${args.name ?? ''}".`;
    }

    return `Unknown tool: ${name}`;
  };
}
