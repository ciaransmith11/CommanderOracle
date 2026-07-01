import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { balanceResolvedDeck, categorise, parseDecklist } from '@commander-oracle/core';
import type { Card, CategorizedDeck } from '@commander-oracle/shared';
import { ENV, hasApiKey } from './env.js';
import type { ModelEvent } from './anthropic.js';
import { autocompleteCommanders, fetchCollection, namedCard, resolveEntries } from './scryfall.js';
import { analyseDeck, buildChat, chatDeck, proposeStrategies } from './analyse.js';
import { rulesChat } from './rules.js';
import { gatherCandidates, generateQueries, recommendStream } from './recommend.js';
import { sessions } from './db.js';

const app = new Hono();
app.use('/api/*', cors());

// Any uncaught error (e.g. the model API rejecting) becomes a JSON { error }
// with its real message, so the UI shows the actual cause, not "request failed".
app.onError((err, c) => {
  let message = err instanceof Error ? err.message : String(err);
  // Unwrap Anthropic-style "<status> {json...}" into the human-readable message.
  const inner = message.match(/"message":"([^"]+)"/);
  if (inner) message = inner[1]!;
  console.error('Request error:', message);
  return c.json({ error: message }, 500);
});

// --- Health ---------------------------------------------------------------

app.get('/api/health', (c) =>
  c.json({ ok: true, model: ENV.model, hasApiKey: hasApiKey() }),
);

// --- Single card lookup (for previews / hovers) ---------------------------

app.get('/api/card', async (c) => {
  const name = c.req.query('name');
  if (!name) return c.json({ error: 'missing name' }, 400);
  const card = await namedCard(name);
  if (!card) return c.json({ error: 'not found' }, 404);
  return c.json({ card });
});

// Commander name type-ahead suggestions (Scryfall only, no model/key needed).
app.get('/api/autocomplete', async (c) => {
  const names = await autocompleteCommanders(c.req.query('q') ?? '');
  return c.json({ names });
});

// Batch-resolve many card names in one go (collection endpoint, ≤75/request).
// Used by the UI to link every card name in a response without a request burst.
app.post('/api/cards', async (c) => {
  const { names } = await c.req.json<{ names?: string[] }>();
  if (!Array.isArray(names) || names.length === 0) return c.json({ cards: [] });
  const { cards } = await fetchCollection(names.slice(0, 150));
  return c.json({ cards });
});

// --- Phase 1: deterministic echo (no model) -------------------------------

/**
 * Parse + resolve + categorise a pasted decklist. Pure data, fast. An explicit
 * `commanderOverride` takes precedence over any commander parsed from the text.
 * The commander is part of the 100-card deck, so it is counted on top of the
 * pasted list (grandTotal = list entries + commander).
 */
async function echoFromText(text: string, commanderOverride?: string): Promise<CategorizedDeck> {
  const parsed = parseDecklist(text);
  const override = commanderOverride?.trim();
  const commanderNames = override ? [override] : parsed.commanders;

  const [{ items, unresolved }, commanderResult] = await Promise.all([
    resolveEntries(parsed.entries),
    commanderNames.length ? fetchCollection(commanderNames) : Promise.resolve({ cards: [], notFound: [] }),
  ]);
  return categorise(items, commanderResult.cards, [...unresolved, ...commanderResult.notFound]);
}

app.post('/api/echo', async (c) => {
  const { text, commander } = await c.req.json<{ text?: string; commander?: string }>();
  if (!text?.trim()) return c.json({ error: 'missing decklist text' }, 400);
  const deck = await echoFromText(text, commander);
  return c.json({ deck });
});

// --- Phase 2: streamed model analysis -------------------------------------

/** Stream an async text generator out as SSE `delta` events, then `done`. */
function sseFromGenerator(c: Context, gen: () => AsyncGenerator<string | ModelEvent>) {
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of gen()) {
        if (typeof chunk === 'string') {
          // JSON-encode so newlines in the markdown survive SSE framing.
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: chunk }) });
        } else if (chunk.type === 'status') {
          await stream.writeSSE({ event: 'status', data: JSON.stringify({ text: chunk.text }) });
        } else {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: chunk.text }) });
        }
      }
      await stream.writeSSE({ event: 'done', data: '{}' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) });
    }
  });
}

app.post('/api/analyse', async (c) => {
  if (!hasApiKey()) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
  const body = await c.req.json<{ deck?: CategorizedDeck }>();
  if (!body.deck) return c.json({ error: 'missing deck' }, 400);
  return sseFromGenerator(c, () => analyseDeck(body.deck!));
});

app.post('/api/chat', async (c) => {
  if (!hasApiKey()) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
  const body = await c.req.json<{
    deck?: CategorizedDeck;
    messages?: { role: 'user' | 'assistant'; content: string }[];
  }>();
  if (!body.deck || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'missing deck or messages' }, 400);
  }
  return sseFromGenerator(c, () => chatDeck(body.deck!, body.messages!));
});

app.post('/api/build/strategies', async (c) => {
  if (!hasApiKey()) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
  const body = await c.req.json<{ commander?: string }>();
  if (!body.commander?.trim()) return c.json({ error: 'missing commander' }, 400);

  const { cards } = await fetchCollection([body.commander]);
  const commander = cards[0];
  if (!commander) return c.json({ error: `commander not found: ${body.commander}` }, 404);

  const strategies = await proposeStrategies(commander);
  return c.json({ commander, strategies });
});

app.post('/api/rules', async (c) => {
  if (!hasApiKey()) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
  const body = await c.req.json<{ messages?: { role: 'user' | 'assistant'; content: string }[] }>();
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'missing messages' }, 400);
  }
  return sseFromGenerator(c, () => rulesChat(body.messages!));
});

app.post('/api/build', async (c) => {
  if (!hasApiKey()) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
  const body = await c.req.json<{
    commander?: string;
    strategy?: string;
    messages?: { role: 'user' | 'assistant'; content: string }[];
  }>();
  if (!body.commander?.trim() || !body.strategy?.trim()) {
    return c.json({ error: 'missing commander or strategy' }, 400);
  }

  const { cards } = await fetchCollection([body.commander]);
  const commander = cards[0];
  if (!commander) return c.json({ error: `commander not found: ${body.commander}` }, 404);

  return sseFromGenerator(c, () => buildChat(commander, body.strategy!, body.messages ?? []));
});

/**
 * Reconcile a proposed build decklist to exactly 100. Resolves the block
 * through Scryfall for REAL type lines, then balances land-aware: fills basics
 * only when the non-land count is healthy, and never inflates lands past the
 * 37–40 band (so an under-filled deck is flagged, not padded into a mana glut).
 */
app.post('/api/build/reconcile', async (c) => {
  const { text, colorIdentity } = await c.req.json<{ text?: string; colorIdentity?: string[] }>();
  if (!text?.trim()) return c.json({ error: 'missing decklist text' }, 400);

  const parsed = parseDecklist(text);
  const { items, unresolved } = await resolveEntries(parsed.entries);

  const resolvedEntries = items.map(({ qty, card }) => ({
    name: card.name,
    qty,
    isLand: /\bLand\b/.test(card.typeLine),
    edhrecRank: card.edhrecRank,
  }));
  // Names Scryfall couldn't find still occupy slots — count them as non-land.
  const qtyByName = new Map(parsed.entries.map((e) => [e.name.toLowerCase(), e.qty]));
  for (const name of unresolved) {
    resolvedEntries.push({ name, qty: qtyByName.get(name.toLowerCase()) ?? 1, isLand: false, edhrecRank: null });
  }

  const result = balanceResolvedDeck(resolvedEntries, colorIdentity ?? []);
  return c.json({ ...result, unresolved });
});

// --- Card recommendations (strategy/keyword → real Scryfall candidates) ----

app.post('/api/recommend', async (c) => {
  if (!hasApiKey()) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
  const body = await c.req.json<{ commander?: string; strategy?: string }>();
  if (!body.strategy?.trim()) return c.json({ error: 'missing strategy' }, 400);

  // Resolve the commander (if any) to constrain candidates to its colour identity.
  let commanderCard: Card | undefined;
  if (body.commander?.trim()) {
    const { cards } = await fetchCollection([body.commander]);
    commanderCard = cards[0];
  }

  const fragments = await generateQueries(body.strategy, commanderCard?.name);
  const { candidates, queries } = await gatherCandidates(fragments, commanderCard?.colorIdentity);

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'meta',
      data: JSON.stringify({ queries, candidateCount: candidates.length }),
    });

    if (candidates.length === 0) {
      await stream.writeSSE({
        event: 'delta',
        data: JSON.stringify({
          text: 'No Commander-legal cards matched those queries. Try rephrasing the strategy, or broaden the keyword.',
        }),
      });
      await stream.writeSSE({ event: 'done', data: '{}' });
      return;
    }

    try {
      for await (const chunk of recommendStream({ strategy: body.strategy!, commander: commanderCard, candidates })) {
        await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: chunk }) });
      }
      await stream.writeSSE({ event: 'done', data: '{}' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) });
    }
  });
});

// --- Sessions (sidebar persistence) ---------------------------------------

app.get('/api/sessions', (c) => c.json({ sessions: sessions.list() }));

app.post('/api/sessions', async (c) => {
  const { mode, title } = await c.req.json<{ mode?: string; title?: string }>();
  return c.json({ session: sessions.create(mode ?? 'analyse', title ?? 'New deck') });
});

app.get('/api/sessions/:id', (c) => {
  const session = sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'not found' }, 404);
  return c.json({ session });
});

app.patch('/api/sessions/:id', async (c) => {
  const { title, state } = await c.req.json<{ title?: string; state?: string }>();
  if (state != null) sessions.save(c.req.param('id'), title ?? 'Untitled', state);
  else if (title) sessions.rename(c.req.param('id'), title);
  return c.json({ ok: true });
});

app.delete('/api/sessions/:id', (c) => {
  sessions.remove(c.req.param('id'));
  return c.json({ ok: true });
});

// --- Start ----------------------------------------------------------------

serve({ fetch: app.fetch, port: ENV.port }, (info) => {
  console.log(`Commander Oracle server on http://localhost:${info.port}`);
  console.log(`Model: ${ENV.model} | API key: ${hasApiKey() ? 'present' : 'MISSING'}`);
});

export { app };
