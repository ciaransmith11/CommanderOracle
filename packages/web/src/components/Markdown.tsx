import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '@commander-oracle/shared';
import { api } from '../api.js';
import { CardPreview, faceUrls, placePreview } from './cardPreview.js';

marked.setOptions({ gfm: true, breaks: false });

// Basic-land names double as ordinary English words ("Island", "Mountain"), so
// we never auto-mark them to avoid false hits in prose.
const BASIC_NAMES = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest', 'Snow-Covered Wastes',
]);

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanName(raw: string): string {
  return raw.trim().replace(/[’'`]s$/i, '').replace(/[.,:;!?]+$/, '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Index a card by every name it can be referenced by (full name, front-face name,
 * and each face name) → the image(s) to preview. For a double-faced card that's
 * BOTH faces (pipe-joined), so hovering any of its names shows the correct face.
 */
function indexCard(map: Map<string, string | null>, card: Card): void {
  const imgs = faceUrls(card).join('|') || null;
  map.set(normKey(card.name), imgs);
  const front = card.name.split(' // ')[0];
  if (front) {
    const k = normKey(front);
    if (!map.has(k)) map.set(k, imgs);
  }
  for (const face of card.faces ?? []) map.set(normKey(face.name), imgs);
}

// Session-wide cache of name→image for names NOT in a known deck list
// (Build/Recommend results, follow-up additions).
const resolved = new Map<string, string | null>();
const pendingKeys = new Set<string>();

/**
 * Resolve names in a single BATCH via the collection endpoint, then fall back to
 * a fuzzy lookup for the few stragglers the collection couldn't match exactly
 * (odd spellings, accents, back-face names). Populates `resolved`.
 */
async function resolveNames(names: string[]): Promise<void> {
  const want = new Map<string, string>(); // key -> representative original name
  for (const n of names) {
    const k = normKey(n);
    if (k && !resolved.has(k) && !pendingKeys.has(k) && !want.has(k)) want.set(k, n);
  }
  if (want.size === 0) return;
  for (const k of want.keys()) pendingKeys.add(k);

  try {
    const { cards } = await api.lookupCards([...want.values()]);
    for (const card of cards) indexCard(resolved, card);

    // Fuzzy fallback for the stragglers, one at a time (few, so no burst).
    for (const [k, name] of want) {
      if (resolved.has(k)) continue;
      const card = await api.lookupCard(name).then((r) => r.card).catch(() => null);
      if (card) {
        indexCard(resolved, card);
        if (!resolved.has(k)) resolved.set(k, card.imageUrl);
      } else {
        resolved.set(k, null);
      }
    }
  } catch {
    for (const k of want.keys()) if (!resolved.has(k)) resolved.set(k, null);
  } finally {
    for (const k of want.keys()) pendingKeys.delete(k);
  }
}

function inSkippable(node: Node): boolean {
  const p = node.parentElement;
  return !p || !!p.closest('.cardref, code, a');
}

/**
 * Renders analysis markdown and makes card names visually distinct + hoverable.
 *
 * Known-deck fast path: when `cards` is supplied, every occurrence of a known
 * card name (or face name) is wrapped instantly, no network. Fallback: bolded
 * names not in the deck are batch-resolved (with a fuzzy pass for stragglers).
 * Double-faced cards index each face name to that face's image.
 */
export function Markdown({ text, streaming, cards }: { text: string; streaming?: boolean; cards?: Card[] }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ url: string; x: number; y: number } | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const [tick, setTick] = useState(0);

  // Known deck names (full + front + face) → image, plus the original-case names
  // for the matching regex.
  const { knownImg, knownNames } = useMemo(() => {
    const img = new Map<string, string | null>();
    const names: string[] = [];
    const add = (nm: string, image: string | null) => {
      const k = normKey(nm);
      if (k && !img.has(k)) {
        img.set(k, image);
        names.push(nm);
      }
    };
    for (const c of cards ?? []) {
      if (BASIC_NAMES.has(c.name)) continue;
      const imgs = faceUrls(c).join('|') || null; // BOTH faces for a DFC
      add(c.name, imgs);
      const front = c.name.split(' // ')[0];
      if (front && front !== c.name) add(front, imgs);
      for (const f of c.faces ?? []) add(f.name, imgs);
    }
    return { knownImg: img, knownNames: names };
  }, [cards]);

  const knownRe = useMemo(() => {
    if (knownNames.length === 0) return null;
    const alt = [...knownNames].sort((a, b) => b.length - a.length).map(escapeRe);
    return new RegExp(`(?<![A-Za-z0-9])(?:${alt.join('|')})(?![A-Za-z0-9])`, 'g');
  }, [knownNames]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 1. Wrap every occurrence of a known deck card / face name.
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
          const image = knownImg.get(normKey(m[0]));
          const span = document.createElement('span');
          span.className = 'cardref';
          span.textContent = m[0];
          if (image) span.dataset.img = image;
          frag.appendChild(span);
          last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode?.replaceChild(frag, node);
      }
    }

    // 2. Fallback: bolded names not already marked, resolved in one batch.
    const unresolved: string[] = [];
    el.querySelectorAll('strong').forEach((strong) => {
      if (strong.querySelector('.cardref') || strong.classList.contains('cardref')) return;
      const name = cleanName(strong.textContent ?? '');
      if (!name || BASIC_NAMES.has(name)) return;
      const image = resolved.get(normKey(name));
      if (image !== undefined) {
        if (image) {
          strong.classList.add('cardref');
          (strong as HTMLElement).dataset.img = image;
        }
      } else {
        unresolved.push(name);
      }
    });
    if (unresolved.length > 0) void resolveNames(unresolved).then(() => setTick((t) => t + 1));
  }, [html, tick, knownRe, knownImg]);

  // Hover preview, delegated; reads the image from whichever element carries it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onOver(e: MouseEvent) {
      const hit = (e.target as HTMLElement).closest('[data-img]') as HTMLElement | null;
      if (hit?.dataset.img) {
        const url = hit.dataset.img;
        setPreview({ url, ...placePreview(pos.current.x, pos.current.y, url.split('|').length) });
      }
    }
    function onMove(e: MouseEvent) {
      pos.current = { x: e.clientX, y: e.clientY };
      setPreview((p) => (p ? { ...p, ...placePreview(e.clientX, e.clientY, p.url.split('|').length) } : p));
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
      {preview && <CardPreview urls={preview.url.split('|')} x={preview.x} y={preview.y} />}
    </>
  );
}
