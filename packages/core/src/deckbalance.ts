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
const NONLAND_SWEET = DECK_TARGET - LAND_SWEET; // 61

/** A card the model proposed, tagged with real type data. `edhrecRank` (lower = more played) orders auto-trims. */
export interface ResolvedDeckEntry {
  name: string;
  qty: number;
  isLand: boolean;
  edhrecRank?: number | null;
}

export interface DeckBalanceResult {
  /** Final list (basics recomputed, over-lists auto-trimmed), de-duplicated, alphabetically sorted. */
  entries: CardEntry[];
  /** Sum of quantities. */
  total: number;
  /** Non-land cards after any auto-trim. */
  nonlandCount: number;
  /** Lands after balancing (nonbasic lands + basics). */
  landCount: number;
  /** True when the deck is well-formed: exactly 99 cards with lands in the 37–40 band. */
  reconciled: boolean;
  /** Non-land cards still over the band after trimming (only if nonbasic lands alone crowd the deck). */
  overBy: number;
  /** Non-land cards to ADD (model listed too few — we can't invent spells); 0 otherwise. */
  shortBy: number;
  /** Non-land cards the balancer auto-removed (least-played first) to reach a healthy land count. */
  trimmed: string[];
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

  // Split the model's list: non-land cards and NONBASIC lands are kept; the
  // model's basic-land guess is discarded and recomputed as the filler.
  const nonland = all.filter((e) => !e.isLand);
  const nonbasicLands = all.filter((e) => e.isLand && !isBasicLand(e.name));
  const nonbasicLandCount = nonbasicLands.reduce((n, e) => n + e.qty, 0);

  // AUTO-FIX an over-list: if there are too many non-land cards to fit a healthy
  // land count, remove the least-played ones (worst EDHREC rank first; unranked
  // counts as least-played) down to the 38-land sweet spot — rather than
  // squeezing lands. This actually corrects the deck instead of just flagging it.
  const trimmed: string[] = [];
  let nonlandCount = nonland.reduce((n, e) => n + e.qty, 0);
  if (nonlandCount > NONLAND_MAX) {
    let toTrim = nonlandCount - NONLAND_SWEET; // → 61 non-land, 38 lands
    const worstFirst = [...nonland].sort(
      (a, b) => rankValue(b) - rankValue(a) || a.name.localeCompare(b.name),
    );
    for (const entry of worstFirst) {
      if (toTrim <= 0) break;
      const take = Math.min(entry.qty, toTrim);
      entry.qty -= take;
      toTrim -= take;
      for (let i = 0; i < take; i++) trimmed.push(entry.name);
    }
    nonlandCount = nonland.reduce((n, e) => n + e.qty, 0);
  }

  // Basics fill whatever is still needed to reach exactly 99 (→ 100 with the
  // commander). After the trim above, lands land in the healthy band; if the
  // model was SHORT on non-land cards we can't invent spells, so lands fill
  // higher and shortBy flags it — but the deck is always 100.
  const kept = [...nonland, ...nonbasicLands].filter((e) => e.qty > 0);
  const basicsNeeded = Math.max(0, DECK_TARGET - nonlandCount - nonbasicLandCount);
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
    trimmed,
  };
}

/** EDHREC rank as a sortable number; unranked cards sort as least-played (trimmed first). */
function rankValue(e: ResolvedDeckEntry): number {
  return e.edhrecRank == null ? Number.POSITIVE_INFINITY : e.edhrecRank;
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
