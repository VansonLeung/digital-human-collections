import type { MouthCue } from '@digital-human/shared';
import type { Emotion, GestureName, PhrasePerformance, PoseName } from '@digital-human/shared';

export type Shape = MouthCue['shape'];

export interface AvatarRenderer {
  readonly supportedGestures: readonly GestureName[];
  load(url: string): Promise<void>;
  setMouth(shape: Shape): void;
  setMouthOpening(value: number): void;
  setSpeaking(value: boolean): void;
  setEmotion(value: Emotion): void;
  beginPhrase(value: PhrasePerformance, duration: number): void;
  setPlaybackTime(seconds: number): void;
  previewPose?(name: PoseName, strength: number, holdSeconds: number): void;
  stopPose?(): void;
  setPoseHoldSeconds?(seconds: number): void;
  dispose(): void;
}

export const openness: Record<Shape, number> = {
  A: 0,
  B: 0.18,
  C: 0.42,
  D: 0.85,
  E: 0.55,
  F: 0.32,
  G: 0.12,
  H: 0.3,
  X: 0,
};
