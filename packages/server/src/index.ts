import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { categorise, parseDecklist } from '@commander-oracle/core';
import type { Card, CategorizedDeck } from '@commander-oracle/shared';
import { ENV, hasApiKey } from './env.js';
import { fetchCollection, namedCard, resolveEntries } from './scryfall.js';
import { analyseDeck, buildAdvice, chatDeck, proposeStrategies } from './analyse.js';
import { gatherCandidates, generateQueries, recommendStream } from './recommend.js';
import { messages, sessions } from './db.js';

const app = new Hono();
app.use('/api/*', cors());

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
function sseFromGenerator(c: Context, gen: () => AsyncGenerator<string>) {
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of gen()) {
        // JSON-encode so newlines in the markdown survive SSE framing.
        await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: chunk }) });
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

app.post('/api/build', async (c) => {
  if (!hasApiKey()) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
  const body = await c.req.json<{ commander?: string; strategy?: string }>();

  let commanderCard: Card | undefined;
  if (body.commander?.trim()) {
    const { cards } = await fetchCollection([body.commander]);
    commanderCard = cards[0];
  }
  return sseFromGenerator(c, () => buildAdvice({ commander: commanderCard, strategy: body.strategy }));
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
  return c.json({ session, messages: messages.list(session.id) });
});

app.patch('/api/sessions/:id', async (c) => {
  const { title } = await c.req.json<{ title?: string }>();
  if (title) sessions.rename(c.req.param('id'), title);
  return c.json({ ok: true });
});

app.delete('/api/sessions/:id', (c) => {
  sessions.remove(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/messages', async (c) => {
  const { role, content } = await c.req.json<{ role?: string; content?: string }>();
  if (!role || content == null) return c.json({ error: 'missing role/content' }, 400);
  return c.json({ message: messages.add(c.req.param('id'), role, content) });
});

// --- Start ----------------------------------------------------------------

serve({ fetch: app.fetch, port: ENV.port }, (info) => {
  console.log(`Commander Oracle server on http://localhost:${info.port}`);
  console.log(`Model: ${ENV.model} | API key: ${hasApiKey() ? 'present' : 'MISSING'}`);
});

export { app };
