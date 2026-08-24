import type { Card, DeckRole } from '@commander-oracle/shared';

/**
 * A recommendation rendered as an actionable card — stronger treatment (accent
 * border) than a grid tile so it reads as "wants your attention". Used for
 * advisor swap suggestions: replace `cut` with `add`, Apply / Dismiss.
 */
export function SuggestionCard({
  add,
  cut,
  reason,
  role,
  onApply,
  onDismiss,
}: {
  add: Card;
  cut: string;
  reason: string;
  role?: DeckRole;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const art = add.artCrop ?? add.imageUrl ?? null;
  return (
    <div className="sugg">
      <div className="sugg__art">
        {art ? <img src={art} alt="" loading="lazy" /> : <div className="tile__art-fallback">{add.name}</div>}
      </div>
      <div className="sugg__body">
        <div className="sugg__swap">
          <span className="sugg__add">{add.name}</span>
          {role && <span className="sugg__role">{role}</span>}
          <span className="sugg__for">
            in for <span className="sugg__cut">{cut}</span>
          </span>
        </div>
        <div className="sugg__reason">{reason}</div>
        <div className="sugg__actions">
          <button className="sugg__apply" onClick={onApply} type="button">
            Apply
          </button>
          <button className="sugg__dismiss" onClick={onDismiss} type="button">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
