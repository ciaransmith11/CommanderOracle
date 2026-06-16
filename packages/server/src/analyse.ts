import type { Card, CategorizedDeck } from '@commander-oracle/shared';
import { SLOT_BASELINES, DESIGN_PHILOSOPHY } from '@commander-oracle/core';
import { callModelJSON, streamModel, streamModelWithTools } from './anthropic.js';
import { strategySystemBlocks, systemBlocks } from './prompt.js';
import { CHAT_TOOLS, makeToolRunner } from './chat-tools.js';

export interface BuildStrategy {
  name: string;
  description: string;
}

/** Propose distinct viable build directions for a commander (for the user to choose from). */
export async function proposeStrategies(commander: Card): Promise<BuildStrategy[]> {
  const data = await callModelJSON({
    systemBlocks: strategySystemBlocks(),
    userContent: `Commander:\n${cardLine(1, commander)}`,
    maxTokens: 1024,
  });
  const strategies = (data as { strategies?: unknown })?.strategies;
  if (!Array.isArray(strategies)) return [];
  return strategies
    .filter(
      (s): s is BuildStrategy =>
        !!s && typeof (s as BuildStrategy).name === 'string' && typeof (s as BuildStrategy).description === 'string',
    )
    .slice(0, 4);
}

/**
 * Orchestrates the model call. Builds a verified, structured deck description as
 * the user turn and streams the strategic analysis back. The model receives
 * already-counted, already-categorised data and is told (by the doctrine) never
 * to recompute it.
 */

function cardLine(qty: number, card: Card): string {
  const ci = card.colorIdentity.length ? card.colorIdentity.join('') : 'C';
  const rank = card.edhrecRank != null ? `#${card.edhrecRank}` : 'unranked';
  const price = card.priceUsd != null ? `$${card.priceUsd.toFixed(2)}` : 'n/a';
  const oracle = card.oracleText.replace(/\s*\n+\s*/g, ' ').trim();
  return [
    `${qty}x ${card.name}`,
    `[${card.typeLine}]`,
    `MV ${card.cmc}`,
    `CI:${ci}`,
    `EDHREC:${rank}`,
    price,
    oracle ? `:: ${oracle}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

/** Render the verified deck as the model's input. Plain, explicit, complete. */
export function renderDeckForModel(deck: CategorizedDeck): string {
  const lines: string[] = [];

  lines.push('# VERIFIED DECK DATA (from live Scryfall — already parsed, counted, categorised)');
  lines.push('Do not recount or re-categorise. Reason only from the oracle text below.\n');

  if (deck.commander.length) {
    lines.push(`## Commander (${deck.commander.length})`);
    for (const c of deck.commander) lines.push(cardLine(1, c));
    lines.push('');
  }

  for (const section of deck.sections) {
    lines.push(`## ${section.section} (${section.count})`);
    for (const { qty, card } of section.cards) lines.push(cardLine(qty, card));
    lines.push('');
  }

  lines.push('## Verified totals');
  lines.push(`Non-commander cards: ${deck.nonCommanderTotal}`);
  lines.push(`Grand total (incl. commander): ${deck.grandTotal}`);
  lines.push(`Lands: ${deck.landCount}`);
  lines.push(`Approx. deck price (USD): $${deck.priceTotalUsd.toFixed(2)}`);
  if (deck.unresolved.length) {
    lines.push(`Unresolved names (could NOT be looked up — flag these to the user): ${deck.unresolved.join(', ')}`);
  }

  lines.push('');
  lines.push('## Slot template baselines for reference (do not treat as rigid targets)');
  lines.push(
    `Lands ${SLOT_BASELINES.lands!.baseline} (${SLOT_BASELINES.lands!.min}–${SLOT_BASELINES.lands!.max}), ` +
      `Ramp ${SLOT_BASELINES.ramp!.baseline}, Card Advantage ${SLOT_BASELINES.cardAdvantage!.baseline} (draw + tutors), ` +
      `Targeted Disruption ${SLOT_BASELINES.targetedDisruption!.baseline}, ` +
      `Mass Disruption ${SLOT_BASELINES.massDisruption!.baseline}, Plan Cards ${SLOT_BASELINES.plan!.baseline}+.`,
  );
  lines.push(`Overlaps encouraged: ${DESIGN_PHILOSOPHY.overlapsEncouraged}`);
  lines.push(`Curve: ${DESIGN_PHILOSOPHY.lowerCurve}`);
  lines.push(`Adjustment: ${DESIGN_PHILOSOPHY.dynamicAdjustment}`);

  return lines.join('\n');
}

/** Stream a full deck analysis. */
export function analyseDeck(deck: CategorizedDeck): AsyncGenerator<string> {
  const instruction = deck.commander.length
    ? 'Analyse this Commander deck per your doctrine. Begin at the commander overview.'
    : 'Analyse this Commander deck per your doctrine. No commander was detected — note that and infer the most likely commander from the cards if possible, then proceed.';

  return streamModel({
    systemBlocks: systemBlocks(),
    messages: [
      {
        role: 'user',
        content: `${instruction}\n\n${renderDeckForModel(deck)}`,
      },
    ],
  });
}

/**
 * Continue the conversation after the initial analysis. The verified deck is
 * re-supplied as context, and the model is now permitted to go deeper (cuts,
 * additions, imbalances, curve) in response to the user's questions.
 */
export function chatDeck(
  deck: CategorizedDeck,
  history: { role: 'user' | 'assistant'; content: string }[],
): AsyncGenerator<string> {
  const context =
    `${renderDeckForModel(deck)}\n\n` +
    '(You have already given the user the initial three-section analysis. Answer their follow-up ' +
    'questions about THIS deck using the verified data above. You may now provide deeper detail on ' +
    'request — imbalances, mana-curve breakdowns, specific cuts, or additions.\n\n' +
    'TOOLS: You have `search_cards` (find real Commander-legal cards by mechanic — the colour ' +
    'identity and legality are applied for you) and `get_card` (verify one card\'s exact text). You ' +
    'MUST use them to ground card recommendations in real Scryfall data — NEVER suggest a card to ' +
    'add, or describe a card\'s text, from memory. Before recommending additions, search for cards ' +
    'that fill the UNDER-filled roles within the strategy, then recommend the best real matches. Do ' +
    'NOT narrate or announce your searches; call the tools silently and answer directly.\n\n' +
    'When recommending CUTS or ADDITIONS you MUST:\n' +
    "1. Ground every suggestion in this commander's strategy AND in the slot-audit counts from your initial analysis — restate the relevant count (e.g. \"Targeted Disruption is already 14/12\") before suggesting a change there.\n" +
    '2. NEVER suggest adding a card to a category that is already at or above its baseline. Direct additions to the UNDER-filled roles only, and source them via search_cards.\n' +
    '3. NEVER cut a card that is core to the strategy or a key synergy/win-condition piece. Cut over-represented, off-strategy, redundant, or low-impact cards instead — and say which.\n' +
    '4. For each cut and each addition, name the slot count it addresses and the part of the strategy it serves.\n\n' +
    'Stay grounded in real card data; never invent card text.)';

  return streamModelWithTools({
    systemBlocks: systemBlocks(),
    messages: [{ role: 'user', content: context }, ...history],
    tools: CHAT_TOOLS,
    runTool: makeToolRunner(deck.commander[0]?.colorIdentity ?? []),
  });
}

/** Stream build-mode advice for a commander and/or a described strategy. */
export function buildAdvice(opts: { commander?: Card; strategy?: string }): AsyncGenerator<string> {
  const parts: string[] = ['Help the player build a Commander deck, per your doctrine.'];

  if (opts.commander) {
    parts.push('\n# VERIFIED COMMANDER DATA (from live Scryfall)');
    parts.push(cardLine(1, opts.commander));
  }
  if (opts.strategy) {
    parts.push(`\n# Player's stated strategy / request\n${opts.strategy}`);
  }
  if (!opts.commander && !opts.strategy) {
    parts.push('\nThe player has not yet named a commander or strategy — ask focused questions to get started.');
  } else {
    parts.push(
      '\nGive targeted recommendations: the gameplan, then key cards grouped by role ' +
        '(Ramp, Card Advantage, Targeted/Mass Disruption, Plan Cards) with a one-line reason each, ' +
        'and what makes this direction distinct from the popular build.',
    );
    parts.push(
      '\nTOOLS: use `search_cards` to find REAL Commander-legal cards for each role within this ' +
        "strategy (colour identity is applied automatically), and `get_card` to verify a card's text. " +
        'Recommend ONLY real cards you have looked up — never suggest a card or describe its text from memory. ' +
        'Make a FEW targeted searches (roughly one or two per role), then write your recommendations — do not ' +
        'exhaustively search every phrasing. Do NOT narrate or announce your searches; call the tools silently ' +
        'and output only your final recommendation.',
    );
  }

  return streamModelWithTools({
    systemBlocks: systemBlocks(),
    messages: [{ role: 'user', content: parts.join('\n') }],
    tools: CHAT_TOOLS,
    runTool: makeToolRunner(opts.commander?.colorIdentity ?? []),
  });
}
