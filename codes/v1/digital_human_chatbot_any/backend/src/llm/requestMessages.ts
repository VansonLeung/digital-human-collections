import type { Language } from '@digital-human/shared';
import { turnGuidance } from './turnGuidance.js';
import {
  systemPrompt,
  replyInstructions,
  proactivePrompt,
  draftSystemPrompt,
  draftInstructions,
} from './prompts.js';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type CompletionMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const recentMessageLimit = 12;

function recentContext(history: ChatMessage[], limit: number): ChatMessage[] {
  const recent = history.slice(-limit);
  // Avoid beginning trimmed context with an orphan assistant reply. Preserve
  // every remaining role/content pair, including consecutive proactive replies.
  const firstUser = recent.findIndex((message) => message.role === 'user');
  return recent.slice(firstUser < 0 ? recent.length : firstUser).map((message) => ({ ...message }));
}

/** Wrappers are request-only; callers retain their original plain-text history. */
export function buildReplyMessages(
  history: ChatMessage[],
  language: Language,
  options: { proactive?: boolean; conversationalPhrases?: boolean; random?: () => number } = {},
): CompletionMessage[] {
  const context = recentContext(history, recentMessageLimit);
  const requirements = `${turnGuidance(context, options.proactive ? 'proactive' : 'reply', options.random)}\n\n${replyInstructions(language, options.conversationalPhrases)}`;
  if (options.proactive) {
    return [
      { role: 'system', content: systemPrompt() },
      ...context,
      {
        role: 'user',
        content: `TASK:\n${proactivePrompt()}\n\nRESPONSE REQUIREMENTS:\n${requirements}`,
      },
    ];
  }

  const latest = history.at(-1);
  if (latest?.role !== 'user') throw new Error('A normal reply requires a latest user message.');
  return [
    { role: 'system', content: systemPrompt() },
    ...recentContext(history.slice(0, -1), recentMessageLimit - 1),
    {
      role: 'user',
      content: `Given I say:\n${JSON.stringify(latest.content)}\n\nRESPONSE REQUIREMENTS:\n${requirements}`,
    },
  ];
}

export function buildDraftMessages(
  history: ChatMessage[],
  language: Language,
  options: { random?: () => number; format?: 'draft' | 'phrases' } = {},
): CompletionMessage[] {
  const context = recentContext(history, recentMessageLimit);
  return [
    { role: 'system', content: draftSystemPrompt(options.format) },
    ...context,
    {
      role: 'user',
      content: `TASK:\nGenerate one suggested next message from my perspective as the user.\n\nRESPONSE REQUIREMENTS:\n${turnGuidance(context, 'draft', options.random)}\n\n${draftInstructions(language, options.format)}`,
    },
  ];
}
