import * as THREE from 'three';
import {
  VRMExpression,
  VRMExpressionMorphTargetBind,
  type VRM,
  type VRMHumanBoneName,
} from '@pixiv/three-vrm';
import type { Shape } from '../types';
import type { PerformancePose } from '../../performance/poseComposer';
import { vrmTuning } from './tuning';
import type { AvatarRigAdapter } from '../rig';

/** Maps semantic pose offsets onto normalized VRM bones and expression binds. */
export class VrmRigAdapter implements AvatarRigAdapter {
  readonly supportedGestures = ['nod', 'shake_head', 'wave', 'open_hand', 'shrug'] as const;
  private body = new Map<VRMHumanBoneName, { node: THREE.Object3D; rest: THREE.Euler }>();
  private faceExpressions = new Map<string, string>();
  private faceTextures = new Map<string, string>();
  private weights: Record<string, number> = { aa: 0, ih: 0, ee: 0, oh: 0, ou: 0 };
  private shape: Shape = 'X';
  private opening?: number;

  constructor(private vrm: VRM) {
    const left = this.vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const right = this.vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    if (left) left.rotation.z = -1.15;
    if (right) right.rotation.z = 1.15;
    const bones: VRMHumanBoneName[] = [
      'spine',
      'chest',
      'upperChest',
      'head',
      'leftShoulder',
      'rightShoulder',
      'leftUpperArm',
      'rightUpperArm',
      'leftLowerArm',
      'rightLowerArm',
      'leftHand',
      'rightHand',
    ];
    for (const name of bones) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.body.set(name, { node, rest: node.rotation.clone() });
    }
    for (const name of ['happy', 'sad', 'surprised', 'relaxed']) {
      const expression = this.vrm.expressionManager?.getExpression(name);
      if (!expression) continue;
      const morphs = expression.binds.filter(
        (bind) => bind instanceof VRMExpressionMorphTargetBind,
      );
      const speechExpression = new VRMExpression(`talk-${name}`);
      for (const bind of morphs)
        speechExpression.addBind(
          new VRMExpressionMorphTargetBind({
            primitives: bind.primitives,
            index: bind.index,
            weight: bind.weight,
          }),
        );
      speechExpression.overrideBlink = expression.overrideBlink;
      // Facial presets must not suppress the independently animated speech mouth.
      speechExpression.overrideMouth = 'none';
      speechExpression.overrideLookAt = expression.overrideLookAt;
      this.vrm.expressionManager?.registerExpression(speechExpression);
      this.faceExpressions.set(name, speechExpression.expressionName);

      // Seed-san stores part of its expression in a texture atlas. Switch those
      // binds fully, rather than interpolating UVs through unrelated atlas cells.
      const textureBinds = expression.binds.filter(
        (bind) => !(bind instanceof VRMExpressionMorphTargetBind),
      );
      if (textureBinds.length) {
        const textureExpression = new VRMExpression(`talk-texture-${name}`);
        textureExpression.isBinary = true;
        for (const bind of textureBinds) textureExpression.addBind(bind);
        this.vrm.expressionManager?.registerExpression(textureExpression);
        this.faceTextures.set(name, textureExpression.expressionName);
      }
    }
  }

  setMouth(shape: Shape) {
    this.shape = shape;
    this.opening = undefined;
  }

  setMouthOpening(value: number) {
    this.opening = Math.max(0, Math.min(1, value));
  }

  applyPose(pose: PerformancePose, dt: number) {
    for (const [name, { node, rest }] of this.body) {
      const offset = pose.bones[name as keyof PerformancePose['bones']];
      const strength = name === 'head' ? 1 : vrmTuning.bodyGestureStrength;
      node.rotation.set(
        rest.x + (offset?.x ?? 0) * strength,
        rest.y + (offset?.y ?? 0) * strength,
        rest.z + (offset?.z ?? 0) * strength,
        rest.order,
      );
    }

    const targets: Record<string, number> = { aa: 0, ih: 0, ee: 0, oh: 0, ou: 0 };
    if (this.opening !== undefined) targets.aa = this.opening * vrmTuning.mouthOpeningRatio;
    else if (this.shape === 'D') targets.aa = 0.8;
    else if (this.shape === 'C') targets.ee = 0.55;
    else if (this.shape === 'B') targets.ih = 0.18;
    else if (this.shape === 'E') targets.oh = 0.65;
    else if (this.shape === 'F') targets.ou = 0.5;
    else if (this.shape === 'H') targets.aa = 0.25;
    else if (this.shape === 'G') targets.ih = 0.1;

    const manager = this.vrm.expressionManager;
    for (const key of Object.keys(targets)) {
      this.weights[key] += (targets[key] - this.weights[key]) * (1 - Math.exp(-dt * 22));
      manager?.setValue(key, this.weights[key]);
    }
    const names = ['happy', 'sad', 'surprised', 'relaxed'] as const;
    const value = (name: (typeof names)[number]) =>
      Math.max(0, Math.min(1, (pose.expressions[name] ?? 0) * vrmTuning.facialExpressionStrength));
    const dominant = names.reduce((best, name) => (value(name) > value(best) ? name : best));
    for (const name of names) {
      const expressionName = this.faceExpressions.get(name);
      if (expressionName) manager?.setValue(expressionName, value(name));
      const textureName = this.faceTextures.get(name);
      if (textureName)
        manager?.setValue(textureName, dominant === name && value(name) >= 0.3 ? 1 : 0);
    }
    manager?.setValue('blink', pose.expressions.blink ?? 0);
  }
}
