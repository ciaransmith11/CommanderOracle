import type { CardEntry, ParsedDecklist } from '@commander-oracle/shared';

/**
 * Pure decklist parser. Turns raw pasted text into `{ qty, name }` entries plus
 * detected commander(s). No network, no model — counting and parsing are
 * deterministic operations and belong here (handoff §2, §7).
 *
 * Handles the formats players actually paste:
 *   - `1 Sol Ring`, `1x Sol Ring`, `Sol Ring`, `14x Plains` (14 cards, not 1)
 *   - set-code / collector suffixes: `1 Sol Ring (C21) 263`, `... 263 *F*`
 *   - section headers to skip: Commander, Creatures, Lands, Deck, Sideboard, ...
 *   - commander markers: a `Commander` header, or inline `*CMDR*`, `(Commander)`,
 *     `[Commander]`
 *
 * Commander extraction is a known footgun: we strip quantity prefixes AND
 * set-code suffixes before matching, and never naively cut everything after the
 * first `(` — that would truncate names like "Jon Irenicus, Shattered One"
 * (which has no paren) or any future name containing one.
 */

/** Words that, on their own, denote a section header rather than a card. */
const SECTION_HEADERS: ReadonlySet<string> = new Set([
  'commander',
  'commanders',
  'companion',
  'creature',
  'creatures',
  'land',
  'lands',
  'instant',
  'instants',
  'sorcery',
  'sorceries',
  'artifact',
  'artifacts',
  'enchantment',
  'enchantments',
  'planeswalker',
  'planeswalkers',
  'battle',
  'battles',
  'deck',
  'mainboard',
  'maindeck',
  'sideboard',
  'maybeboard',
  'spells',
  'tokens',
  'token',
  'other',
]);

const COMMANDER_HEADERS: ReadonlySet<string> = new Set(['commander', 'commanders']);

interface ParsedLine {
  qty: number;
  name: string;
  isCommander: boolean;
}

export function parseDecklist(text: string): ParsedDecklist {
  const entries: CardEntry[] = [];
  const commanders: string[] = [];
  // Tracks whether we are inside a `Commander` section. Reset by a blank line
  // or by any non-commander header, so a missing "Deck" header doesn't swallow
  // the whole list into the commander bucket.
  let inCommanderSection = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      inCommanderSection = false;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#')) continue;

    const header = matchHeader(line);
    if (header) {
      inCommanderSection = COMMANDER_HEADERS.has(header);
      continue;
    }

    const parsed = parseCardLine(line);
    if (!parsed) continue;

    if (parsed.isCommander || inCommanderSection) {
      // Commander copies are always singletons; quantity is irrelevant.
      if (!commanders.includes(parsed.name)) commanders.push(parsed.name);
    } else {
      mergeEntry(entries, parsed.qty, parsed.name);
    }
  }

  return { entries, commanders };
}

/** Detect a bare section header like `Creatures`, `Creatures (30)`, `Deck:`. */
function matchHeader(line: string): string | null {
  const normalized = line
    .replace(/\(\d+\)\s*$/, '') // trailing "(30)" count
    .replace(/:\s*$/, '') // trailing colon
    .trim()
    .toLowerCase();
  return SECTION_HEADERS.has(normalized) ? normalized : null;
}

/** Parse one card line into qty / name / commander flag, or null if unusable. */
function parseCardLine(line: string): ParsedLine | null {
  let s = line;
  let isCommander = false;

  // 1. Inline commander markers (detected before any stripping so `*CMDR*`
  //    isn't mistaken for a foil marker, and removed from the name).
  if (/\*CMDR\*/i.test(s) || /[([]commander[)\]]/i.test(s)) {
    isCommander = true;
    s = s.replace(/\*CMDR\*/gi, '').replace(/[([]commander[)\]]/gi, '');
  }

  // 2. Quantity prefix: "1 ", "1x ", "14x ". Defaults to 1 when absent.
  let qty = 1;
  const qtyMatch = s.match(/^(\d+)\s*[xX]?\s+(.+)$/);
  if (qtyMatch) {
    qty = Number.parseInt(qtyMatch[1]!, 10);
    s = qtyMatch[2]!;
  }

  // 3. Trailing foil/etched markers: " *F*", " *E*" (possibly repeated).
  s = s.replace(/(?:\s*\*[A-Za-z]+\*)+\s*$/, '');

  // 4. Set-code + collector suffix: " (C21) 263", " (MH2)", " (2X2) 12p".
  //    The set code is short and space-free, so this won't touch names whose
  //    own parenthetical contains spaces (e.g. "B.F.M. (Big Furry Monster)").
  s = s.replace(/\s+\([0-9A-Za-z]{1,6}\)(?:\s+[0-9A-Za-z★]+)?\s*$/, '');

  s = s.trim();
  if (!s || qty <= 0) return null;

  return { qty, name: s, isCommander };
}

/** Merge a card into the list, summing quantities for duplicate names. */
function mergeEntry(entries: CardEntry[], qty: number, name: string): void {
  const existing = entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.qty += qty;
  else entries.push({ qty, name });
}
