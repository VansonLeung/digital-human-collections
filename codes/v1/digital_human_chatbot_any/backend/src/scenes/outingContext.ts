import type { ChatMessage } from '../llm/requestMessages.js';

/** Spoken context only: never private profiles or model response instructions. */
export function outingContext(history: ChatMessage[], input: string) {
  const previous = [...history];
  if (previous.at(-1)?.role === 'user' && previous.at(-1)?.content === input) previous.pop();
  return previous.slice(-8).map(({ role, content }) => ({
    speaker: role === 'assistant' ? 'Mira' : 'user',
    text: content.slice(0, 2000),
  }));
}
