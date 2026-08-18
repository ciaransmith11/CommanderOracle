import type { Card, CategorizedCard } from '@commander-oracle/shared';
import { deckStats } from './deck.js';

/**
 * The three-card stats row. All values derive from deck state via deckStats(),
 * so adding/removing a card updates them live.
 */
export function StatsRow({ cards, commander }: { cards: CategorizedCard[]; commander: Card | null }) {
  const stats = deckStats(cards, commander);
  return (
    <div className="statsrow">
      <ManaCurveCard stats={stats} />
      <ColorIdentityCard stats={stats} />
      <DeckHealthCard stats={stats} />
    </div>
  );
}

function ManaCurveCard({ stats }: { stats: ReturnType<typeof deckStats> }) {
  const max = Math.max(1, ...stats.curve.map((b) => b.count));
  return (
    <div className="stat">
      <div className="stat__label">Mana curve</div>
      <div className="curve">
        {stats.curve.map((b) => (
          <div className="curve__col" key={b.label}>
            <div className="curve__bar-wrap">
              <div
                className="curve__bar"
                style={{ height: `${(b.count / max) * 100}%` }}
                title={`${b.count} at ${b.label}`}
              />
            </div>
            <div className="curve__n">{b.count || ''}</div>
            <div className="curve__x">{b.label}</div>
          </div>
        ))}
      </div>
      <div className="stat__foot">avg MV {stats.avgCmc || '—'}</div>
    </div>
  );
}

const PIP_BG: Record<string, string> = {
  W: '#c8b878',
  U: '#1558a0',
  B: '#2a2730',
  R: '#921a0a',
  G: '#145c28',
};

function ColorIdentityCard({ stats }: { stats: ReturnType<typeof deckStats> }) {
  const wubrg = ['W', 'U', 'B', 'R', 'G'];
  return (
    <div className="stat">
      <div className="stat__label">Colour identity</div>
      <div className="colors">
        {wubrg.map((c) => {
          const on = stats.colors.includes(c);
          return (
            <div
              key={c}
              className={`colors__pip${on ? '' : ' colors__pip--off'}`}
              style={on ? { background: PIP_BG[c] } : undefined}
              title={`${c}: ${stats.colorCounts[c] ?? 0} cards`}
            >
              {on ? stats.colorCounts[c] ?? 0 : ''}
            </div>
          );
        })}
      </div>
      <div className="stat__foot">
        {stats.colors.length === 0
          ? 'colourless'
          : stats.colors.length === 1
            ? 'mono'
            : `${stats.colors.length}-colour`}
      </div>
    </div>
  );
}

/**
 * A deterministic health read from land count + curve. (Role-aware notes like
 * "ramp light" need the advisor; this is the at-a-glance version.)
 */
function deckHealth(stats: ReturnType<typeof deckStats>): { score: number; callout: string } {
  const notes: { penalty: number; msg: string }[] = [];

  if (stats.total >= 90) {
    if (stats.lands < 36) notes.push({ penalty: 18, msg: `${stats.lands} lands — a touch low (aim 37–40)` });
    else if (stats.lands > 41) notes.push({ penalty: 12, msg: `${stats.lands} lands — running heavy (aim 37–40)` });
  }
  if (stats.avgCmc >= 3.8) notes.push({ penalty: 15, msg: `curve runs heavy (avg MV ${stats.avgCmc})` });
  else if (stats.avgCmc > 0 && stats.avgCmc <= 2.2) notes.push({ penalty: 6, msg: `very low curve (avg MV ${stats.avgCmc})` });
  if (stats.total > 0 && stats.total < 100) notes.push({ penalty: 20, msg: `${stats.total}/100 cards — deck incomplete` });
  if (stats.total > 100) notes.push({ penalty: 20, msg: `${stats.total}/100 cards — over the limit` });

  notes.sort((a, b) => b.penalty - a.penalty);
  const score = Math.max(0, 100 - notes.reduce((n, x) => n + x.penalty, 0));
  const callout = notes[0]?.msg ?? 'looks well-balanced';
  return { score, callout };
}

function DeckHealthCard({ stats }: { stats: ReturnType<typeof deckStats> }) {
  const { score, callout } = deckHealth(stats);
  const tier = score >= 80 ? 'good' : score >= 55 ? 'ok' : 'low';
  return (
    <div className="stat">
      <div className="stat__label">Deck health</div>
      <div className={`health health--${tier}`}>
        <span className="health__score">{score}</span>
        <span className="health__of">/100</span>
      </div>
      <div className="stat__foot health__callout">{callout}</div>
    </div>
  );
}
