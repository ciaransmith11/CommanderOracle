import type { CardEntry } from '@commander-oracle/shared';
import { isBasicLand } from './basics.js';

/**
 * Deterministic deck-size enforcement. The model can't reliably count its own
 * list, so after it proposes a deck we adjust ONLY the basic lands (the
 * fungible filler) to make the total exactly `target` — adding/removing basics
 * in the commander's colours. Pure and unit-tested; no model involved.
 */

const COLOR_TO_BASIC: Record<string, string> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
};

export interface BalanceResult {
  /** Adjusted, de-duplicated, alphabetically sorted entries. */
  entries: CardEntry[];
  /** Sum of quantities after adjustment. */
  total: number;
  /** Net change in card count (+added basics / −removed basics). */
  adjustment: number;
  /** True if the total reached the target (false only if basics couldn't absorb a large overage). */
  reconciled: boolean;
}

export function balanceBasicsToTarget(
  input: CardEntry[],
  target: number,
  colorIdentity: string[],
): BalanceResult {
  // Collapse duplicate names first.
  const merged = new Map<string, number>();
  for (const e of input) merged.set(e.name, (merged.get(e.name) ?? 0) + e.qty);
  const entries: CardEntry[] = [...merged].map(([name, qty]) => ({ name, qty }));

  const before = entries.reduce((n, e) => n + e.qty, 0);
  const diff = target - before;

  if (diff > 0) {
    const targets = basicTargets(entries, colorIdentity);
    for (let i = 0; i < diff; i++) {
      const name = targets[i % targets.length]!;
      const existing = entries.find((e) => e.name === name);
      if (existing) existing.qty += 1;
      else entries.push({ name, qty: 1 });
    }
  } else if (diff < 0) {
    let toRemove = -diff;
    // Remove from the largest basic stacks first.
    const basics = entries.filter((e) => isBasicLand(e.name)).sort((a, b) => b.qty - a.qty);
    for (const b of basics) {
      if (toRemove <= 0) break;
      const take = Math.min(b.qty, toRemove);
      b.qty -= take;
      toRemove -= take;
    }
  }

  const cleaned = entries.filter((e) => e.qty > 0).sort((a, b) => a.name.localeCompare(b.name));
  const total = cleaned.reduce((n, e) => n + e.qty, 0);
  return { entries: cleaned, total, adjustment: total - before, reconciled: total === target };
}

/** Which basics to add to: existing ones if present, else the commander's colours (Wastes if colourless). */
function basicTargets(entries: CardEntry[], colorIdentity: string[]): string[] {
  const present = entries.filter((e) => isBasicLand(e.name)).map((e) => e.name);
  if (present.length) return present;
  const fromColors = colorIdentity.map((c) => COLOR_TO_BASIC[c]).filter((n): n is string => !!n);
  return fromColors.length ? fromColors : ['Wastes'];
}
