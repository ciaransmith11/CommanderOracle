import { useState } from 'react';
import { HeaderPips } from './ManaPips.js';

const HEADER_ART_COUNT = 5;

export function Header({ hasApiKey }: { hasApiKey?: boolean }) {
  // Pick one artwork per page load (stable for the life of the mount).
  const [art] = useState(() => Math.floor(Math.random() * HEADER_ART_COUNT) + 1);
  const style = { '--header-art': `url(/header-art_${art}.jpg)` } as React.CSSProperties;

  return (
    <header className="header" style={style}>
      <div className="header__inner">
        <div className="header__brand">
          <img className="header__icon" src="/deckromancer_icon_crop.png" alt="" />
          <div>
            <h1 className="header__title">DECKROMANCER</h1>
            <div className="header__subtitle">
              EDH Deck Advisor{hasApiKey === false ? ' · ⚠ no API key' : ''}
            </div>
          </div>
        </div>
        <HeaderPips />
      </div>
    </header>
  );
}
