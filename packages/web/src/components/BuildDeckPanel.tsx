import { useEffect, useMemo, useState } from 'react';
import type { DeckBalanceResult } from '@commander-oracle/core';
import { api } from '../api.js';

/** Pull the ```decklist fenced block (or any block of "qty name" lines) out of the message. */
function extractDeckBlock(md: string): string | null {
  const fences = [...md.matchAll(/```([a-zA-Z]*)\s*\n([\s\S]*?)```/g)];
  const labeled = fences.find((f) => /deck/i.test(f[1] ?? ''));
  const looksLikeList = fences.find((f) => /^\s*\d+\s+\S/m.test(f[2] ?? ''));
  return (labeled ?? looksLikeList)?.[2] ?? null;
}

type Reconciled = DeckBalanceResult & { unresolved: string[] };

/**
 * Deterministic, land-aware decklist. Sends the model's decklist block to the
 * server, which resolves real card types and balances to 100 WITHOUT inflating
 * the land count: healthy builds fill basics to exactly 99; under-filled builds
 * are flagged (add N non-land cards) rather than padded into a mana glut, and
 * over-filled builds are flagged (trim N) rather than gutting the lands.
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
  const [result, setResult] = useState<Reconciled | null>(null);
  const [error, setError] = useState<string | null>(null);

  const block = useMemo(() => extractDeckBlock(text), [text]);
  const ciKey = colorIdentity.join('');

  useEffect(() => {
    if (!block) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setResult(null);
    api
      .reconcileBuild(block, ciKey ? ciKey.split('') : [])
      .then((r) => !cancelled && setResult(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [block, ciKey]);

  if (!block) return null;

  if (error) {
    return (
      <div className="echo deckpanel">
        <div className="echo__unresolved">⚠ Couldn’t verify the decklist: {error}</div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="echo deckpanel">
        <div className="echo__meta">Verifying decklist…</div>
      </div>
    );
  }

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
          <strong>{grand}</strong> cards ({result.nonlandCount} non-land + {result.landCount} lands + commander)
          <button className="btn-new" style={{ marginLeft: 10 }} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>

      {result.overBy > 0 && (
        <div className="echo__unresolved">
          ⚠ {result.overBy} too many non-land card{result.overBy === 1 ? '' : 's'} ({result.nonlandCount} listed).
          Cutting lands to compensate would wreck the mana base, so nothing was removed — trim {result.overBy}{' '}
          non-land card{result.overBy === 1 ? '' : 's'} (or ask for cuts).
        </div>
      )}
      {result.shortBy > 0 && (
        <div className="echo__unresolved">
          ⚠ {result.shortBy} non-land card{result.shortBy === 1 ? '' : 's'} short ({result.nonlandCount} listed).
          Lands are held at {result.landCount} rather than padded to fill the gap — add {result.shortBy} more
          non-land card{result.shortBy === 1 ? '' : 's'} to reach 100.
        </div>
      )}
      {result.overBy === 0 && result.shortBy === 0 && !result.reconciled && (
        <div className="echo__unresolved">
          ⚠ {result.landCount} lands is outside the healthy 37–40 range — adjust the nonbasic lands.
        </div>
      )}

      {result.unresolved.length > 0 && (
        <div className="echo__meta" style={{ marginBottom: 8 }}>
          Couldn’t verify on Scryfall (counted as non-land): {result.unresolved.join(', ')}
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
