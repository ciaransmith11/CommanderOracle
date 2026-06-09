/**
 * The slot template and design philosophies, expressed as DATA.
 *
 * These are baselines and reference points — NOT rigid targets. The model is
 * told to lead with the deck's gameplan and justify deviations; the slot counts
 * are secondary. Which cards fall into ramp / card advantage / disruption is a
 * judgment task and lives with the model, not here — this module only exposes
 * the reference numbers so the prompt and UI can speak the same language.
 */

export interface SlotBaseline {
  baseline: number;
  min?: number;
  max?: number;
  note?: string;
}

export const SLOT_BASELINES: Record<string, SlotBaseline> = {
  lands: { baseline: 38, min: 36, max: 40, note: 'Adjust to the deck average mana value.' },
  ramp: {
    baseline: 10,
    note: 'Mana rocks, mana dorks, land-search. Favour 2-mana over 3-mana to deploy the commander sooner.',
  },
  cardAdvantage: {
    baseline: 12,
    note: 'Draw AND tutors — anything that refills the hand or finds key cards. Not scry/surveil/lifegain.',
  },
  targetedDisruption: {
    baseline: 12,
    note: 'Spot removal (creatures, artifacts, enchantments) and counterspells.',
  },
  massDisruption: {
    baseline: 6,
    note: 'Board wipes / global removal to reset when behind.',
  },
  plan: { baseline: 30, note: 'The remainder (30+): commander synergies, combos, win conditions.' },
};

/**
 * Design philosophies that shape the audit. Overlaps are encouraged: category
 * totals deliberately exceed 100 because many cards fill multiple roles.
 */
export const DESIGN_PHILOSOPHY = {
  overlapsEncouraged:
    'Totals can exceed 100 — many cards fill multiple roles. Count a card in every role it serves.',
  lowerCurve: 'Favour lower mana curves; prefer 2-mana ramp over 3-mana.',
  dynamicAdjustment:
    'Baseline, not law. Adjust per deck type (aggressive decks run fewer wipes, control runs more disruption).',
} as const;
