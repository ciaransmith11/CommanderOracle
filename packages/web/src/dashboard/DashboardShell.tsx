import { useState } from 'react';
import { DeckProvider } from './deck.js';
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
  const [mode, setMode] = useState<Mode>('build');

  return (
    <DeckProvider>
      <div className="dash">
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
          <AdvisorSidebar mode={mode} />
        </div>
      </div>
    </DeckProvider>
  );
}

function ModeMain({ mode }: { mode: Mode }) {
  switch (mode) {
    case 'build':
      return (
        <EmptyState
          title="Build a deck"
          body="Name a commander and the advisor will walk you through distinct ways to build it. Once a decklist takes shape, it appears here as a live dashboard — stats, curve, and the full card grid."
          hint="Coming next: commander picker → strategy directions."
        />
      );
    case 'analyze':
      return (
        <EmptyState
          title="Analyze a deck"
          body="Paste a decklist to see its mana curve, colour identity, and deck-health at a glance, with the full card grid below — and apply the advisor's suggested swaps in one click."
          hint="Coming next: paste box → stats row → card grid."
        />
      );
    case 'recommend':
      return (
        <EmptyState
          title="Find cards"
          body="Describe a strategy (and optionally a commander) to get real, on-colour card suggestions — grouped by role like ramp, removal, and payoffs — that you can add straight to a deck."
          hint="Coming next: strategy box → role-grouped card grid."
        />
      );
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

function AdvisorSidebar({ mode }: { mode: Mode }) {
  return (
    <aside className="advisor" aria-label="Advisor">
      <div className="advisor__head">
        <span className="advisor__title">Advisor</span>
        <span className="advisor__mode">{mode}</span>
      </div>
      <div className="advisor__feed">
        <div className="advisor__placeholder">
          The advisor stays with you across every mode. It'll analyze, suggest swaps, find cards, and answer
          rules questions here.
        </div>
      </div>
      <form className="advisor__composer" onSubmit={(e) => e.preventDefault()}>
        <input className="advisor__input" placeholder="Ask the advisor…" disabled />
        <button className="advisor__send" type="submit" aria-label="Send" disabled>
          ↑
        </button>
      </form>
    </aside>
  );
}
