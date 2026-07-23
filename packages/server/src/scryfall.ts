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
// Scryfall enforces <10 req/s across the whole app and asks for a 50–100ms gap
// between requests. 150ms (~6.7/s) leaves headroom for event-loop jitter under
// load (concurrent fetches + streaming can bunch setTimeout callbacks).
const THROTTLE_MS = 150;
const MAX_ATTEMPTS = 4; // retry 429 / 5xx a few times with backoff.

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
  set?: string;
  set_name?: string;
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
    set: c.set ? c.set.toUpperCase() : undefined,
    setName: c.set_name,
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

// --- Global request throttle + retry --------------------------------------
// EVERY outbound Scryfall request funnels through one promise chain so their
// START times are spaced ≥ THROTTLE_MS apart, app-wide — regardless of how many
// analyses, tool calls, or hover lookups run concurrently. Without this, a
// single analysis firing dozens of unthrottled searches trips Scryfall's 10
// req/s limit, and the resulting 429s sink the collection lookups that back
// hover previews (cards resolve to null → no hover image).

let chain: Promise<void> = Promise.resolve();
// When Scryfall rate-limits us it BLOCKS for ~60s, so independent per-request
// retries just re-trip it in a feedback loop. Instead a 429 sets a GLOBAL
// cooldown that every queued request waits out — the whole pipeline pauses,
// drains the penalty, and resumes together.
let blockedUntil = 0;

/** Reserve the next request slot; resolves when it is this caller's turn (past any cooldown). */
function reserveSlot(): Promise<void> {
  const mine = chain.then(async () => {
    const wait = blockedUntil - Date.now();
    if (wait > 0) await sleep(wait);
  });
  chain = mine.then(() => sleep(THROTTLE_MS));
  return mine;
}

/**
 * Throttled fetch with backoff on 429 / 5xx. A 429 additionally arms the global
 * cooldown so concurrent requests back off together. On persistent failure it
 * returns the final (non-OK) response so callers keep their existing handling.
 */
async function scryfallFetch(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    await reserveSlot();
    const res = await fetch(url, {
      ...init,
      headers: { ...REQUEST_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
    });

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8000)
        : 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
      if (res.status === 429) blockedUntil = Date.now() + delay;
      await sleep(delay);
      continue;
    }
    return res;
  }
}

// --- Result cache ---------------------------------------------------------
// Card data (oracle text, legality, images) is effectively static within a
// session, and the UI re-requests the same cards constantly (hover previews,
// repeated tool lookups). Memoising by name / query eliminates the duplicate
// traffic that pushes us toward the rate limit — and makes repeat hovers instant.
const cardCache = new Map<string, Card>(); // normalized name -> card
const searchCache = new Map<string, Card[]>(); // query key -> results

/** Cache key: name alone, or name qualified by set code for a specific printing. */
function cacheKey(name: string, set?: string): string {
  const base = normalizeName(name);
  return set ? `${base}|${set.toLowerCase()}` : base;
}

/** Cache a card under its full name (and front-face name), plus set-qualified keys. */
function cacheCard(card: Card): void {
  cardCache.set(normalizeName(card.name), card);
  if (card.set) cardCache.set(cacheKey(card.name, card.set), card);
  const front = card.name.split(' // ')[0];
  if (front) {
    const key = normalizeName(front);
    if (!cardCache.has(key)) cardCache.set(key, card);
    if (card.set) {
      const sk = cacheKey(front, card.set);
      if (!cardCache.has(sk)) cardCache.set(sk, card);
    }
  }
}

/** A card to fetch: by name, optionally pinned to a specific set (printing). */
export interface CardIdentifier {
  name: string;
  set?: string;
}

/** Fetch cards by name via the collection endpoint. */
export async function fetchCollection(names: string[]): Promise<{ cards: Card[]; notFound: string[] }> {
  return fetchCollectionBy(names.map((name) => ({ name })));
}

/**
 * Fetch cards by (name, optional set) via the collection endpoint — honouring a
 * requested printing when a set code is given. Returns normalized cards and the
 * names Scryfall could not resolve.
 */
export async function fetchCollectionBy(
  ids: CardIdentifier[],
): Promise<{ cards: Card[]; notFound: string[] }> {
  const cards: Card[] = [];
  const notFound: string[] = [];

  // Serve cache hits locally; only the misses (deduped by name+set) hit Scryfall.
  const misses: CardIdentifier[] = [];
  const seenMiss = new Set<string>();
  for (const id of ids) {
    const key = cacheKey(id.name, id.set);
    const cached = cardCache.get(key);
    if (cached) cards.push(cached);
    else if (!seenMiss.has(key)) {
      seenMiss.add(key);
      misses.push(id);
    }
  }

  const batches = chunk(misses, MAX_IDENTIFIERS);
  for (const batch of batches) {
    const identifiers = batch.map((id) =>
      id.set ? { name: id.name, set: id.set.toLowerCase() } : { name: id.name },
    );
    const res = await scryfallFetch(COLLECTION_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ identifiers }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Scryfall collection request failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as CollectionResponse;
    for (const raw of json.data) {
      const card = normalizeCard(raw);
      cacheCard(card);
      cards.push(card);
    }
    for (const nf of json.not_found) if (nf.name) notFound.push(nf.name);
  }

  // The collection endpoint matches a double-faced card only by its FRONT-FACE
  // name, so a full "Front // Back" identifier lands in not_found. Recover those
  // (and other near-misses, e.g. odd punctuation) via the forgiving fuzzy named
  // endpoint before giving up.
  if (notFound.length > 0) {
    const stillMissing: string[] = [];
    for (const name of notFound) {
      const card = await namedCard(name);
      if (card) cards.push(card);
      else stillMissing.push(name);
    }
    notFound.length = 0;
    notFound.push(...stillMissing);
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
  const cached = cardCache.get(normalizeName(name));
  if (cached) return cached;
  const res = await scryfallFetch(
    `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`,
  );
  if (!res.ok) return null;
  const card = normalizeCard((await res.json()) as ScryfallCard);
  cacheCard(card);
  return card;
}

/**
 * Full-text card search via Scryfall's search endpoint. Returns real cards
 * matching the query (Scryfall syntax). Returns [] on no-match (404) or bad
 * query rather than throwing, so a single bad fragment can't sink a batch.
 * Ordered by EDHREC rank so the most-played matches surface first.
 */
export async function searchCards(query: string, limit = 25): Promise<Card[]> {
  const cacheKey = `${limit}:${query}`;
  const hit = searchCache.get(cacheKey);
  if (hit) return hit;

  const params = new URLSearchParams({ q: query, order: 'edhrec', unique: 'cards' });
  const res = await scryfallFetch(`${SEARCH_ENDPOINT}?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: ScryfallCard[] };
  const results = (json.data ?? []).slice(0, limit).map(normalizeCard);
  for (const card of results) cacheCard(card); // repeat hovers on results are instant
  searchCache.set(cacheKey, results);
  return results;
}

/**
 * Commander name suggestions for type-ahead. Restricted to legal commanders and
 * ranked by EDHREC popularity, so the obvious choices surface first. Returns
 * just names; [] for short queries or no match.
 */
export async function autocompleteCommanders(query: string): Promise<string[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({ q: `${q} is:commander`, order: 'edhrec', unique: 'cards' });
  const res = await scryfallFetch(`${SEARCH_ENDPOINT}?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: { name?: string }[] };
  return (json.data ?? [])
    .map((c) => c.name)
    .filter((n): n is string => typeof n === 'string')
    .slice(0, 8);
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
    // Honour the typed set code (if any) so the resolved printing matches the copy the user listed.
    const { cards } = await fetchCollectionBy(toFetch.map((e) => ({ name: e.name, set: e.set })));

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

    for (const entry of toFetch) {
      const card = byName.get(normalizeName(entry.name));
      if (card) items.push({ qty: entry.qty, card, ...(entry.set ? { requestedSet: entry.set } : {}) });
      else unresolved.push(entry.name);
    }
  }

  return { items, unresolved };
}
