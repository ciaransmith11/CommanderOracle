import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { categorise } from '@commander-oracle/core';
import { api, streamChat, streamRules, type StreamHandlers } from '../api.js';
import { useDeck } from './deck.js';

marked.setOptions({ gfm: true, breaks: false });

type Msg = { role: 'user' | 'assistant'; content: string };

/** Pull bolded card names (**Name**) from a rules answer, cleaned and de-duped. */
function extractCardNames(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    const name = m[1]!
      .replace(/[’'`]s$/i, '')
      .replace(/[.,:;!?]+$/, '')
      .trim();
    const key = name.toLowerCase();
    // Skip obvious non-cards (rule refs, single words that are all-caps like CR).
    if (name.length < 3 || /^CR\b/i.test(name) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, 12);
}

/**
 * The persistent advisor sidebar — a compact live chat that stays across modes.
 * Routing: Rules → /api/rules; a loaded deck → /api/chat (deck-aware, sent from
 * live deck state so it reflects edits); otherwise a general MTG chat.
 */
export function Advisor({
  mode,
  onReferences,
}: {
  mode: string;
  onReferences?: (cards: import('@commander-oracle/shared').Card[]) => void;
}) {
  const { commander, cards } = useDeck();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const acc = useRef('');
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [messages, streaming, status]);

  const hasDeck = cards.length > 0 || !!commander;

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setStatus('');
    setStreaming('');
    acc.current = '';
    if (mode === 'rules') onReferences?.([]); // clear stale references for the new question

    const handlers: StreamHandlers = {
      onStatus: setStatus,
      onReset: () => {
        acc.current = '';
        setStreaming('');
      },
      onDelta: (t) => {
        setStatus('');
        acc.current += t;
        setStreaming(acc.current);
      },
      onDone: () => {
        const answer = acc.current;
        setMessages([...next, { role: 'assistant', content: answer }]);
        setStreaming('');
        setStatus('');
        setBusy(false);
        // In Rules mode, surface the cards the answer referenced.
        if (mode === 'rules' && onReferences) {
          const names = extractCardNames(answer);
          if (names.length) api.lookupCards(names).then((r) => onReferences(r.cards)).catch(() => {});
        }
      },
      onError: (m) => {
        setMessages([...next, { role: 'assistant', content: `⚠ ${m}` }]);
        setStreaming('');
        setStatus('');
        setBusy(false);
      },
    };

    if (mode === 'rules' || !hasDeck) {
      streamRules(next, handlers);
    } else {
      const deck = categorise(cards, commander ? [commander] : []);
      streamChat(deck, next, handlers);
    }
  }

  const placeholder =
    mode === 'rules'
      ? 'Ask a rules question…'
      : hasDeck
        ? 'Ask about your deck — cuts, adds, curve…'
        : 'Ask anything — or load a deck for tailored advice';

  return (
    <aside className="advisor" aria-label="Advisor">
      <div className="advisor__head">
        <span className="advisor__title">Advisor</span>
        <span className="advisor__mode">{mode}</span>
      </div>

      <div className="advisor__feed" ref={feedRef}>
        {messages.length === 0 && !streaming && !busy && (
          <div className="advisor__placeholder">
            The advisor stays with you across every mode.{' '}
            {mode === 'rules'
              ? 'Ask a rules or interaction question.'
              : hasDeck
                ? 'Ask for cuts, adds, or a read on the curve.'
                : 'Load or build a deck for tailored advice, or ask a general question.'}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`abub abub--${m.role}`}>
            {m.role === 'assistant' ? (
              <div className="abub__md" dangerouslySetInnerHTML={{ __html: marked.parse(m.content) as string }} />
            ) : (
              m.content
            )}
          </div>
        ))}
        {streaming && (
          <div className="abub abub--assistant">
            <div className="abub__md" dangerouslySetInnerHTML={{ __html: marked.parse(streaming) as string }} />
          </div>
        )}
        {busy && !streaming && <div className="abub abub--status">{status || 'Thinking…'}</div>}
      </div>

      <form
        className="advisor__composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="advisor__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={busy}
        />
        <button className="advisor__send" type="submit" aria-label="Send" disabled={busy || !input.trim()}>
          ↑
        </button>
      </form>
    </aside>
  );
}
