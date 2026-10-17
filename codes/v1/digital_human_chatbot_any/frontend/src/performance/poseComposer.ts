export type Rotation = { x: number; y: number; z: number };

export type FingerBone =
  | `${'left' | 'right'}${'Index' | 'Middle' | 'Ring' | 'Little'}${'Proximal' | 'Intermediate' | 'Distal'}`
  | `${'left' | 'right'}Thumb${'Metacarpal' | 'Proximal' | 'Distal'}`;

export type RigBone =
  | FingerBone
  | 'hips'
  | 'head'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm'
  | 'leftHand'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'rightUpperLeg'
  | 'leftLowerLeg'
  | 'rightLowerLeg'
  | 'leftFoot'
  | 'rightFoot';

export type PerformancePose = {
  bones: Partial<Record<RigBone, Rotation>>;
  hipsDrop?: number;
  cameraGaze?: number;
  contacts?: {
    hands: Partial<Record<'leftHand' | 'rightHand', 'hip' | 'chin' | 'crossed' | 'brow'>>;
    weight: number;
    feet: boolean;
  };
  expressions: Partial<
    Record<'happy' | 'sad' | 'surprised' | 'relaxed' | 'angry' | 'blink', number>
  >;
};

export const rotation = (x = 0, y = 0, z = 0): Rotation => ({ x, y, z });

/** A held body pose owns its bones; speech expressions remain a separate layer. */
export function blendBodyPose(
  base: PerformancePose,
  target: PerformancePose,
  amount: number,
): PerformancePose {
  const weight = Math.max(0, Math.min(1, amount));
  const result: PerformancePose = {
    bones: { ...base.bones },
    expressions: { ...base.expressions },
  };
  for (const [name, value] of Object.entries(target.bones)) {
    const bone = name as RigBone;
    const from = base.bones[bone] ?? rotation();
    result.bones[bone] = rotation(
      from.x + (value.x - from.x) * weight,
      from.y + (value.y - from.y) * weight,
      from.z + (value.z - from.z) * weight,
    );
  }
  result.hipsDrop = (base.hipsDrop ?? 0) + ((target.hipsDrop ?? 0) - (base.hipsDrop ?? 0)) * weight;
  result.cameraGaze =
    (base.cameraGaze ?? 0) + ((target.cameraGaze ?? 0) - (base.cameraGaze ?? 0)) * weight;
  if (target.contacts)
    result.contacts = { ...target.contacts, weight: target.contacts.weight * weight };
  else if (base.contacts)
    result.contacts = { ...base.contacts, weight: base.contacts.weight * (1 - weight) };
  return result;
}

/** Add bounded offsets once, then let the rig adapter apply them to its rest pose. */
export function composePose(...layers: PerformancePose[]): PerformancePose {
  const result: PerformancePose = { bones: {}, expressions: {} };
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer.bones)) {
      const bone = name as RigBone;
      const previous = result.bones[bone] ?? rotation();
      const limit = bone === 'head' ? 0.4 : 1.6;
      const clamp = (number: number) => Math.max(-limit, Math.min(limit, number));
      result.bones[bone] = {
        x: clamp(previous.x + value.x),
        y: clamp(previous.y + value.y),
        z: clamp(previous.z + value.z),
      };
    }
    for (const [name, value] of Object.entries(layer.expressions)) {
      const expression = name as keyof PerformancePose['expressions'];
      result.expressions[expression] = Math.min(1, (result.expressions[expression] ?? 0) + value);
    }
  }
  return result;
}
