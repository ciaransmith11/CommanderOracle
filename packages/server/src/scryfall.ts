import type { Card, CardEntry, CategorizedCard } from '@commander-oracle/shared';
import { basicLandCard, isBasicLand } from '@commander-oracle/core';

/**
 * Scryfall client — the ONLY source of card data. This is the direct-HTTP path
 * the prototype lacked: the model never sources card facts, it only reasons
 * over what this returns.
 *
 * Uses the collection endpoint (POST /cards/collection, ≤75 identifiers per
 * request) so a 99-card deck resolves in 2 calls rather than 99. Basic lands
 * are synthesized locally and never fetched.
 */

const COLLECTION_ENDPOINT = 'https://api.scryfall.com/cards/collection';
const SEARCH_ENDPOINT = 'https://api.scryfall.com/cards/search';
const MAX_IDENTIFIERS = 75;
const THROTTLE_MS = 100; // Scryfall asks for ~50–100ms between requests.

const REQUEST_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  // Scryfall requires a descriptive, identifying User-Agent.
  'User-Agent': 'CommanderOracle/0.1 (EDH deck advisor)',
};

// --- Raw Scryfall shapes (only the fields we consume) ---------------------

interface ScryfallCardFace {
  name?: string;
  type_line?: string;
  oracle_text?: string;
  mana_cost?: string;
  image_uris?: { normal?: string };
}

interface ScryfallCard {
  name: string;
  type_line?: string;
  mana_cost?: string;
  cmc?: number;
  color_identity?: string[];
  oracle_text?: string;
  legalities?: Record<string, string>;
  edhrec_rank?: number;
  prices?: { usd?: string | null; usd_foil?: string | null };
  image_uris?: { normal?: string };
  scryfall_uri?: string;
  card_faces?: ScryfallCardFace[];
}

interface CollectionResponse {
  data: ScryfallCard[];
  not_found: Array<{ name?: string }>;
}

// --- Normalization --------------------------------------------------------

/** Case/diacritic-insensitive key for matching decklist names to results. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a raw Scryfall card to our `Card`. Handles double-faced cards: top-level
 * `oracle_text` / `mana_cost` / `image_uris` can be empty, so we fall back to
 * the front face (handoff §5).
 */
export function normalizeCard(c: ScryfallCard): Card {
  const front = c.card_faces?.[0];

  const typeLine = c.type_line ?? front?.type_line ?? '';

  const oracleText =
    c.oracle_text && c.oracle_text.length > 0
      ? c.oracle_text
      : (c.card_faces ?? [])
          .map((f) => f.oracle_text ?? '')
          .filter((t) => t.length > 0)
          .join('\n//\n');

  const manaCost =
    c.mana_cost && c.mana_cost.length > 0 ? c.mana_cost : (front?.mana_cost ?? null);

  const imageUrl = c.image_uris?.normal ?? front?.image_uris?.normal ?? null;

  // Per-face data for double-faced / split cards (2+ named faces), so each face
  // name can be hovered to show that face.
  const namedFaces = (c.card_faces ?? []).filter((f): f is ScryfallCardFace & { name: string } => !!f.name);
  const faces =
    namedFaces.length >= 2
      ? namedFaces.map((f) => ({ name: f.name, imageUrl: f.image_uris?.normal ?? null }))
      : undefined;

  return {
    name: c.name,
    typeLine,
    manaCost: manaCost ?? null,
    cmc: c.cmc ?? 0,
    colorIdentity: c.color_identity ?? [],
    oracleText,
    legalCommander: c.legalities?.commander === 'legal',
    edhrecRank: c.edhrec_rank ?? null,
    priceUsd: parsePrice(c.prices?.usd) ?? parsePrice(c.prices?.usd_foil),
    imageUrl,
    scryfallUri: c.scryfall_uri ?? null,
    faces,
  };
}

// --- Fetching -------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch cards by name via the collection endpoint. Returns normalized cards and
 * the names Scryfall could not resolve.
 */
export async function fetchCollection(
  names: string[],
): Promise<{ cards: Card[]; notFound: string[] }> {
  const cards: Card[] = [];
  const notFound: string[] = [];

  const batches = chunk(names, MAX_IDENTIFIERS);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);

    const identifiers = batches[i]!.map((name) => ({ name }));
    const res = await fetch(COLLECTION_ENDPOINT, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: JSON.stringify({ identifiers }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Scryfall collection request failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as CollectionResponse;
    for (const raw of json.data) cards.push(normalizeCard(raw));
    for (const nf of json.not_found) if (nf.name) notFound.push(nf.name);
  }

  return { cards, notFound };
}

/**
 * Resolve a single card by (possibly approximate) name via Scryfall's fuzzy
 * named endpoint. More forgiving than the collection endpoint — handles partial
 * names, punctuation, and double-faced names — which is what hover previews
 * need. Returns null on no/ambiguous match.
 */
export async function namedCard(name: string): Promise<Card | null> {
  const res = await fetch(
    `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`,
    { headers: REQUEST_HEADERS },
  );
  if (!res.ok) return null;
  return normalizeCard((await res.json()) as ScryfallCard);
}

/**
 * Full-text card search via Scryfall's search endpoint. Returns real cards
 * matching the query (Scryfall syntax). Returns [] on no-match (404) or bad
 * query rather than throwing, so a single bad fragment can't sink a batch.
 * Ordered by EDHREC rank so the most-played matches surface first.
 */
export async function searchCards(query: string, limit = 25): Promise<Card[]> {
  const params = new URLSearchParams({ q: query, order: 'edhrec', unique: 'cards' });
  const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, { headers: REQUEST_HEADERS });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: ScryfallCard[] };
  return (json.data ?? []).slice(0, limit).map(normalizeCard);
}

/**
 * Resolve parsed decklist entries to `{ qty, card }` items, preserving entry
 * order. Basic lands are synthesized locally; everything else is fetched.
 * Names Scryfall doesn't recognise are returned in `unresolved`.
 */
export async function resolveEntries(
  entries: CardEntry[],
): Promise<{ items: CategorizedCard[]; unresolved: string[] }> {
  const items: CategorizedCard[] = [];
  const unresolved: string[] = [];
  const toFetch: CardEntry[] = [];

  for (const entry of entries) {
    if (isBasicLand(entry.name)) {
      const basic = basicLandCard(entry.name);
      if (basic) {
        items.push({ qty: entry.qty, card: basic });
        continue;
      }
    }
    toFetch.push(entry);
  }

  if (toFetch.length > 0) {
    const { cards, notFound } = await fetchCollection(toFetch.map((e) => e.name));

    // Index results by normalized full name, and by the front-face name for
    // double-faced cards (so "Valki" matches "Valki, God of Lies // Tibalt...").
    const byName = new Map<string, Card>();
    for (const card of cards) {
      byName.set(normalizeName(card.name), card);
      const front = card.name.split(' // ')[0];
      if (front) {
        const key = normalizeName(front);
        if (!byName.has(key)) byName.set(key, card);
      }
    }

    const notFoundSet = new Set(notFound.map(normalizeName));
    for (const entry of toFetch) {
      const card = byName.get(normalizeName(entry.name));
      if (card) items.push({ qty: entry.qty, card });
      else if (notFoundSet.has(normalizeName(entry.name))) unresolved.push(entry.name);
      else unresolved.push(entry.name);
    }
  }

  return { items, unresolved };
}
