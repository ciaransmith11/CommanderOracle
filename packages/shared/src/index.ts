/**
 * @commander-oracle/shared
 *
 * The data contract shared across every layer. These types are the boundary
 * between the deterministic core (parse / categorise / count) and the model
 * layer: the model only ever sees a `CategorizedDeck` it did not compute.
 */

/** A single decklist line resolved to a quantity and a card name. */
export interface CardEntry {
  qty: number;
  name: string;
}

/** Output of the pure decklist parser. */
export interface ParsedDecklist {
  /** Non-commander cards, with duplicate names merged and quantities summed. */
  entries: CardEntry[];
  /** Commander name(s); 0 if none could be detected, 2 for partners. */
  commanders: string[];
}

/**
 * Normalized card data. Sourced exclusively from Scryfall — never from model
 * recall. Double-faced fields are already flattened to a representative face
 * by the Scryfall normalizer (see §5 of the handoff).
 */
export interface Card {
  name: string;
  /** The source of truth for categorisation. Read every word. */
  typeLine: string;
  manaCost: string | null;
  cmc: number;
  colorIdentity: string[];
  oracleText: string;
  legalCommander: boolean;
  /** Popularity signal; lower is more popular. Null if Scryfall has no rank. */
  edhrecRank: number | null;
  priceUsd: number | null;
  imageUrl: string | null;
  scryfallUri: string | null;
}

/** The card-type sections used in the categorised echo, in display order. */
export type Section =
  | 'Commander'
  | 'Creatures'
  | 'Sorceries'
  | 'Instants'
  | 'Artifacts'
  | 'Enchantments'
  | 'Planeswalkers'
  | 'Battles'
  | 'Lands'
  | 'Other';

/** A card paired with how many copies the decklist contains. */
export interface CategorizedCard {
  qty: number;
  card: Card;
}

export interface DeckSection {
  section: Section;
  /** Sum of quantities in this section — never the number of distinct cards. */
  count: number;
  cards: CategorizedCard[];
}

/**
 * The fully verified, pre-counted deck. This is the only deck representation
 * the model is given, and it is told never to recount or recategorise it.
 */
export interface CategorizedDeck {
  commander: Card[];
  /** Type sections (excludes the commander), only non-empty ones, ordered. */
  sections: DeckSection[];
  /** Sum of all non-commander quantities — should be 99 for a legal deck. */
  nonCommanderTotal: number;
  /** nonCommanderTotal + commander count. */
  grandTotal: number;
  /** Lands section count (summed quantities). */
  landCount: number;
  /** Sum of priceUsd * qty across all cards, including the commander. */
  priceTotalUsd: number;
  /** Decklist names that could not be resolved to a Scryfall card. */
  unresolved: string[];
}
