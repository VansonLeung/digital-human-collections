import type { Gesture } from '@digital-human/shared';
import { rotation, type PerformancePose } from './poseComposer';

/** Gesture curves are sampled using audio time; the LLM never supplies rotations. */
export function gesturePose(
  gesture: Gesture,
  seconds: number,
  phraseDuration: number,
  fade: number,
): PerformancePose {
  const pose: PerformancePose = { bones: {}, expressions: {} };
  const duration = Math.min(gesture.name === 'wave' ? 2.4 : 1.8, phraseDuration);
  if (duration <= 0 || seconds < 0 || seconds >= duration) return pose;
  const progress = seconds / duration;
  const envelope = Math.sin(progress * Math.PI) ** 2;
  const strength = gesture.strength * envelope * fade;

  switch (gesture.name) {
    case 'nod':
      pose.bones.head = rotation(Math.sin(progress * Math.PI * 4) * 0.2 * strength);
      break;
    case 'shake_head':
      pose.bones.head = rotation(0, Math.sin(progress * Math.PI * 4) * 0.25 * strength);
      break;
    case 'wave':
      pose.bones.rightUpperArm = rotation(-0.25 * strength, 0, -1.1 * strength);
      pose.bones.rightLowerArm = rotation(0, 1.5 * strength, -0.45 * strength);
      pose.bones.rightHand = rotation(0, 0, Math.sin(progress * Math.PI * 10) * 0.65 * strength);
      break;
    case 'open_hand':
      pose.bones.rightUpperArm = rotation(-0.2 * strength, -0.1 * strength, -0.9 * strength);
      pose.bones.rightLowerArm = rotation(0, 1.5 * strength, -0.3 * strength);
      pose.bones.rightHand = rotation(-0.2 * strength, 0, -0.2 * strength);
      pose.bones.chest = rotation(0, -0.03 * strength);
      break;
    case 'shrug':
      pose.bones.leftShoulder = rotation(0, 0, 0.18 * strength);
      pose.bones.rightShoulder = rotation(0, 0, -0.18 * strength);
      pose.bones.leftUpperArm = rotation(0, 0, 0.4 * strength);
      pose.bones.rightUpperArm = rotation(0, 0, -0.4 * strength);
      pose.bones.leftLowerArm = rotation(0, -strength);
      pose.bones.rightLowerArm = rotation(0, strength);
      pose.bones.head = rotation(0, 0, 0.08 * strength);
      break;
  }
  return pose;
}
