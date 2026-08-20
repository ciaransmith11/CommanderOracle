import { useState, type CSSProperties } from 'react';
import { DeckProvider, useDeck, deckStats, accentForColors } from './deck.js';
import { AnalyzePane } from './Analyze.js';
import { BuildPane } from './Build.js';
import { RecommendPane } from './Recommend.js';
import { Advisor } from './Advisor.js';
import './dashboard.css';

/**
 * The redesigned split-pane shell: a persistent advisor sidebar + a main area
 * whose content switches by MODE. This is the scaffold — mode panes are empty
 * states for now; each is filled in a later phase. Rendered behind ?v2.
 */

type Mode = 'build' | 'analyze' | 'recommend' | 'rules';

const MODES: { id: Mode; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'recommend', label: 'Recommend' },
  { id: 'rules', label: 'Rules' },
];

export function DashboardShell() {
  return (
    <DeckProvider>
      <ShellInner />
    </DeckProvider>
  );
}

function ShellInner() {
  const [mode, setMode] = useState<Mode>('build');
  const { commander, cards } = useDeck();
  // The whole shell's accent shifts subtly with the deck's colour identity.
  const accent = accentForColors(deckStats(cards, commander).colors);

  return (
    <div className="dash" style={{ '--accent': accent } as CSSProperties}>
        <header className="dash__topbar">
          <div className="dash__brand">
            <img className="dash__logo" src="/deckromancer_icon_crop.png" alt="" />
            <span className="dash__wordmark">Deckromancer</span>
          </div>
          <nav className="dash__modes" role="tablist" aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={mode === m.id}
                className={`dash__mode${mode === m.id ? ' dash__mode--active' : ''}`}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </nav>
        </header>

        <div className="dash__body">
          <main className="dash__main">
            <ModeMain mode={mode} />
          </main>
          <Advisor mode={mode} />
        </div>
    </div>
  );
}

function ModeMain({ mode }: { mode: Mode }) {
  switch (mode) {
    case 'build':
      return <BuildPane />;
    case 'analyze':
      return <AnalyzePane />;
    case 'recommend':
      return <RecommendPane />;
    case 'rules':
      return (
        <EmptyState
          title="Rules & interactions"
          body="Ask any Magic rules question. Answers are grounded in real card text, cite the Comprehensive Rules, and show the cards involved right beside the explanation."
          hint="Rules lives in the advisor — the chat is the main surface here."
        />
      );
  }
}

function EmptyState({ title, body, hint }: { title: string; body: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty__card">
        <h2 className="empty__title">{title}</h2>
        <p className="empty__body">{body}</p>
        {hint && <p className="empty__hint">{hint}</p>}
      </div>
    </div>
  );
}

