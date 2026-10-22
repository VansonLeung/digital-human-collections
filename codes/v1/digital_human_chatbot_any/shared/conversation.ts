import { z } from 'zod';

export const aboutMeMaxLength = 2000;

export const conversationPreferencesSchema = z.object({
  getToKnowEachOther: z.boolean().default(false),
  virtualScenesEnabled: z.boolean().default(false),
  autoEnterScenes: z.boolean().default(false),
  autoRecoverStalls: z.boolean().default(true),
  naturalVariation: z.boolean().default(true),
  miraBehavior: z.string().max(aboutMeMaxLength).default(''),
  miraAngryHopEnabled: z.boolean().default(true),
  // Preserve spaces while editing; prompt assembly trims the finished value.
  aboutMe: z.string().max(aboutMeMaxLength).default(''),
});

export type ConversationPreferences = z.infer<typeof conversationPreferencesSchema>;
