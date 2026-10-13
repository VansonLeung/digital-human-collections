import { z } from 'zod';

export const emotionSchema = z.enum(['neutral', 'happy', 'sad', 'surprised', 'thoughtful']);

export type Emotion = z.infer<typeof emotionSchema>;

export const gestureNameSchema = z.enum(['nod', 'shake_head', 'wave', 'open_hand', 'shrug']);

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
