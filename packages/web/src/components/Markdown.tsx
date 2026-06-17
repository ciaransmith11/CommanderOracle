import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '@commander-oracle/shared';
import { api } from '../api.js';

marked.setOptions({ gfm: true, breaks: false });

// Basic-land names double as ordinary English words ("Island", "Mountain"), so
// we never auto-mark them to avoid false hits in prose.
const BASIC_NAMES = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest', 'Snow-Covered Wastes',
]);

// Card-name resolution for names NOT in a known deck list (Build/Recommend
// results, follow-up additions). Resolved in BATCHES via the collection endpoint
// — never one request per name, which would rate-limit on a card-heavy response.
// Cached across the whole session.
const resolved = new Map<string, Card | null>();
const pendingKeys = new Set<string>();

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Batch-resolve names that aren't cached or in flight, then populate the cache. */
async function resolveNames(names: string[]): Promise<void> {
  const toFetch = new Map<string, string>(); // key -> a representative original name
  for (const n of names) {
    const k = normKey(n);
    if (k && !resolved.has(k) && !pendingKeys.has(k) && !toFetch.has(k)) toFetch.set(k, n);
  }
  if (toFetch.size === 0) return;
  for (const k of toFetch.keys()) pendingKeys.add(k);
  try {
    const { cards } = await api.lookupCards([...toFetch.values()]);
    const index = new Map<string, Card>();
    for (const card of cards) {
      index.set(normKey(card.name), card);
      const front = card.name.split(' // ')[0];
      if (front) {
        const fk = normKey(front);
        if (!index.has(fk)) index.set(fk, card);
      }
    }
    for (const k of toFetch.keys()) resolved.set(k, index.get(k) ?? null);
  } catch {
    for (const k of toFetch.keys()) resolved.set(k, null);
  } finally {
    for (const k of toFetch.keys()) pendingKeys.delete(k);
  }
}

function cleanName(raw: string): string {
  return raw.trim().replace(/[’'`]s$/i, '').replace(/[.,:;!?]+$/, '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if the node sits somewhere we should not touch (already a card, code, or a link). */
function inSkippable(node: Node): boolean {
  const p = node.parentElement;
  return !p || !!p.closest('.cardref, code, a');
}

/**
 * Renders analysis markdown and makes card names visually distinct + hoverable.
 *
 * Primary path: when `cards` (the known deck) is supplied, every occurrence of a
 * known card name is wrapped — reliably, with no network calls, bolded or not.
 * Fallback path: any remaining **bold** token is fuzzy-looked-up so cards that
 * aren't in the deck (e.g. suggested additions) still resolve.
 */
export function Markdown({ text, streaming, cards }: { text: string; streaming?: boolean; cards?: Card[] }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ url: string; x: number; y: number } | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const [tick, setTick] = useState(0);

  const known = useMemo(() => {
    const map = new Map<string, Card>();
    for (const c of cards ?? []) if (!BASIC_NAMES.has(c.name)) map.set(c.name.toLowerCase(), c);
    return map;
  }, [cards]);

  const knownRe = useMemo(() => {
    if (known.size === 0) return null;
    const names = [...known.values()]
      .map((c) => c.name)
      .sort((a, b) => b.length - a.length) // longest first so "Lightning Bolt" beats "Bolt"
      .map(escapeRe);
    return new RegExp(`(?<![A-Za-z0-9])(?:${names.join('|')})(?![A-Za-z0-9])`, 'g');
  }, [known]);

  // Marking pass — re-runs as content streams in and as fuzzy lookups settle.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 1. Wrap every occurrence of a known deck card.
    if (knownRe) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const targets: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!inSkippable(node) && node.nodeValue && knownRe.test(node.nodeValue)) targets.push(node);
      }
      for (const node of targets) {
        const text = node.nodeValue ?? '';
        const frag = document.createDocumentFragment();
        let last = 0;
        knownRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = knownRe.exec(text)) !== null) {
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          const card = known.get(m[0].toLowerCase());
          const span = document.createElement('span');
          span.className = 'cardref';
          span.textContent = m[0];
          if (card?.imageUrl) span.dataset.img = card.imageUrl;
          frag.appendChild(span);
          last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode?.replaceChild(frag, node);
      }
    }

    // 2. Fallback: bolded names not already marked (Build/Recommend results,
    //    suggested additions). Collect the unresolved ones and resolve them in a
    //    single batch; mark the rest from cache.
    const unresolved: string[] = [];
    el.querySelectorAll('strong').forEach((strong) => {
      if (strong.querySelector('.cardref') || strong.classList.contains('cardref')) return;
      const name = cleanName(strong.textContent ?? '');
      if (!name || BASIC_NAMES.has(name)) return;
      const key = normKey(name);
      if (resolved.has(key)) {
        const card = resolved.get(key);
        if (card?.imageUrl) {
          strong.classList.add('cardref');
          (strong as HTMLElement).dataset.img = card.imageUrl;
        }
      } else {
        unresolved.push(name);
      }
    });
    if (unresolved.length > 0) void resolveNames(unresolved).then(() => setTick((t) => t + 1));
  }, [html, tick, knownRe, known]);

  // Hover preview, delegated; reads the image from whichever element carries it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onOver(e: MouseEvent) {
      const hit = (e.target as HTMLElement).closest('[data-img]') as HTMLElement | null;
      if (hit?.dataset.img) setPreview({ url: hit.dataset.img, x: pos.current.x + 16, y: pos.current.y + 16 });
    }
    function onMove(e: MouseEvent) {
      pos.current = { x: e.clientX, y: e.clientY };
      setPreview((p) => (p ? { ...p, x: e.clientX + 16, y: e.clientY + 16 } : p));
    }
    function onOut(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('[data-img]')) setPreview(null);
    }
    el.addEventListener('mouseover', onOver);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseout', onOut);
    return () => {
      el.removeEventListener('mouseover', onOver);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseout', onOut);
    };
  }, []);

  return (
    <>
      <div
        ref={ref}
        className={`md${streaming ? ' cursor' : ''}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {preview && (
        <img
          className="cardname__preview"
          src={preview.url}
          alt=""
          style={{ left: preview.x, top: preview.y }}
        />
      )}
    </>
  );
}
