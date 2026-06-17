import { streamModelWithTools, type ModelEvent } from './anthropic.js';
import { rulesSystemBlocks } from './prompt.js';
import { CHAT_TOOLS, makeToolRunner } from './chat-tools.js';

/**
 * Rules / gameplay clarification chat. Tool-grounded so the model reads exact
 * card text (get_card) instead of reciting from memory. No colour constraint —
 * a rules question can involve any card.
 */
export function rulesChat(
  history: { role: 'user' | 'assistant'; content: string }[],
): AsyncGenerator<ModelEvent> {
  return streamModelWithTools({
    systemBlocks: rulesSystemBlocks(),
    messages: history,
    tools: CHAT_TOOLS,
    runTool: makeToolRunner([]),
    maxTurns: 4,
  });
}
