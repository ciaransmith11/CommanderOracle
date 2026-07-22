import Anthropic from '@anthropic-ai/sdk';
import { ENV } from './env.js';

/**
 * Thin Anthropic client wrapper. The API key lives only on the server. The
 * doctrine system prompt is cache-controlled by the caller (see prompt.ts), so
 * repeated analyses hit the prompt cache.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!ENV.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot call the model.');
  }
  // maxRetries covers retryable failures on the initial request; the streaming
  // wrapper below additionally retries errors that surface mid-handshake.
  if (!client) client = new Anthropic({ apiKey: ENV.anthropicApiKey, maxRetries: 3 });
  return client;
}

const MAX_STREAM_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient failures worth retrying: overloaded, rate-limit, timeouts, 5xx,
 * connection drops. Handles both HTTP-level errors (which carry a numeric
 * status) and mid-stream error EVENTS (HTTP 200 then an `api_error` payload,
 * which have no status — so we also match on the error type / message text).
 */
export function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; name?: string; error?: { type?: string }; message?: string } | null;

  const status = e?.status;
  if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500;

  const type = e?.error?.type;
  if (type === 'api_error' || type === 'overloaded_error' || type === 'rate_limit_error') return true;

  const name = e?.name;
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;

  const msg = typeof e?.message === 'string' ? e.message : '';
  return /api_error|overloaded|rate_limit|internal server error/i.test(msg);
}

export interface StreamOptions {
  systemBlocks: Anthropic.Messages.TextBlockParam[];
  messages: Anthropic.Messages.MessageParam[];
  maxTokens?: number;
}

/**
 * Stream a model response as text chunks. Decouples the rest of the server from
 * the SDK's event shape — callers just consume strings.
 *
 * Retries transient failures (overloaded / 5xx / connection drops) with backoff,
 * but ONLY when the error occurs before any text has been emitted — once we've
 * yielded a chunk, retrying would duplicate output, so the error propagates.
 */
export async function* streamModel(opts: StreamOptions): AsyncGenerator<string> {
  for (let attempt = 1; ; attempt++) {
    let emitted = false;
    try {
      const stream = getClient().messages.stream({
        model: ENV.model,
        max_tokens: opts.maxTokens ?? ENV.maxTokens,
        system: opts.systemBlocks,
        messages: opts.messages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          emitted = true;
          yield event.delta.text;
        }
      }
      return;
    } catch (err) {
      if (emitted || attempt >= MAX_STREAM_ATTEMPTS || !isRetryable(err)) throw err;
      const delay = 500 * 2 ** (attempt - 1); // 500ms, 1000ms
      console.warn(`model stream attempt ${attempt} failed (${describeError(err)}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function describeError(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  return status ? `${status} ${message}` : message;
}

export interface ToolStreamOptions extends StreamOptions {
  tools: Anthropic.Tool[];
  /** Executes a tool call and returns its result text. */
  runTool: (name: string, input: unknown) => Promise<string>;
  /** Safety cap on tool round-trips. */
  maxTurns?: number;
  /**
   * Optional check for whether a produced answer is genuinely COMPLETE (vs. a
   * "let me gather more…" preamble). When it rejects the answer, the model is
   * forced to finish rather than have the stall surfaced as the result.
   */
  finalGuard?: (text: string) => boolean;
}

/** A status update describes silent background work; text is final answer content. */
export type ModelEvent = { type: 'status'; text: string } | { type: 'text'; text: string };

// Detects a "let me go do something" preamble — the model announcing it will
// search/find/look up cards but ending its turn WITHOUT calling the tool. We look
// only at the tail (a real answer ends with content, not with intent-to-act).
const STALL_RE =
  /\b(let me|i'?ll|i will|let'?s|i'?m going to|now,? i'?ll|allow me to)\b[^.?!\n]{0,90}\b(search|find|look up|look for|gather|pull up|fetch|verify|get you|dig up|source|track down|identify)\b/i;

function looksLikeToolPreamble(text: string): boolean {
  return STALL_RE.test(text.trim().slice(-240));
}

/** A short human label for what a turn's tool calls are doing (shown live in the UI). */
function describeToolBatch(blocks: Anthropic.Messages.ContentBlock[]): string {
  const toolUses = blocks.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
  const first = toolUses[0];
  let label = 'Searching Scryfall';
  if (first?.name === 'get_card') {
    const name = (first.input as { name?: string } | null)?.name;
    label = name ? `Checking ${name}` : 'Checking a card';
  }
  return toolUses.length > 1 ? `${label} (+${toolUses.length - 1} more)…` : `${label}…`;
}

/**
 * Stream one model turn, yielding text and returning the final message.
 * `tools` is passed per-turn so the final turn can omit them, forcing a text answer.
 */
async function* streamTurn(
  messages: Anthropic.Messages.MessageParam[],
  opts: ToolStreamOptions,
  forceAnswer: boolean,
): AsyncGenerator<string, Anthropic.Messages.Message> {
  for (let attempt = 1; ; attempt++) {
    let emitted = false;
    try {
      // Always keep the tool definitions present (the message history references
      // them); `tool_choice: none` is how we force a text answer on the final
      // turn — omitting tools entirely makes the model return an empty turn.
      const stream = getClient().messages.stream({
        model: ENV.model,
        max_tokens: opts.maxTokens ?? ENV.maxTokens,
        system: opts.systemBlocks,
        tools: opts.tools,
        tool_choice: forceAnswer ? { type: 'none' } : { type: 'auto' },
        messages,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          emitted = true;
          yield event.delta.text;
        }
      }
      return await stream.finalMessage();
    } catch (err) {
      if (emitted || attempt >= MAX_STREAM_ATTEMPTS || !isRetryable(err)) throw err;
      const delay = 500 * 2 ** (attempt - 1);
      console.warn(`model stream attempt ${attempt} failed (${describeError(err)}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/** Run a turn to completion WITHOUT streaming its text (used for the silent gather phase). */
async function runTurnSilently(
  messages: Anthropic.Messages.MessageParam[],
  opts: ToolStreamOptions,
): Promise<{ text: string; message: Anthropic.Messages.Message }> {
  const gen = streamTurn(messages, opts, false);
  let text = '';
  let next = await gen.next();
  while (!next.done) {
    text += next.value;
    next = await gen.next();
  }
  return { text, message: next.value };
}

/**
 * Stream a model response that may call tools, but only ever surface the FINAL
 * answer to the caller. Tool calls and the model's intermediate "thinking"
 * (e.g. "let me search…") run SILENTLY server-side; the caller streams nothing
 * during that time (the UI shows a thinking indicator), then receives only the
 * finished result. This prevents narration leaking and prevents a stalled
 * intermediate turn from being mistaken for the answer.
 */
export async function* streamModelWithTools(opts: ToolStreamOptions): AsyncGenerator<ModelEvent> {
  const messages: Anthropic.Messages.MessageParam[] = [...opts.messages];
  const maxToolTurns = opts.maxTurns ?? 6;

  let usedTools = false;
  let lastText = '';

  // Gather phase — silent except for live status updates.
  for (let turn = 0; turn < maxToolTurns; turn++) {
    const { text, message } = await runTurnSilently(messages, opts);
    lastText = text;
    messages.push({ role: 'assistant', content: message.content as unknown as Anthropic.Messages.ContentBlockParam[] });

    if (message.stop_reason === 'tool_use') {
      usedTools = true;
      yield { type: 'status', text: describeToolBatch(message.content) };

      const toolResults: Anthropic.Messages.ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          let result: string;
          try {
            result = await opts.runTool(block.name, block.input);
          } catch (err) {
            result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Text-only turn. It's a genuine final answer UNLESS it's a stall — the model
    // narrating that it will look up cards but ending the turn without doing so
    // ("Let me find real cards…") — or a finalGuard says it's incomplete.
    const stalled = looksLikeToolPreamble(text);
    const incomplete = opts.finalGuard ? !opts.finalGuard(text) : false;
    if (!stalled && !incomplete) break;

    // Don't surface the preamble. Tell the model to actually CALL the tools now
    // and keep going (tools stay available next turn).
    yield { type: 'status', text: 'Looking up cards…' };
    messages.push({
      role: 'user',
      content:
        'Do not describe what you are about to do. If you need card data, CALL search_cards / get_card NOW to fetch it, then give your COMPLETE answer' +
        (opts.finalGuard ? ', ending with the full ```decklist``` code block — do not ask to look up more after that.' : '.'),
    });
  }

  // If the model answered directly without ever calling a tool, that text IS the
  // answer — UNLESS it's a stall preamble, or a finalGuard says it's incomplete,
  // in which case we fall through and force a proper final answer.
  if (!usedTools && !looksLikeToolPreamble(lastText) && (!opts.finalGuard || opts.finalGuard(lastText))) {
    if (lastText) yield { type: 'text', text: lastText };
    return;
  }

  // Force one clean final answer. The nudge forbids further narration so the
  // model can't stall with another "let me gather more" instead of delivering.
  yield { type: 'status', text: 'Writing it up…' };
  const nudge: Anthropic.Messages.TextBlockParam = {
    type: 'text',
    text:
      'You have the card details you need. Now write your COMPLETE final answer as text, drawing on everything above — ' +
      'answer directly, without narrating your process or announcing further lookups' +
      (opts.finalGuard ? ', and end with the full ```decklist``` code block containing every non-land card.' : '.'),
  };
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    last.content.push(nudge);
  } else {
    messages.push({ role: 'user', content: [nudge] });
  }

  // Stream the final answer live (preserves token-by-token output). Accumulate
  // it so a guard can verify completeness afterwards.
  let finalText = '';
  for await (const chunk of streamTurn(messages, opts, true)) {
    finalText += chunk;
    yield { type: 'text', text: chunk };
  }

  // If a guard is set (build) and the model STILL stalled without delivering,
  // retry once with a blunt nudge and stream the real result — so a build can
  // never END on a "let me gather more" message.
  if (opts.finalGuard && !opts.finalGuard(finalText)) {
    messages.push({ role: 'assistant', content: finalText || '(no output)' });
    messages.push({
      role: 'user',
      content:
        'That was not a complete build. Output ONLY the finished build now, ending with the ```decklist``` code block ' +
        'listing every non-land card as "<qty> <name>". No preamble, no promises to search — the full list, now.',
    });
    yield { type: 'status', text: 'Finishing the build…' };
    for await (const chunk of streamTurn(messages, opts, true)) yield { type: 'text', text: chunk };
  }
}

/**
 * One-shot non-streaming call that expects a JSON object back. Tolerant of code
 * fences / surrounding prose — extracts the first {...} block. Returns null if
 * nothing parseable came back.
 */
export async function callModelJSON(opts: {
  systemBlocks: Anthropic.Messages.TextBlockParam[];
  userContent: string;
  maxTokens?: number;
}): Promise<unknown> {
  const msg = await getClient().messages.create({
    model: ENV.model,
    max_tokens: opts.maxTokens ?? 512,
    system: opts.systemBlocks,
    messages: [{ role: 'user', content: opts.userContent }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
