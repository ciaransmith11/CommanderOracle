import { useMemo, useState } from 'react';
import { parseDecklist, balanceBasicsToTarget } from '@commander-oracle/core';

/** Pull the ```decklist fenced block (or any block of "qty name" lines) out of the message. */
function extractDeckBlock(md: string): string | null {
  const fences = [...md.matchAll(/```([a-zA-Z]*)\s*\n([\s\S]*?)```/g)];
  const labeled = fences.find((f) => /deck/i.test(f[1] ?? ''));
  const looksLikeList = fences.find((f) => /^\s*\d+\s+\S/m.test(f[2] ?? ''));
  return (labeled ?? looksLikeList)?.[2] ?? null;
}

/**
 * Deterministic, guaranteed-100 decklist. Parses the model's decklist block,
 * counts it in code, and balances basic lands to exactly 99 + commander = 100 —
 * so the displayed deck is always the right size regardless of the model's
 * arithmetic. Renders nothing if the message has no decklist block.
 */
export function BuildDeckPanel({
  text,
  commanderName,
  colorIdentity,
}: {
  text: string;
  commanderName: string;
  colorIdentity: string[];
}) {
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => {
    const block = extractDeckBlock(text);
    if (!block) return null;
    const { entries } = parseDecklist(block);
    if (entries.length === 0) return null;
    return balanceBasicsToTarget(entries, 99, colorIdentity);
  }, [text, colorIdentity]);

  if (!result) return null;

  const grand = result.total + 1; // + commander
  const decklistText =
    `1 ${commanderName} *CMDR*\n` + result.entries.map((e) => `${e.qty} ${e.name}`).join('\n');

  function copy() {
    void navigator.clipboard.writeText(decklistText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="echo deckpanel">
      <div className="echo__head">
        <span className="echo__title">Verified decklist</span>
        <span className="echo__meta">
          <strong>{grand}</strong> cards (commander + {result.total})
          <button className="btn-new" style={{ marginLeft: 10 }} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>
      {result.adjustment !== 0 && (
        <div className="echo__meta" style={{ marginBottom: 8 }}>
          Adjusted basic lands by {result.adjustment > 0 ? `+${result.adjustment}` : result.adjustment} to total
          100.
        </div>
      )}
      {!result.reconciled && (
        <div className="echo__unresolved">
          ⚠ Couldn’t reach exactly 100 by adjusting basics alone (deck has too few basics) — currently{' '}
          {grand}.
        </div>
      )}
      <ul className="echo__cards">
        <li className="echo__card">
          <span className="echo__qty">1×</span> {commanderName} (commander)
        </li>
        {result.entries.map((e) => (
          <li className="echo__card" key={e.name}>
            <span className="echo__qty">{e.qty}×</span> {e.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
