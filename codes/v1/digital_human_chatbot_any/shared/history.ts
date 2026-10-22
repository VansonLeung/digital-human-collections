import { z } from 'zod';
import { conversationPreferencesSchema } from './conversation.js';
import { conversationMemorySchema } from './memory.js';
import { sceneSnapshotSchema, sceneStepSchema } from './scenes.js';

export const savedMessageSchema = z.object({
  id: z.string().min(1).max(160),
  turnId: z.string().max(160).optional(),
  role: z.enum(['user', 'assistant', 'scene']),
  text: z.string().max(16000),
  generated: z.boolean().optional(),
  personaName: z.string().max(100).optional(),
  sceneStep: sceneStepSchema.optional(),
});
export type SavedMessage = z.infer<typeof savedMessageSchema>;

export const conversationSettingsSchema = conversationPreferencesSchema.extend({
  personaId: z.string().min(1).max(80),
  language: z.enum(['auto', 'en', 'zh', 'yue']),
  displayMode: z.enum(['full', 'phrases']).default('full'),
});

export const savedConversationSchema = z.object({
  format: z.literal('persona-conversation'),
  schemaVersion: z.literal(1),
  id: z.uuid(),
  version: z.number().int().nonnegative(),
  title: z.string().min(1).max(100),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(savedMessageSchema).max(10000),
  settings: conversationSettingsSchema,
  settingsCaptured: z.boolean().default(true),
  state: z.object({
    language: z.enum(['en', 'zh', 'yue']),
    scene: sceneSnapshotSchema,
    memories: z.array(conversationMemorySchema).max(48),
    progress: z.record(z.string(), z.unknown()).default({}),
    angryHopCooldown: z.number().int().min(0).max(3).default(0),
  }),
});
export type SavedConversation = z.infer<typeof savedConversationSchema>;

export const conversationSummarySchema = savedConversationSchema
  .pick({
    id: true,
    version: true,
    title: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({ messageCount: z.number().int().nonnegative() });
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
