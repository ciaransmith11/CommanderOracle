import { useState } from 'react';
import type { Card } from '@commander-oracle/shared';
import { CardPreview, faceUrls, placePreview } from './cardPreview.js';

/**
 * A card name rendered as a warm-amber link to its Scryfall page, with a hover
 * preview of the card image — BOTH faces for a double-faced card. Used in the
 * deck echo where we already have the full card data (no extra fetch).
 */
export function CardName({ card }: { card: Card }) {
  const urls = faceUrls(card);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <a
      className="cardname"
      href={card.scryfallUri ?? '#'}
      target="_blank"
      rel="noreferrer"
      onMouseMove={(e) => urls.length > 0 && setPos(placePreview(e.clientX, e.clientY, urls.length))}
      onMouseLeave={() => setPos(null)}
    >
      {card.name}
      {pos && <CardPreview urls={urls} x={pos.x} y={pos.y} />}
    </a>
  );
}
