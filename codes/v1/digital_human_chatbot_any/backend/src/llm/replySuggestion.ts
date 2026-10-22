import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import type { Language, LlmRequestBody } from '@digital-human/shared';
import type { Config } from '../config.js';
import { complete, EmptyCompletionError, type ChatMessage } from '../services/llm.js';
import { repeatedReply, RepetitiveReplyError, repetitionAttempts } from './repetition.js';
import { buildDraftMessages, type GenerationPreferences } from './requestMessages.js';
import { ReplyFormatError } from './JsonReplyParser.js';

const draftSchema = z.strictObject({ draft: z.string().trim().min(1).max(1000) });

export async function suggestReply(
  config: Config,
  history: ChatMessage[],
  language: Language,
  signal: AbortSignal,
  localizedProfanity = false,
  preferences: GenerationPreferences = {},
) {
  let raw = '';
  let requestBody: LlmRequestBody | null = null;
  let finishReason: string | null = null;
  let outputComplete = false;
  try {
    const attempts = repetitionAttempts(preferences.autoRecoverStalls !== false);
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      signal.throwIfAborted();
      raw = '';
      outputComplete = false;
      finishReason = null;
      await complete(
        config,
        buildDraftMessages(history, language, {
          ...preferences,
          localizedProfanity,
          repetitionRetry: attempt === 1,
          recoveryStage: attempts[attempt],
        }),
        (delta) => {
          raw = (raw + delta).slice(0, 16000);
        },
        signal,
        {
          onFinishReason: (reason) => {
            finishReason = reason;
          },
          onRequestBody: (body) => {
            requestBody = body;
          },
        },
      );
      outputComplete = true;
      const draft = draftSchema.parse(JSON.parse(jsonrepair(raw))).draft;
      const match = repeatedReply(draft, history);
      if (!match) return draft;
      if (attempt === attempts.length - 1) throw new RepetitiveReplyError(match, attempts.length);
    }
    throw new Error('Suggestion retry exhausted');
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReplyFormatError(
      error instanceof EmptyCompletionError || error instanceof RepetitiveReplyError
        ? error.message
        : outputComplete
          ? 'The reply suggestion was not a valid draft. Please try again.'
          : 'Reply suggestion failed while contacting the LLM. Inspect the diagnostics below.',
      {
        ...(error instanceof RepetitiveReplyError ? error.details : {}),
        source: raw,
        requestBody,
        finishReason,
        outputComplete: outputComplete || error instanceof EmptyCompletionError,
        cause: error instanceof Error ? error.message : 'Unknown suggestion error',
      },
    );
  }
}
