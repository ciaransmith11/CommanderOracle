import { useState } from 'react';
import type { Card } from '@commander-oracle/shared';

/**
 * A card name rendered as a warm-amber link to its Scryfall page, with a hover
 * preview of the card image. Used in the deck echo where we already have the
 * full card data (no extra fetch).
 */
export function CardName({ card }: { card: Card }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <a
      className="cardname"
      href={card.scryfallUri ?? '#'}
      target="_blank"
      rel="noreferrer"
      onMouseMove={(e) => card.imageUrl && setPos({ x: e.clientX + 16, y: e.clientY + 16 })}
      onMouseLeave={() => setPos(null)}
    >
      {card.name}
      {pos && card.imageUrl && (
        <img
          className="cardname__preview"
          src={card.imageUrl}
          alt={card.name}
          style={{ left: pos.x, top: pos.y }}
        />
      )}
    </a>
  );
}
