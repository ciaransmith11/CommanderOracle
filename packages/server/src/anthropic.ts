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
  if (!client) client = new Anthropic({ apiKey: ENV.anthropicApiKey });
  return client;
}

export interface StreamOptions {
  systemBlocks: Anthropic.Messages.TextBlockParam[];
  messages: Anthropic.Messages.MessageParam[];
  maxTokens?: number;
}

/**
 * Stream a model response as text chunks. Decouples the rest of the server from
 * the SDK's event shape — callers just consume strings.
 */
export async function* streamModel(opts: StreamOptions): AsyncGenerator<string> {
  const stream = getClient().messages.stream({
    model: ENV.model,
    max_tokens: opts.maxTokens ?? ENV.maxTokens,
    system: opts.systemBlocks,
    messages: opts.messages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
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
