const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/** The five mana pips shown in the header — colour dots only, no letters. */
export function HeaderPips() {
  return (
    <div className="pips" aria-label="WUBRG colour identity">
      {COLORS.map((c) => (
        <span key={c} className={`pip pip--${c}`} aria-hidden="true" />
      ))}
    </div>
  );
}

/** Small inline pips for a card's colour identity (C when colourless). */
export function ColorPips({ identity }: { identity: string[] }) {
  const pips = identity.length ? identity : ['C'];
  return (
    <>
      {pips.map((c, i) => (
        <span key={`${c}-${i}`} className={`pip pip--sm pip--${c}`}>
          {c}
        </span>
      ))}
    </>
  );
}
