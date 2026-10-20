import { z } from 'zod';

export const clientSettingsSchema = z.object({
  personaId: z.string().min(1).max(80).default('constraint-twist'),
  language: z.enum(['auto', 'en', 'zh', 'yue']).default('auto'),
  speech: z.boolean().default(true),
  muted: z.boolean().default(false),
  proactiveEnabled: z.boolean().default(false),
  idleSeconds: z.number().int().min(1).max(3600).default(60),
  autoReplyEnabled: z.boolean().default(false),
  autoReplyMode: z.enum(['text', 'spoken']).default('text'),
  manualMessageMode: z.enum(['text', 'spoken']).default('text'),
  autoReplyDelaySeconds: z.number().min(1).max(600).default(3),
  autoReplyMaxTurns: z.number().int().min(1).max(100).default(5),
  displayMode: z.enum(['full', 'phrases']).default('full'),
  textPhraseDelaySeconds: z.number().min(0.2).max(10).default(0.8),
  poseStrength: z.number().min(0.2).max(1).default(0.9),
  poseHoldSeconds: z.number().min(0.5).max(10).default(3),
});

export type ClientSettings = z.infer<typeof clientSettingsSchema>;
export const defaultClientSettings = clientSettingsSchema.parse({});
