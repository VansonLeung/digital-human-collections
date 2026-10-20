import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import type { Language, LlmRequestBody, ConversationPreferences } from '@digital-human/shared';
import type { Config } from '../config.js';
import { complete, EmptyCompletionError, type ChatMessage } from '../services/llm.js';
import { buildDraftMessages } from './requestMessages.js';
import { ReplyFormatError } from './JsonReplyParser.js';

const draftSchema = z.strictObject({ draft: z.string().trim().min(1).max(1000) });

export async function suggestReply(
  config: Config,
  history: ChatMessage[],
  language: Language,
  signal: AbortSignal,
  localizedProfanity = false,
  preferences: Partial<ConversationPreferences> = {},
) {
  let raw = '';
  let requestBody: LlmRequestBody | null = null;
  let finishReason: string | null = null;
  let outputComplete = false;
  try {
    await complete(
      config,
      buildDraftMessages(history, language, { ...preferences, localizedProfanity }),
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
    return draftSchema.parse(JSON.parse(jsonrepair(raw))).draft;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReplyFormatError(
      error instanceof EmptyCompletionError
        ? error.message
        : outputComplete
          ? 'The reply suggestion was not a valid draft. Please try again.'
          : 'Reply suggestion failed while contacting the LLM. Inspect the diagnostics below.',
      {
        source: raw,
        requestBody,
        finishReason,
        outputComplete: outputComplete || error instanceof EmptyCompletionError,
        cause: error instanceof Error ? error.message : 'Unknown suggestion error',
      },
    );
  }
}
