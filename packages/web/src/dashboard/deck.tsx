import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Card, CategorizedCard, DeckRole } from '@commander-oracle/shared';

/**
 * Deck state — the single source of truth for the dashboard. The stats row and
 * the card grid both derive from this, so any add/remove/swap updates everything
 * reactively. Build and Analyze both populate it (a built deck is just an
 * analyzed deck that started empty).
 */
export interface DeckSnapshot {
  commander: Card | null;
  cards: CategorizedCard[]; // the 99 non-commander cards
  name?: string;
}

interface DeckContextValue {
  name: string;
  commander: Card | null;
  cards: CategorizedCard[];
  isEmpty: boolean;
  setName: (name: string) => void;
  setCommander: (card: Card | null) => void;
  /** Replace the whole deck (from /api/echo or a finished build). */
  loadDeck: (snapshot: DeckSnapshot) => void;
  addCard: (card: Card, qty?: number) => void;
  removeCard: (name: string) => void;
  /** Swap: remove `cutName`, add `add` — the core "Apply suggestion" mutation. */
  replaceCard: (cutName: string, add: Card) => void;
  /** Attach model-assigned roles/notes to matching cards (from /api/deck/roles). */
  applyClassification: (map: Record<string, { role: DeckRole; note?: string }>) => void;
  reset: () => void;
}

const DeckContext = createContext<DeckContextValue | null>(null);

export function useDeck(): DeckContextValue {
  const ctx = useContext(DeckContext);
  if (!ctx) throw new Error('useDeck must be used within <DeckProvider>');
  return ctx;
}

const norm = (s: string) => s.toLowerCase().trim();

export function DeckProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState('Untitled deck');
  const [commander, setCommander] = useState<Card | null>(null);
  const [cards, setCards] = useState<CategorizedCard[]>([]);

  const value = useMemo<DeckContextValue>(() => {
    return {
      name,
      commander,
      cards,
      isEmpty: cards.length === 0 && !commander,
      setName,
      setCommander,
      loadDeck: (snap) => {
        setCommander(snap.commander);
        setCards(snap.cards);
        if (snap.name) setName(snap.name);
      },
      addCard: (card, qty = 1) =>
        setCards((prev) => {
          const i = prev.findIndex((e) => norm(e.card.name) === norm(card.name));
          if (i === -1) return [...prev, { qty, card }];
          const next = [...prev];
          next[i] = { ...next[i]!, qty: next[i]!.qty + qty };
          return next;
        }),
      removeCard: (cutName) => setCards((prev) => prev.filter((e) => norm(e.card.name) !== norm(cutName))),
      replaceCard: (cutName, add) =>
        setCards((prev) => {
          const without = prev.filter((e) => norm(e.card.name) !== norm(cutName));
          if (without.some((e) => norm(e.card.name) === norm(add.name))) return without;
          return [...without, { qty: 1, card: add }];
        }),
      applyClassification: (map) =>
        setCards((prev) =>
          prev.map((e) => {
            const r = map[e.card.name.toLowerCase()];
            return r ? { ...e, role: r.role, note: r.note } : e;
          }),
        ),
      reset: () => {
        setCommander(null);
        setCards([]);
        setName('Untitled deck');
      },
    };
  }, [name, commander, cards]);

  return <DeckContext.Provider value={value}>{children}</DeckContext.Provider>;
}

// --- Accent colour derived from the deck's colour identity ----------------

const COLOR_ACCENT: Record<string, string> = {
  W: '#c2a24a',
  U: '#2f6fb0',
  B: '#4a4550',
  R: '#b0432f',
  G: '#3f8a58',
};

/** A single accent hue for the deck: the colour if mono, gold if multi, slate if none. */
export function accentForColors(colors: string[]): string {
  if (colors.length === 0) return '#64707c'; // colourless / no deck → slate
  if (colors.length === 1) return COLOR_ACCENT[colors[0]!] ?? '#64707c';
  return '#b0862f'; // multicolour → gold
}

// --- Derived stats (pure; the stats row reads these) ----------------------

const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6+'] as const;

export interface DeckStats {
  total: number; // non-commander + commander
  nonland: number;
  lands: number;
  /** Non-land cards bucketed by mana value (0,1,2,3,4,5,6+). */
  curve: { label: string; count: number }[];
  /** WUBRG letters present anywhere in the deck's colour identity. */
  colors: string[];
  /** Cards (by quantity) contributing each colour. */
  colorCounts: Record<string, number>;
  avgCmc: number;
}

const isLand = (c: Card) => /\bLand\b/.test(c.typeLine);

export function deckStats(cards: CategorizedCard[], commander: Card | null): DeckStats {
  const buckets = new Map<string, number>(CURVE_BUCKETS.map((b) => [b, 0]));
  const colorCounts: Record<string, number> = {};
  let nonland = 0;
  let lands = 0;
  let cmcSum = 0;

  const all = commander ? [{ qty: 1, card: commander }, ...cards] : cards;
  for (const { qty, card } of all) {
    for (const col of card.colorIdentity) colorCounts[col] = (colorCounts[col] ?? 0) + qty;
    if (isLand(card)) {
      lands += qty;
      continue;
    }
    nonland += qty;
    cmcSum += card.cmc * qty;
    const b = card.cmc >= 6 ? '6+' : String(Math.floor(card.cmc));
    buckets.set(b, (buckets.get(b) ?? 0) + qty);
  }

  return {
    total: cards.reduce((n, e) => n + e.qty, 0) + (commander ? 1 : 0),
    nonland,
    lands,
    curve: CURVE_BUCKETS.map((label) => ({ label, count: buckets.get(label) ?? 0 })),
    colors: ['W', 'U', 'B', 'R', 'G'].filter((c) => colorCounts[c]),
    colorCounts,
    avgCmc: nonland ? Math.round((cmcSum / nonland) * 10) / 10 : 0,
  };
}
