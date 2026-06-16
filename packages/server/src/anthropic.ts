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
