import { z } from 'zod';
import { emotionSchema, gestureNameSchema } from './performance.js';

export const replyLimits = { characters: 16000, phrases: 32, phraseCharacters: 600, depth: 32 };

export const replyPhraseTextSchema = z.string().trim().min(1).max(replyLimits.phraseCharacters);

const replyEmotionSchema = z.preprocess((value) => {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return name === 'normal' ? 'neutral' : name === 'surprise' ? 'surprised' : name;
}, emotionSchema);

/** LLM wire format. Adapt to SpeechPhrase after validation, before playback. */
export const llmPhraseSchema = z.strictObject({
  phrase: replyPhraseTextSchema,
  emotion: replyEmotionSchema,
  gestures: z
    .array(
      z.strictObject({
        name: gestureNameSchema,
        strength: z.number().min(0).max(1),
      }),
    )
    .max(2),
});

export const llmReplySchema = z.array(llmPhraseSchema).min(1).max(replyLimits.phrases);

export type LlmPhrase = z.infer<typeof llmPhraseSchema>;
