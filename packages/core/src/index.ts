/**
 * @commander-oracle/core — the deterministic layer.
 *
 * Pure functions only: parse a decklist, categorise by type, count by summing
 * quantities, total price. This package depends on `@commander-oracle/shared`
 * and NOTHING else — it cannot import the Scryfall client or the model SDK, so
 * the model can never be handed un-verified, un-counted data.
 */

export { parseDecklist } from './decklist.js';
export { categorise, categoriseCard } from './categorise.js';
export { BASIC_LANDS, isBasicLand, basicLandCard } from './basics.js';
export { balanceBasicsToTarget, type BalanceResult } from './deckbalance.js';
export { SLOT_BASELINES, DESIGN_PHILOSOPHY, type SlotBaseline } from './doctrine.js';
