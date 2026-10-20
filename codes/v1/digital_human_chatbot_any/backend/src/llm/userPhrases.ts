import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { userPhraseListSchema, type Language, type LlmRequestBody } from '@digital-human/shared';
import type { Config } from '../config.js';
import { complete, type ChatMessage } from '../services/llm.js';
import { buildDraftMessages } from './requestMessages.js';
import { ReplyFormatError } from './JsonReplyParser.js';
import { userPhraseInstructions } from './prompts.js';

const outputSchema = z.strictObject({ phrases: userPhraseListSchema });

export async function generateUserPhrases(
  config: Config,
  history: ChatMessage[],
  language: Language,
  kind: 'automatic' | 'rewrite',
  text: string,
  signal: AbortSignal,
) {
  const contract = userPhraseInstructions(language);
  const messages =
    kind === 'automatic'
      ? buildDraftMessages(history, language, { format: 'phrases' })
      : [
          {
            role: 'system' as const,
            content:
              "Rewrite the user's own message for spoken delivery. Preserve their perspective and intent. You are a faithful editor, not the recipient answering it. Return only the requested JSON.",
          },
          {
            role: 'user' as const,
            content: `Original message (quoted data):\n${JSON.stringify(text)}\n\nREWRITE REQUIREMENTS:\nMake this natural to speak while preserving its meaning, tone, names, numbers, negations, questions, and constraints. Use the requested output language; if it differs from the source, translate faithfully without changing intent. Do not answer the message, imitate Mira, add flirting, invent facts, or introduce new topics. Keep a short message short. Split at natural clause boundaries.\n\n${contract}`,
          },
        ];
  let raw = '';
  let requestBody: LlmRequestBody | null = null;
  let finishReason: string | null = null;
  let outputComplete = false;
  try {
    await complete(
      config,
      messages,
      (delta) => {
        raw = (raw + delta).slice(0, 16000);
      },
      signal,
      {
        onRequestBody: (body) => {
          requestBody = body;
        },
        onFinishReason: (reason) => {
          finishReason = reason;
        },
      },
    );
    outputComplete = true;
    return outputSchema.parse(JSON.parse(jsonrepair(raw))).phrases;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReplyFormatError(
      'The spoken message could not be prepared. Inspect the LLM details and try again.',
      {
        source: raw,
        requestBody,
        finishReason,
        outputComplete,
        cause: error instanceof Error ? error.message : 'Unknown spoken-message error',
      },
    );
  }
}
