import { HeaderPips } from './ManaPips.js';

export function Header({ hasApiKey }: { hasApiKey?: boolean }) {
  return (
    <header className="header">
      <div className="header__inner">
        <div>
          <h1 className="header__title">COMMANDER ORACLE</h1>
          <div className="header__subtitle">
            EDH Deck Advisor{hasApiKey === false ? ' · ⚠ no API key' : ''}
          </div>
        </div>
        <HeaderPips />
      </div>
    </header>
  );
}
