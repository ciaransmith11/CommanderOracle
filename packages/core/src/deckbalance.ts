import type { CardEntry } from '@commander-oracle/shared';
import { isBasicLand } from './basics.js';

/**
 * Deterministic deck-size enforcement, land-aware. The model can't reliably
 * count its own list, so after it proposes a deck we finalise the size in code.
 *
 * The key fact: a Commander deck is exactly 99 non-commander cards, so
 * `lands = 99 − nonLandCards`. The land count is therefore decided entirely by
 * how many NON-LAND cards the model lists — basics are just the fungible filler.
 * That means:
 *   - If the non-land count is healthy (59–62), we fill basics to 99 and the
 *     land count lands in the 37–40 band automatically.
 *   - If the model listed TOO FEW non-land cards, we do NOT bloat the deck with
 *     lands to reach 99 — we cap lands at the sweet spot and report how many
 *     non-land cards are still needed.
 *   - If it listed TOO MANY, we can't cut spells for it (that's judgment); we
 *     report how many to trim.
 *
 * Pure and unit-tested; no model, no network. Callers supply `isLand` per card
 * (from real Scryfall type lines) — that's what makes this land-aware.
 */

const COLOR_TO_BASIC: Record<string, string> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
};

export const DECK_TARGET = 99; // non-commander cards
const LAND_MIN = 37;
const LAND_MAX = 40;
const LAND_SWEET = 38;
const NONLAND_MIN = DECK_TARGET - LAND_MAX; // 59
const NONLAND_MAX = DECK_TARGET - LAND_MIN; // 62

/** A card the model proposed, tagged with whether it is a land (from real type data). */
export interface ResolvedDeckEntry {
  name: string;
  qty: number;
  isLand: boolean;
}

export interface DeckBalanceResult {
  /** Final list (basics recomputed), de-duplicated, alphabetically sorted. */
  entries: CardEntry[];
  /** Sum of quantities. */
  total: number;
  /** Non-land cards (the lever that fixes the land count). */
  nonlandCount: number;
  /** Lands after balancing (nonbasic lands + basics). */
  landCount: number;
  /** True when the deck is well-formed: exactly 99 cards with lands in the 37–40 band. */
  reconciled: boolean;
  /** Non-land cards to TRIM (model listed too many); 0 otherwise. */
  overBy: number;
  /** Non-land cards to ADD (model listed too few); 0 otherwise. */
  shortBy: number;
}

/**
 * Balance a proposed deck to exactly 99 cards where possible, adjusting ONLY
 * basic lands and never inflating the land count past the healthy band.
 */
export function balanceResolvedDeck(
  items: ResolvedDeckEntry[],
  colorIdentity: string[],
): DeckBalanceResult {
  // Merge duplicate names (keeping the land flag).
  const merged = new Map<string, ResolvedDeckEntry>();
  for (const it of items) {
    const existing = merged.get(it.name);
    if (existing) existing.qty += it.qty;
    else merged.set(it.name, { ...it });
  }
  const all = [...merged.values()];

  // Keep the model's non-land cards and NONBASIC lands as-is; basics are
  // recomputed as the filler (we discard whatever basic counts it guessed).
  const kept = all.filter((e) => !e.isLand || !isBasicLand(e.name));
  const nonlandCount = kept.filter((e) => !e.isLand).reduce((n, e) => n + e.qty, 0);
  const nonbasicLandCount = kept.filter((e) => e.isLand).reduce((n, e) => n + e.qty, 0);

  // Decide how many lands the deck should end up with. The land count is NEVER
  // squeezed or bloated to force a 99 total — that's what wrecks the mana base.
  let targetLands: number;
  if (nonlandCount >= NONLAND_MIN && nonlandCount <= NONLAND_MAX) {
    // Healthy: lands = 99 − non-land, which sits in the 37–40 band → reconciles.
    targetLands = DECK_TARGET - nonlandCount;
  } else {
    // Out of band (too many OR too few non-land cards): hold lands at the sweet
    // spot and flag the delta (add/trim non-land cards) rather than cutting or
    // padding lands to hit 99.
    targetLands = LAND_SWEET;
  }

  const basicsNeeded = Math.max(0, targetLands - nonbasicLandCount);
  const entries: CardEntry[] = kept.map((e) => ({ name: e.name, qty: e.qty }));
  if (basicsNeeded > 0) addBasics(entries, basicsNeeded, colorIdentity);

  const cleaned = entries.filter((e) => e.qty > 0).sort((a, b) => a.name.localeCompare(b.name));
  const total = cleaned.reduce((n, e) => n + e.qty, 0);
  const landCount = nonbasicLandCount + basicsNeeded;

  return {
    entries: cleaned,
    total,
    nonlandCount,
    landCount,
    reconciled: total === DECK_TARGET && landCount >= LAND_MIN && landCount <= LAND_MAX,
    overBy: Math.max(0, nonlandCount - NONLAND_MAX),
    shortBy: Math.max(0, NONLAND_MIN - nonlandCount),
  };
}

/** Distribute `count` basic lands across the commander's colours (Wastes if colourless), round-robin. */
function addBasics(entries: CardEntry[], count: number, colorIdentity: string[]): void {
  const fromColors = colorIdentity.map((c) => COLOR_TO_BASIC[c]).filter((n): n is string => !!n);
  const targets = fromColors.length ? fromColors : ['Wastes'];
  for (let i = 0; i < count; i++) {
    const name = targets[i % targets.length]!;
    const existing = entries.find((e) => e.name === name);
    if (existing) existing.qty += 1;
    else entries.push({ name, qty: 1 });
  }
}
