import { useEffect, useState } from 'react';
import type { Card, CategorizedCard } from '@commander-oracle/shared';
import { categorise } from '@commander-oracle/core';
import { api } from '../api.js';
import { useDeck, deckStats } from './deck.js';
import { StatsRow } from './StatsRow.js';
import { DeckGrid } from './DeckGrid.js';
import { SuggestionCard } from './SuggestionCard.js';

/** Serialize the deck to a plain-text list: commander first, then qty-prefixed
 *  lines sorted by name — the widely-accepted format for sharing / re-importing. */
function deckToText(name: string, commander: Card | null, cards: CategorizedCard[]): string {
  const lines: string[] = [];
  const total = cards.reduce((n, e) => n + e.qty, 0) + (commander ? 1 : 0);
  lines.push(`// ${name} — ${total} cards`);
  if (commander) {
    lines.push('', 'Commander', `1 ${commander.name}`);
  }
  const body = cards
    .slice()
    .sort((a, b) => a.card.name.localeCompare(b.card.name))
    .map((e) => `${e.qty} ${e.card.name}`);
  lines.push('', 'Deck', ...body);
  return lines.join('\n');
}

function DeckExport() {
  const { name, commander, cards } = useDeck();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(deckToText(name, commander, cards));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the export button still works */
    }
  };

  const download = () => {
    const blob = new Blob([deckToText(name, commander, cards)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(commander?.name ?? name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="dashboard__export">
      <button className="ghostbtn" onClick={copy} type="button" title="Copy the decklist as plain text">
        {copied ? 'Copied ✓' : 'Copy list'}
      </button>
      <button className="ghostbtn" onClick={download} type="button" title="Download the decklist as a .txt file">
        Export .txt
      </button>
    </div>
  );
}

/**
 * The deck dashboard — header + stats row + suggested swaps + card grid, all
 * reading from deck state. Shared by Analyze and (once a build finishes) Build.
 */
export function Dashboard() {
  const { name, commander, cards, removeCard, applyClassification } = useDeck();
  const [classifying, setClassifying] = useState(false);
  const stats = deckStats(cards, commander);

  // On a freshly loaded deck (no roles yet), classify every card into a functional
  // role so the grid can group by role. Runs once per load; falls back silently.
  const fresh = cards.length > 0 && cards.every((c) => !c.role);
  useEffect(() => {
    if (!fresh) return;
    let cancelled = false;
    setClassifying(true);
    api
      .classifyDeck(categorise(cards, commander ? [commander] : []))
      .then((r) => !cancelled && applyClassification(r.roles))
      .catch(() => {})
      .finally(() => !cancelled && setClassifying(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);
  const title = commander?.name ?? name;
  const colorLabel =
    stats.colors.length === 0 ? 'Colourless' : stats.colors.length === 1 ? 'Mono' : `${stats.colors.length}-colour`;

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <div className="dashboard__id">
          <h1 className="dashboard__name" title={title}>
            {title}
          </h1>
          <div className="dashboard__sub">
            {commander ? 'Commander' : 'Deck'} · {stats.total} cards · {colorLabel}
          </div>
        </div>
        <div className="dashboard__head-right">
          <DeckExport />
          <span className="badge" title="Power bracket — coming from the advisor later">
            Bracket —
          </span>
        </div>
      </div>

      <StatsRow cards={cards} commander={commander} />
      <SuggestionsPanel />
      {classifying && <div className="suggpanel__empty">Classifying cards by role…</div>}
      <DeckGrid cards={cards} commander={commander} onRemove={removeCard} />
    </div>
  );
}

type Swap = { cut: string; add: Card; reason: string; role: import('@commander-oracle/shared').DeckRole };

function SuggestionsPanel() {
  const { commander, cards, replaceCard } = useDeck();
  const [swaps, setSwaps] = useState<Swap[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchSwaps() {
    if (busy || cards.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const deck = categorise(cards, commander ? [commander] : []);
      const r = await api.suggest(deck);
      setSwaps(r.suggestions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const drop = (i: number) => setSwaps((prev) => (prev ? prev.filter((_, j) => j !== i) : prev));

  return (
    <section className="suggpanel">
      <div className="suggpanel__head">
        <h3 className="suggpanel__title">Suggested swaps</h3>
        <button className="suggpanel__btn" onClick={fetchSwaps} disabled={busy} type="button">
          {busy ? 'Thinking…' : swaps ? 'Refresh' : 'Suggest swaps'}
        </button>
      </div>
      {error && <div className="paste__error">⚠ {error}</div>}
      {swaps && swaps.length === 0 && <div className="suggpanel__empty">No swaps suggested — this looks solid.</div>}
      {swaps && swaps.length > 0 && (
        <div className="suggpanel__list">
          {swaps.map((s, i) => (
            <SuggestionCard
              key={`${s.add.name}-${i}`}
              add={s.add}
              cut={s.cut}
              reason={s.reason}
              role={s.role}
              onApply={() => {
                replaceCard(s.cut, s.add);
                drop(i);
              }}
              onDismiss={() => drop(i)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
