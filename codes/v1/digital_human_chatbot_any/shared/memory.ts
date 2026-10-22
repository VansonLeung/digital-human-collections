import { z } from 'zod';

export const memoryCategorySchema = z.enum([
  'interests',
  'skills',
  'routines',
  'preferences',
  'personality',
  'background',
]);
export const memoryCandidateSchema = z.strictObject({
  owner: z.enum(['user', 'mira']),
  category: memoryCategorySchema,
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(240),
  quote: z.string().trim().min(1).max(300),
});
export const conversationMemorySchema = memoryCandidateSchema.extend({
  id: z.string(),
  sourceTurn: z.string(),
  source: z.enum(['manual_message', 'mira_fiction', 'manual_edit']),
  updatedAt: z.string(),
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export type ConversationMemory = z.infer<typeof conversationMemorySchema>;
