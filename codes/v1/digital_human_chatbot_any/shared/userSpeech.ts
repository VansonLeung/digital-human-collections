import { z } from 'zod';

export const userPhraseListSchema = z
  .array(z.string().trim().min(1).max(600))
  .min(1)
  .max(8)
  .refine((phrases) => phrases.join(' ').length <= 4000, 'Spoken message exceeds 4000 characters.');

export const userSpeechPlanSchema = z.object({
  phrases: userPhraseListSchema,
  language: z.enum(['en', 'zh', 'yue']),
  revision: z.number().int().nonnegative(),
});
export type UserSpeechPlan = z.infer<typeof userSpeechPlanSchema>;
