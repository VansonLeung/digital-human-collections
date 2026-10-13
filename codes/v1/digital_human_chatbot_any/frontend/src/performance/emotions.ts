import type { Emotion } from '@digital-human/shared';

/** Sustained phrase expressions, independent of syllable volume. */
export const emotionProfiles: Record<
  Emotion,
  { happy: number; sad: number; surprised: number; relaxed: number; thoughtful: number }
> = {
  neutral: { happy: 0, sad: 0, surprised: 0, relaxed: 0, thoughtful: 0 },
  happy: { happy: 0.75, sad: 0, surprised: 0, relaxed: 0, thoughtful: 0 },
  sad: { happy: 0, sad: 0.7, surprised: 0, relaxed: 0, thoughtful: 0 },
  surprised: { happy: 0, sad: 0, surprised: 0.8, relaxed: 0, thoughtful: 0 },
  thoughtful: { happy: 0, sad: 0, surprised: 0, relaxed: 0.45, thoughtful: 0.4 },
};
