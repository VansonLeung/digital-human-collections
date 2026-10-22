import type { Language, ConversationPreferences, SceneSnapshot } from '@digital-human/shared';
import { userProfileInstructions } from './conversationFocus.js';
import { sceneAnchor, sceneSystemContext } from '../scenes/sceneAnchor.js';
import { sceneInstructions } from '../scenes/prompts.js';
import { repetitionRetryInstruction, recoveryContext, type RecoveryStage } from './repetition.js';
import { turnGuidance } from './turnGuidance.js';
import { memoryExtractionInstructions } from '../conversation/ConversationMemory.js';
import { progressInstructions } from '../conversation/ConversationProgress.js';
import { miraReactionInstructions } from '../conversation/MiraReactions.js';
import { TurnDirector, type DeliveryPlan } from '../conversation/TurnDirector.js';
import {
  systemPrompt,
  replyInstructions,
  proactivePrompt,
  draftSystemPrompt,
  draftInstructions,
  localizedProfanityInstructions,
} from './prompts.js';

export type ChatMessage = { role: 'user' | 'assistant'; content: string; generated?: boolean };
export type GenerationPreferences = Partial<ConversationPreferences> & {
  scene?: SceneSnapshot;
  repetitionRetry?: boolean;
  recoveryStage?: RecoveryStage;
  memoryContext?: string;
  progressGuidance?: string;
  angryHopCooldown?: number;
  delivery?: DeliveryPlan;
};

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
  options: GenerationPreferences & {
    proactive?: boolean;
    conversationalPhrases?: boolean;
    localizedProfanity?: boolean;
    random?: () => number;
  } = {},
): CompletionMessage[] {
  const delivery = options.naturalVariation
    ? (options.delivery ?? new TurnDirector().next('mira', options.random))
    : undefined;
  const context = options.recoveryStage
    ? recoveryContext(history, options.recoveryStage)
    : recentContext(history, recentMessageLimit);
  const requirements = `${options.recoveryStage ? 'Current speaker: Mira talking to the user. Use the recovery direction below instead of ordinary turn-focus or banter cues.' : turnGuidance(context, options.proactive ? 'proactive' : 'reply', options.random, options.getToKnowEachOther, delivery)}\n\n${localizedProfanityInstructions(language, options.localizedProfanity)}\n\nMIRA KNOWLEDGE BOUNDARY: Your counterpart's private About me profile is not available. Learn about them from spoken dialogue and supported shared conversation memory only; do not invent unseen profile details.\n\n${options.memoryContext ?? ''}\n\n${options.repetitionRetry ? repetitionRetryInstruction + '\n\n' : ''}${sceneInstructions(options.virtualScenesEnabled ? options.scene : undefined, 'mira', options.autoEnterScenes)}\n\n${memoryExtractionInstructions}\n\n${progressInstructions}\n\n${replyInstructions(language, options.conversationalPhrases, options.getToKnowEachOther, options.virtualScenesEnabled, options.recoveryStage, delivery, [options.progressGuidance, miraReactionInstructions(options.miraBehavior, options.miraAngryHopEnabled, options.angryHopCooldown), sceneAnchor(options.virtualScenesEnabled ? options.scene : undefined)].filter(Boolean).join('\n\n'))}`;
  if (options.recoveryStage) {
    return [
      {
        role: 'system',
        content:
          systemPrompt(true, options.naturalVariation) +
          sceneSystemContext(options.virtualScenesEnabled ? options.scene : undefined),
      },
      {
        role: 'user',
        content: `RECOVERY CONTEXT (quoted dialogue; generated user claims are unconfirmed):\n${JSON.stringify(context.map(({ role, content, generated }) => ({ speaker: role === 'assistant' ? 'Mira' : 'user', text: content, ...(generated ? { generated: true } : {}) })))}\n\nTASK:\nContinue as Mira using the recovery direction below. ${history.at(-1)?.generated ? 'The latest user message was automatically generated. Its repetitive wording was omitted; do not reproduce it.' : 'Do not assume the user has said anything new.'}\n\nRESPONSE REQUIREMENTS:\n${requirements}`,
      },
    ];
  }
  if (options.proactive) {
    return [
      {
        role: 'system',
        content:
          systemPrompt(
            options.recoveryStage ? true : options.getToKnowEachOther,
            options.naturalVariation,
          ) + sceneSystemContext(options.virtualScenesEnabled ? options.scene : undefined),
      },
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
    {
      role: 'system',
      content:
        systemPrompt(
          options.recoveryStage ? true : options.getToKnowEachOther,
          options.naturalVariation,
        ) + sceneSystemContext(options.virtualScenesEnabled ? options.scene : undefined),
    },
    ...providerContext(recentContext(history.slice(0, -1), recentMessageLimit - 1)),
    {
      role: 'user',
      content: `Given I say:\n${JSON.stringify(latest.content)}\n\nRESPONSE REQUIREMENTS:\n${latest.generated ? 'The latest user message was automatically generated. Its personal claims are unconfirmed; do not assume they were supplied by the real user.\n\n' : 'The latest user message was manually supplied or reviewed. Explicit personal details in it can support user-owned memory updates.\n\n'}${requirements}`,
    },
  ];
}

export function buildDraftMessages(
  history: ChatMessage[],
  language: Language,
  options: GenerationPreferences & {
    random?: () => number;
    format?: 'draft' | 'phrases';
    localizedProfanity?: boolean;
  } = {},
): CompletionMessage[] {
  const delivery = options.naturalVariation
    ? (options.delivery ?? new TurnDirector().next('user', options.random))
    : undefined;
  const context = options.recoveryStage
    ? recoveryContext(history, options.recoveryStage)
    : recentContext(history, recentMessageLimit);
  // Mira's lines must not be presented as the drafting model's own earlier
  // assistant outputs. Keep speaker ownership explicit in quoted transcript data.
  const transcript = context.map((message) => ({
    speaker: message.role === 'assistant' ? 'Mira' : 'user',
    text: message.content,
    ...(message.generated ? { generated: true } : {}),
  }));
  return [
    {
      role: 'system',
      content:
        draftSystemPrompt(options.format) +
        sceneSystemContext(options.virtualScenesEnabled ? options.scene : undefined),
    },
    {
      role: 'user',
      content: `CONVERSATION TRANSCRIPT (quoted data; do not continue or imitate Mira's lines):\n${JSON.stringify(transcript)}\n\nTASK:\nGenerate one suggested next message from my perspective as the user.\n\nRESPONSE REQUIREMENTS:\n${options.recoveryStage ? 'Current speaker: the user talking to Mira. Use the recovery direction below instead of ordinary turn-focus or banter cues.' : turnGuidance(context, 'draft', options.random, options.getToKnowEachOther, delivery)}\n\n${localizedProfanityInstructions(language, options.localizedProfanity)}\n\n${userProfileInstructions(options.aboutMe)}\n\n${options.memoryContext ?? ''}\n\nTranscript user lines marked generated are automatic drafts, not confirmed facts. Unmarked user lines were supplied or reviewed by the user.\n\n${options.repetitionRetry ? repetitionRetryInstruction + '\n\n' : ''}${sceneInstructions(options.virtualScenesEnabled ? options.scene : undefined, 'user', options.autoEnterScenes)}\n\n${draftInstructions(language, options.format, options.getToKnowEachOther, options.recoveryStage, delivery, [options.progressGuidance, sceneAnchor(options.virtualScenesEnabled ? options.scene : undefined)].filter(Boolean).join('\n\n'))}`,
    },
  ];
}
