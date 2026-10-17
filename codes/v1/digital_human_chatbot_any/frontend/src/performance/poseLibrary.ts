import type { PoseName } from '@digital-human/shared';
import { rotation, type FingerBone, type PerformancePose } from './poseComposer';

type PosePreset = { fullBody: boolean; pose: PerformancePose };
const relaxedArms = {
  leftUpperArm: rotation(),
  rightUpperArm: rotation(),
  leftLowerArm: rotation(),
  rightLowerArm: rotation(),
  leftHand: rotation(),
  rightHand: rotation(),
};

/** Offsets are authored against the adapter's relaxed standing pose. Contact
 * targets let each model's arm lengths determine the final elbow angles. */
export const poseLibrary: Record<PoseName, PosePreset> = {
  tsundere_turn: {
    fullBody: false,
    pose: {
      bones: {
        ...relaxedArms,
        leftUpperArm: rotation(-0.55, 0.35, 0.45),
        rightUpperArm: rotation(-0.55, -0.35, -0.45),
        leftLowerArm: rotation(0, -1.65),
        rightLowerArm: rotation(0, 1.65),
        spine: rotation(0, 0.32),
        chest: rotation(0, 0.2),
        upperChest: rotation(),
        head: rotation(-0.08, 0.15, -0.04),
      },
      expressions: {},
      cameraGaze: 1,
      contacts: { hands: { leftHand: 'crossed', rightHand: 'crossed' }, weight: 1, feet: false },
    },
  },
  hands_on_hips: {
    fullBody: false,
    pose: {
      bones: {
        ...relaxedArms,
        leftUpperArm: rotation(0, 0, 0.45),
        rightUpperArm: rotation(0, 0, -0.45),
        leftLowerArm: rotation(0, -0.8),
        rightLowerArm: rotation(0, 0.8),
        head: rotation(0, 0, -0.08),
      },
      expressions: {},
      contacts: { hands: { leftHand: 'hip', rightHand: 'hip' }, weight: 1, feet: false },
    },
  },
  raise_hand: {
    fullBody: true,
    pose: {
      bones: {
        ...relaxedArms,
        rightUpperArm: rotation(-0.12, 0, -2.55),
        rightLowerArm: rotation(0, 0.12, -0.12),
        rightHand: rotation(0, 0, 0.12),
        head: rotation(0, -0.06, 0.04),
      },
      expressions: {},
    },
  },
  crossed_arms: {
    fullBody: false,
    pose: {
      bones: {
        ...relaxedArms,
        leftUpperArm: rotation(-0.55, 0.35, 0.45),
        rightUpperArm: rotation(-0.55, -0.35, -0.45),
        leftLowerArm: rotation(0, -1.65),
        rightLowerArm: rotation(0, 1.65),
        head: rotation(-0.06),
      },
      expressions: {},
      contacts: { hands: { leftHand: 'crossed', rightHand: 'crossed' }, weight: 1, feet: false },
    },
  },
  hand_on_chin: {
    fullBody: false,
    pose: {
      bones: {
        ...relaxedArms,
        rightUpperArm: rotation(-0.65, -0.2, -0.3),
        rightLowerArm: rotation(0, 1.8),
        rightHand: rotation(-0.2),
        head: rotation(0.07, 0, 0.08),
      },
      expressions: {},
      contacts: { hands: { rightHand: 'chin' }, weight: 1, feet: false },
    },
  },
  dramatic_point: {
    fullBody: true,
    pose: {
      bones: {
        ...relaxedArms,
        rightUpperArm: rotation(-0.32, -0.75, -1.05),
        rightLowerArm: rotation(0, 0.15),
        rightHand: rotation(0, -0.1),
        leftUpperArm: rotation(0, 0, 0.25),
        leftLowerArm: rotation(0, -0.9),
        spine: rotation(-0.08, 0.2, 0.08),
        chest: rotation(0, 0.16, 0.08),
        head: rotation(0.04, -0.25, -0.08),
      },
      expressions: {},
      contacts: { hands: { leftHand: 'hip' }, weight: 1, feet: false },
    },
  },
  dramatic_lean: {
    fullBody: true,
    pose: {
      bones: {
        ...relaxedArms,
        spine: rotation(-0.18, -0.16, 0.32),
        chest: rotation(-0.1, -0.12, 0.2),
        head: rotation(0.12, 0.2, -0.24),
        rightUpperArm: rotation(-0.3, 0.15, -2.2),
        rightLowerArm: rotation(0, 0.8, 0.25),
        leftUpperArm: rotation(0, 0, 0.35),
        leftLowerArm: rotation(0, -1),
        leftUpperLeg: rotation(-0.35, 0, 0.04),
        leftLowerLeg: rotation(0.7),
        rightUpperLeg: rotation(-0.2, 0, -0.04),
        rightLowerLeg: rotation(0.4),
      },
      expressions: {},
      hipsDrop: 0.035,
      contacts: { hands: { leftHand: 'hip', rightHand: 'brow' }, weight: 1, feet: true },
    },
  },
};

// Optional finger bones are ignored by rigs that do not expose them.
for (const [name, preset] of Object.entries(poseLibrary)) {
  for (const side of ['left', 'right'] as const) {
    for (const finger of ['Index', 'Middle', 'Ring', 'Little'] as const) {
      let curl = name === 'crossed_arms' || name === 'tsundere_turn' ? 0.25 : 0;
      if (name === 'dramatic_point' && side === 'right') curl = finger === 'Index' ? 0 : 0.9;
      if (name === 'hand_on_chin' && side === 'right') curl = finger === 'Index' ? 0.15 : 0.9;
      for (const joint of ['Proximal', 'Intermediate', 'Distal'] as const)
        preset.pose.bones[`${side}${finger}${joint}` as FingerBone] = rotation(
          0,
          0,
          (side === 'left' ? -1 : 1) * curl,
        );
    }
  }
}
