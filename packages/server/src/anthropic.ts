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
}

/**
 * Stream one model turn, yielding text and returning the final message.
 * `tools` is passed per-turn so the final turn can omit them, forcing a text answer.
 */
async function* streamTurn(
  messages: Anthropic.Messages.MessageParam[],
  opts: ToolStreamOptions,
  tools: Anthropic.Tool[] | undefined,
): AsyncGenerator<string, Anthropic.Messages.Message> {
  for (let attempt = 1; ; attempt++) {
    let emitted = false;
    try {
      const stream = getClient().messages.stream({
        model: ENV.model,
        max_tokens: opts.maxTokens ?? ENV.maxTokens,
        system: opts.systemBlocks,
        ...(tools && tools.length ? { tools } : {}),
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

/**
 * Stream a model response that may call tools. Runs the tool-use loop
 * server-side (executing tools, feeding results back) and streams text the
 * whole time — the caller still just consumes strings.
 */
export async function* streamModelWithTools(opts: ToolStreamOptions): AsyncGenerator<string> {
  const messages: Anthropic.Messages.MessageParam[] = [...opts.messages];
  const maxTurns = opts.maxTurns ?? 8;

  for (let turn = 0; turn < maxTurns; turn++) {
    // On the final allowed turn, withhold tools so the model MUST produce a
    // text answer instead of requesting yet another tool call.
    const tools = turn === maxTurns - 1 ? undefined : opts.tools;
    const final = yield* streamTurn(messages, opts, tools);
    messages.push({ role: 'assistant', content: final.content as unknown as Anthropic.Messages.ContentBlockParam[] });

    if (final.stop_reason !== 'tool_use') return;

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of final.content) {
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
