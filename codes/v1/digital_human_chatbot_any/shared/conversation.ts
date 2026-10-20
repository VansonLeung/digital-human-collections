import { z } from 'zod';

export const aboutMeMaxLength = 2000;

export const conversationPreferencesSchema = z.object({
  getToKnowEachOther: z.boolean().default(false),
  // Preserve spaces while editing; prompt assembly trims the finished value.
  aboutMe: z.string().max(aboutMeMaxLength).default(''),
});

export type ConversationPreferences = z.infer<typeof conversationPreferencesSchema>;
