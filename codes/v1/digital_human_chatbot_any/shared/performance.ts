import { z } from 'zod';

export const emotionSchema = z.enum([
  'neutral',
  'happy',
  'sad',
  'surprised',
  'thoughtful',
  'angry',
]);

export type Emotion = z.infer<typeof emotionSchema>;

export const poseNameSchema = z.enum([
  'hands_on_hips',
  'raise_hand',
  'crossed_arms',
  'hand_on_chin',
  'dramatic_point',
  'dramatic_lean',
  'tsundere_turn',
]);
export type PoseName = z.infer<typeof poseNameSchema>;

export const poseLabels: Record<PoseName, string> = {
  hands_on_hips: '叉腰 · Hands on hips',
  raise_hand: '舉手 · Raise hand',
  crossed_arms: 'Crossed arms',
  hand_on_chin: 'Hand on chin',
  dramatic_point: 'Dramatic point',
  dramatic_lean: 'Dramatic lean',
  tsundere_turn: '三七面 · Tsundere turn',
};

export const gestureNameSchema = z.enum([
  'nod',
  'shake_head',
  'wave',
  'open_hand',
  'shrug',
  ...poseNameSchema.options,
]);

export type GestureName = z.infer<typeof gestureNameSchema>;

export const gestureSchema = z.object({
  name: gestureNameSchema,
  strength: z.number().min(0).max(1).default(0.5),
});

export type Gesture = z.infer<typeof gestureSchema>;

export const phrasePerformanceSchema = z.object({
  emotion: emotionSchema.default('neutral'),
  gestures: z.array(gestureSchema).max(2).default([]),
});

export type PhrasePerformance = z.infer<typeof phrasePerformanceSchema>;

export type SpeechPhrase = {
  text: string;
  performance: PhrasePerformance;
};
