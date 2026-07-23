import type Anthropic from '@anthropic-ai/sdk';
import type { Card, CategorizedDeck } from '@commander-oracle/shared';
import { SLOT_BASELINES, DESIGN_PHILOSOPHY, parseDecklist } from '@commander-oracle/core';
import { callModelJSON, streamModel, streamModelWithTools, type ModelEvent } from './anthropic.js';
import { strategySystemBlocks, systemBlocks } from './prompt.js';
import { CHAT_TOOLS, makeToolRunner, type SetConstraint } from './chat-tools.js';
import { resolveEntries } from './scryfall.js';

export interface BuildStrategy {
  name: string;
  description: string;
}

// A balanced deck is 99 non-commander cards = 59–62 non-land + 37–40 lands.
const BUILD_NONLAND_MIN = 59;
const BUILD_NONLAND_MAX = 62;
const BUILD_NONLAND_TARGET = 61; // → 38 lands, the sweet spot
const HAS_DECKLIST = (t: string) => (t.match(/```/g)?.length ?? 0) >= 2;

/** Pull the LAST ```decklist block (or "qty name" block) — the corrected one wins if there are several. */
function extractDeckBlock(md: string): string | null {
  const fences = [...md.matchAll(/```([a-zA-Z]*)\s*\n([\s\S]*?)```/g)];
  const labeled = fences.filter((f) => /deck/i.test(f[1] ?? ''));
  const lists = fences.filter((f) => /^\s*\d+\s+\S/m.test(f[2] ?? ''));
  return (labeled.at(-1) ?? lists.at(-1))?.[2] ?? null;
}

/** Count NON-LAND cards in a build's decklist block using real Scryfall types; null if no block. */
async function countNonlandCards(text: string): Promise<number | null> {
  const block = extractDeckBlock(text);
  if (!block) return null;
  const parsed = parseDecklist(block);
  if (parsed.entries.length === 0) return null;
  const { items, unresolved } = await resolveEntries(parsed.entries);
  let nonland = 0;
  for (const { qty, card } of items) if (!/\bLand\b/.test(card.typeLine)) nonland += qty;
  const qtyByName = new Map(parsed.entries.map((e) => [e.name.toLowerCase(), e.qty]));
  for (const name of unresolved) nonland += qtyByName.get(name.toLowerCase()) ?? 1; // unresolved = non-land slot
  return nonland;
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

function cardLine(qty: number, card: Card, set?: string): string {
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
    // The set the user explicitly listed this card from, so the model can act on
    // "cut cards from <set>" style requests.
    set ? `SET:${set}` : '',
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
    for (const { qty, card, requestedSet } of section.cards) lines.push(cardLine(qty, card, requestedSet));
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
): AsyncGenerator<ModelEvent> {
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

/**
 * Conversational build mode: produces the initial build around a chosen
 * strategy and then answers follow-up questions, all grounded in live Scryfall
 * via tools. `history` is the conversation after the build context (empty for
 * the very first build).
 */
export async function* buildChat(
  commander: Card,
  strategy: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  setConstraint?: SetConstraint,
): AsyncGenerator<ModelEvent> {
  const setInstruction =
    setConstraint?.mode === 'only'
      ? `\nSET CONSTRAINT — HARD: Build this deck using ONLY cards from the set "${setConstraint.set}" (plus basic lands, which are exempt). Your search_cards results are already limited to that set — build from what they return. A few targeted searches per role is plenty; do NOT search exhaustively. If "${setConstraint.set}" simply can't fill a role, note it briefly and move on — still deliver a complete list.`
      : setConstraint?.mode === 'mostly'
        ? `\nSET PREFERENCE: Lean toward cards from the set "${setConstraint.set}" — a rough majority from it is the goal. But you have a FULL card pool: freely use strong cards from ANY set where they serve the strategy. Each search result shows its SET; prefer "${setConstraint.set}" when comparable, but do NOT exhaustively hunt for its cards — a few searches per role, then build.`
        : '';
  const context = [
    'Help the player build a Commander deck around the chosen strategy, per your doctrine.',
    '\n# VERIFIED COMMANDER DATA (from live Scryfall)',
    cardLine(1, commander),
    `\n# Chosen strategy\n${strategy}`,
    setInstruction,
    '\nGive the build as sections by role, in this order: Lands, Ramp, Card Advantage, Targeted Disruption, Mass Disruption, Plan Cards.',
    'ALWAYS INCLUDE A LANDS SECTION, and keep its arithmetic INTERNALLY CONSISTENT. State the TOTAL land count T (around the 38 baseline, adjusted for the curve). Name the key nonbasic / utility lands (find them with search_cards using t:land); let N be how many nonbasics you list. The basic lands then number EXACTLY T − N, and your per-colour basic split MUST sum to T − N — NOT to T. Do the subtraction explicitly and show it, e.g. "37 lands = 15 nonbasics + 22 basics (12 Mountain, 10 Plains)". The nonbasic count plus every basic quantity MUST add up to exactly T.',
    'Beside EVERY category heading, put the number of cards you recommend for it, e.g. "## Ramp (10)" or "### Lands (38)".',
    'CRITICAL — DECK SIZE: the deck is EXACTLY 100 cards = the commander + EXACTLY 99 DISTINCT other cards. List the 99 in sections where EACH CARD APPEARS EXACTLY ONCE — place every card under its single PRIMARY role so the section counts partition the deck and sum to exactly 99. Many cards fill multiple roles; when one does, NOTE the extra role(s) inline on that card (e.g. "— also card advantage"). Do NOT list a card in a second section, and NEVER count a multi-role card more than once toward the 99. If you also give a role-COVERAGE summary, label it clearly as coverage (it may exceed the slot baselines because of overlaps) — that is NOT the deck size.',
    'BUDGET THE 99 IN THIS ORDER — reason in exactly this sequence so you never overshoot: (1) provisionally set aside ~40 slots for lands; (2) fill the OTHER ~60 slots with a BALANCED, deliberately chosen set of NON-LAND cards — all card selection happens here; (3) ONLY THEN decide the actual land count, which MUST be 37–40 (38 is the sweet spot), and choose the specific lands. Because non-land + lands = exactly 99, a 37–40 land count means 59–62 non-land cards — do NOT exceed 62. Tally it, e.g. "Non-land 61 + lands 38 = 99, + commander = 100."',
    'BALANCE THOSE ~60 NON-LAND SLOTS by role, sized to the ARCHETYPE: a creature-based or tribal deck wants a DEEP creature base (roughly 30–35 creatures); a spell-based/control deck wants fewer creatures and more instants/sorceries. Across the deck aim for ~10 ramp, ~10 card advantage, ~8–10 interaction/removal, and the remaining slots on your strategy\'s core payoffs and synergy pieces. Every non-land card must earn its slot for THIS strategy — do not pad with filler, and do not under-fill the creature base. Choose these ~60 cards deliberately so the list is already balanced and exactly the right size; you should not need anything cut afterward.',
    'Briefly note what makes this direction distinct from the popular build.',
    '\nFINAL OUTPUT — REQUIRED: after the prose, end your message with the COMPLETE decklist in a fenced code block marked ```decklist — one card per line as "<qty> <Card Name>", and NOTHING else inside the block. List every NON-LAND card and every NONBASIC land first, then fill the remaining land slots with basic lands (e.g. "20 Mountain") so the block totals EXACTLY 99 non-commander cards. IMPORTANT — the app will NOT fix your count for you: it will not cut spells if you list too many, and it will NOT pad with extra lands if you list too few (it flags the shortfall instead). So YOU must deliver exactly 99 = 59–62 non-land cards + 37–40 lands. If you are short on non-land cards, keep searching and add more real ones until you hit the count — never backfill the gap with extra basics. Count non-land + nonbasic lands + basics = 99 before you finish. Do not put the commander in the block.',
    '\nTOOLS: use `search_cards` to find REAL Commander-legal cards for each role within this strategy (colour identity is applied automatically), and `get_card` to verify a card\'s text. Recommend ONLY real cards you have looked up — never suggest a card or describe its text from memory. Make a few targeted searches per role, then write the build. Do NOT narrate or announce your searches; call the tools silently and output only the build.',
    '\nAfter the initial build, answer any follow-up questions the player asks, staying grounded in real card data via the tools.',
  ]
    .filter(Boolean)
    .join('\n');

  const sys = systemBlocks();
  const runTool = makeToolRunner(commander.colorIdentity, setConstraint);
  const baseMessages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: context }, ...history];

  // Follow-up conversational turns: stream normally, no decklist required.
  if (history.length > 0) {
    yield* streamModelWithTools({ systemBlocks: sys, messages: baseMessages, tools: CHAT_TOOLS, runTool, maxTurns: 5 });
    return;
  }

  // Initial build. finalGuard requires a decklist block so the model can't end on
  // a "let me gather more" preamble. Stream it live and capture the text.
  let buildText = '';
  for await (const ev of streamModelWithTools({
    systemBlocks: sys,
    messages: baseMessages,
    tools: CHAT_TOOLS,
    runTool,
    maxTurns: 12, // room for gather rounds + "keep gathering" nudges, esp. under a set constraint
    finalGuard: HAS_DECKLIST,
  })) {
    if (ev.type === 'text') buildText += ev.text;
    yield ev;
  }

  // Verify the deck SIZE from real card data, and if it's off, have the MODEL
  // rebalance it thoughtfully (cut the weakest / add to weak roles) rather than
  // the app blind-cutting cards at the end and wrecking the archetype.
  const nonland = await countNonlandCards(buildText);
  if (nonland === null || (nonland >= BUILD_NONLAND_MIN && nonland <= BUILD_NONLAND_MAX)) return;

  const over = nonland - BUILD_NONLAND_TARGET;
  yield {
    type: 'status',
    text: over > 0 ? `Rebalancing — trimming ${over} of the weakest cards…` : `Rebalancing — adding ${-over} more cards…`,
  };

  const instruction =
    over > 0
      ? `That decklist has ${nonland} non-land cards — ${over} too many for a 100-card deck (it needs ${BUILD_NONLAND_TARGET} non-land + 38 lands). ` +
        `Revise to EXACTLY ${BUILD_NONLAND_TARGET} non-land cards by cutting the ${over} WEAKEST or most redundant cards for THIS strategy. ` +
        'Do NOT gut a role — keep the creature base, ramp, card advantage, interaction, and payoffs all healthy; cut low-impact filler, not staples the deck needs. '
      : `That decklist has only ${nonland} non-land cards — add ${-over} more real, on-strategy cards (search for them) in the most under-represented roles, keeping balance. `;

  const correctionMessages: Anthropic.Messages.MessageParam[] = [
    ...baseMessages,
    { role: 'assistant', content: buildText || '(no output)' },
    {
      role: 'user',
      content:
        instruction +
        'Re-output the COMPLETE build ending with the full ```decklist``` code block, and briefly note what you changed and why.',
    },
  ];
  yield* streamModelWithTools({
    systemBlocks: sys,
    messages: correctionMessages,
    tools: CHAT_TOOLS,
    runTool,
    maxTurns: 5,
    finalGuard: HAS_DECKLIST,
  });
}
