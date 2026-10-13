export type Rotation = { x: number; y: number; z: number };

export type RigBone =
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
  | 'rightHand';

export type PerformancePose = {
  bones: Partial<Record<RigBone, Rotation>>;
  expressions: Partial<Record<'happy' | 'sad' | 'surprised' | 'relaxed' | 'blink', number>>;
};

export const rotation = (x = 0, y = 0, z = 0): Rotation => ({ x, y, z });

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
