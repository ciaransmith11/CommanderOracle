import type { Card } from '@commander-oracle/shared';

/**
 * Shared hover-preview: shows a card image (BOTH faces for a double-faced card)
 * and keeps the popup fully on-screen, flipping/clamping near the edges so it is
 * never cut off at the bottom or right of the window.
 */

const RATIO = 0.716; // Scryfall "normal" image aspect (width / height)
const SINGLE_W = 220;
const MULTI_W = 188; // per face when two are shown side by side
const GAP = 6;
const MARGIN = 12;
const CURSOR_OFFSET = 16;

/** Image URLs to preview for a card: each face for a DFC, else the single image. */
export function faceUrls(card: Card): string[] {
  if (card.faces && card.faces.length >= 2) {
    const urls = card.faces
      .map((f) => f.imageUrl ?? card.imageUrl)
      .filter((u): u is string => !!u);
    if (urls.length) return urls;
  }
  return card.imageUrl ? [card.imageUrl] : [];
}

/** Position the preview near the cursor but clamped so it stays fully in the viewport. */
export function placePreview(cx: number, cy: number, faceCount: number): { x: number; y: number } {
  const imgW = faceCount > 1 ? MULTI_W : SINGLE_W;
  const w = faceCount > 1 ? imgW * faceCount + GAP * (faceCount - 1) : imgW;
  const h = Math.round(imgW / RATIO);

  let x = cx + CURSOR_OFFSET;
  let y = cy + CURSOR_OFFSET;

  // Flip to the left of the cursor if it would overflow the right edge.
  if (x + w + MARGIN > window.innerWidth) x = cx - CURSOR_OFFSET - w;
  x = Math.max(MARGIN, x);

  // Lift it up so the bottom never runs off-screen (the reported cutoff).
  if (y + h + MARGIN > window.innerHeight) y = window.innerHeight - h - MARGIN;
  y = Math.max(MARGIN, y);

  return { x, y };
}

export function CardPreview({ urls, x, y }: { urls: string[]; x: number; y: number }) {
  if (urls.length === 0) return null;
  return (
    <div className={`cardpreview${urls.length > 1 ? ' cardpreview--multi' : ''}`} style={{ left: x, top: y }}>
      {urls.map((u, i) => (
        <img key={i} src={u} alt="" />
      ))}
    </div>
  );
}
