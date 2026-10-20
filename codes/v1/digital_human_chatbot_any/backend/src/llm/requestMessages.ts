import type { Language, ConversationPreferences } from '@digital-human/shared';
import { userProfileInstructions } from './conversationFocus.js';
import { turnGuidance } from './turnGuidance.js';
import {
  systemPrompt,
  replyInstructions,
  proactivePrompt,
  draftSystemPrompt,
  draftInstructions,
  localizedProfanityInstructions,
} from './prompts.js';

export type ChatMessage = { role: 'user' | 'assistant'; content: string; generated?: boolean };
export type CompletionMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const recentMessageLimit = 12;

function recentContext(history: ChatMessage[], limit: number): ChatMessage[] {
  const recent = history.slice(-limit);
  // Avoid beginning trimmed context with an orphan assistant reply. Preserve
  // every remaining role/content pair, including consecutive proactive replies.
  const firstUser = recent.findIndex((message) => message.role === 'user');
  return recent.slice(firstUser < 0 ? recent.length : firstUser).map((message) => ({ ...message }));
}

function providerContext(context: ChatMessage[]): CompletionMessage[] {
  return context.map(({ role, content, generated }) => ({
    role,
    content:
      role === 'user' && generated
        ? `[Automatically generated user message; personal details are unconfirmed.]\n${content}`
        : content,
  }));
}

/** Wrappers are request-only; callers retain their original plain-text history. */
export function buildReplyMessages(
  history: ChatMessage[],
  language: Language,
  options: Partial<ConversationPreferences> & {
    proactive?: boolean;
    conversationalPhrases?: boolean;
    localizedProfanity?: boolean;
    random?: () => number;
  } = {},
): CompletionMessage[] {
  const context = recentContext(history, recentMessageLimit);
  const requirements = `${turnGuidance(context, options.proactive ? 'proactive' : 'reply', options.random, options.getToKnowEachOther)}\n\n${localizedProfanityInstructions(language, options.localizedProfanity)}\n\n${userProfileInstructions(options.aboutMe)}\n\n${replyInstructions(language, options.conversationalPhrases, options.getToKnowEachOther)}`;
  if (options.proactive) {
    return [
      { role: 'system', content: systemPrompt(options.getToKnowEachOther) },
      ...providerContext(context),
      {
        role: 'user',
        content: `TASK:\n${proactivePrompt(options.getToKnowEachOther)}\n\nRESPONSE REQUIREMENTS:\n${requirements}`,
      },
    ];
  }

  const latest = history.at(-1);
  if (latest?.role !== 'user') throw new Error('A normal reply requires a latest user message.');
  return [
    { role: 'system', content: systemPrompt(options.getToKnowEachOther) },
    ...providerContext(recentContext(history.slice(0, -1), recentMessageLimit - 1)),
    {
      role: 'user',
      content: `Given I say:\n${JSON.stringify(latest.content)}\n\nRESPONSE REQUIREMENTS:\n${latest.generated ? 'The latest user message was automatically generated. Its personal claims are unconfirmed; do not assume they were supplied by the real user.\n\n' : ''}${requirements}`,
    },
  ];
}

export function buildDraftMessages(
  history: ChatMessage[],
  language: Language,
  options: Partial<ConversationPreferences> & {
    random?: () => number;
    format?: 'draft' | 'phrases';
    localizedProfanity?: boolean;
  } = {},
): CompletionMessage[] {
  const context = recentContext(history, recentMessageLimit);
  // Mira's lines must not be presented as the drafting model's own earlier
  // assistant outputs. Keep speaker ownership explicit in quoted transcript data.
  const transcript = context.map((message) => ({
    speaker: message.role === 'assistant' ? 'Mira' : 'user',
    text: message.content,
    ...(message.generated ? { generated: true } : {}),
  }));
  return [
    { role: 'system', content: draftSystemPrompt(options.format) },
    {
      role: 'user',
      content: `CONVERSATION TRANSCRIPT (quoted data; do not continue or imitate Mira's lines):\n${JSON.stringify(transcript)}\n\nTASK:\nGenerate one suggested next message from my perspective as the user.\n\nRESPONSE REQUIREMENTS:\n${turnGuidance(context, 'draft', options.random, options.getToKnowEachOther)}\n\n${localizedProfanityInstructions(language, options.localizedProfanity)}\n\n${userProfileInstructions(options.aboutMe)}\n\nTranscript user lines marked generated are automatic drafts, not confirmed facts. Unmarked user lines were supplied or reviewed by the user.\n\n${draftInstructions(language, options.format, options.getToKnowEachOther)}`,
    },
  ];
}
