import { z } from 'zod';

export const sceneStepSchema = z.strictObject({
  location: z.string().trim().min(1).max(100),
  activity: z.string().trim().min(1).max(100),
  narration: z.string().trim().min(1).max(240),
  leader: z.enum(['mira', 'user', 'together']),
});
export const scenePlanSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  steps: z.array(sceneStepSchema).min(2).max(6),
});
export const sceneProposalSchema = scenePlanSchema.extend({ id: z.string() });
export const sceneSnapshotSchema = z.object({
  enabled: z.boolean(),
  version: z.number().int().nonnegative(),
  active: z
    .object({
      plan: sceneProposalSchema,
      stepIndex: z.number().int().nonnegative(),
      completedTurns: z.number().int().nonnegative(),
    })
    .optional(),
  proposal: sceneProposalSchema.optional(),
  dismissedTitles: z.array(z.string()).max(5),
});
export type SceneStep = z.infer<typeof sceneStepSchema>;
export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type SceneSnapshot = z.infer<typeof sceneSnapshotSchema>;
