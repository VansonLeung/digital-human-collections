import type { GestureName } from '@digital-human/shared';
import type { PerformancePose } from '../performance/poseComposer';
import type { Shape } from './types';

/** SDK-specific bindings receive a composed pose, never LLM text or audio URLs. */
export interface AvatarRigAdapter {
  readonly supportedGestures: readonly GestureName[];
  setMouth(shape: Shape): void;
  setMouthOpening(value: number): void;
  applyPose(pose: PerformancePose, dt: number): void;
}
