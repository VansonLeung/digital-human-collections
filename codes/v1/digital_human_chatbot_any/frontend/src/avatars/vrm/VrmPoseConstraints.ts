import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { PerformancePose } from '../../performance/poseComposer';
import { solveTwoBoneIK, setWorldQuaternion } from './TwoBoneIK';

type Chain = {
  root: THREE.Object3D;
  middle: THREE.Object3D;
  end: THREE.Object3D;
  rest: THREE.Vector3;
  orientation: THREE.Quaternion;
};

/** Finger direction alone leaves wrist roll ambiguous at a 180-degree crossing.
 * Normalized hands have palms along -Y and thumbs along +Z in the T-pose. */
export function crossedHandOrientation(chest: THREE.Quaternion) {
  const across = new THREE.Vector3(-1, 0, 0).applyQuaternion(chest);
  const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(chest);
  const thumbUp = new THREE.Vector3().crossVectors(across, outward).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(across, outward, thumbUp),
  );
}

/** Converts semantic waist/chin/chest contacts to each avatar's proportions.
 * Feet stay at their standing anchors when a pose lowers the pelvis. */
export class VrmPoseConstraints {
  private arms = new Map<'left' | 'right', Chain>();
  private legs = new Map<'left' | 'right', Chain>();
  private hips?: THREE.Object3D;
  private head?: THREE.Object3D;
  private chest?: THREE.Object3D;
  private height: number;
  private shoulderWidth: number;

  constructor(vrm: VRM) {
    const bone = (name: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(name) ?? undefined;
    this.hips = bone('hips');
    this.head = bone('head');
    this.chest = bone('chest') ?? bone('spine');
    this.height = new THREE.Box3().setFromObject(vrm.scene).getSize(new THREE.Vector3()).y;
    const left = bone('leftUpperArm');
    const right = bone('rightUpperArm');
    this.shoulderWidth =
      left && right
        ? left
            .getWorldPosition(new THREE.Vector3())
            .distanceTo(right.getWorldPosition(new THREE.Vector3()))
        : this.height * 0.18;
    for (const side of ['left', 'right'] as const) {
      for (const [map, names] of [
        [this.arms, ['UpperArm', 'LowerArm', 'Hand']],
        [this.legs, ['UpperLeg', 'LowerLeg', 'Foot']],
      ] as const) {
        const [root, middle, end] = names.map((name) => bone(`${side}${name}` as VRMHumanBoneName));
        if (root && middle && end) {
          root.updateWorldMatrix(true, true);
          map.set(side, {
            root,
            middle,
            end,
            rest: end.getWorldPosition(new THREE.Vector3()),
            orientation: end.getWorldQuaternion(new THREE.Quaternion()),
          });
        }
      }
    }
  }

  apply(pose: PerformancePose) {
    if (!pose.contacts || !this.hips) return;
    this.hips.updateWorldMatrix(true, true);
    const orientation = this.hips.getWorldQuaternion(new THREE.Quaternion());
    const axis = (x: number, y: number, z: number) =>
      new THREE.Vector3(x, y, z).applyQuaternion(orientation);
    const up = axis(0, 1, 0);
    const forward = axis(0, 0, 1);
    const chestOrientation = this.chest?.getWorldQuaternion(new THREE.Quaternion()) ?? orientation;
    const chestAxis = (x: number, y: number, z: number) =>
      new THREE.Vector3(x, y, z).applyQuaternion(chestOrientation);
    const hips = this.hips.getWorldPosition(new THREE.Vector3());
    const targets = new Map<
      'left' | 'right',
      { target: THREE.Vector3; direction: THREE.Vector3 }
    >();
    for (const side of ['left', 'right'] as const) {
      const anchor = pose.contacts.hands[`${side}Hand`];
      const sign = side === 'left' ? 1 : -1;
      if (anchor === 'hip')
        targets.set(side, {
          target: hips
            .clone()
            .addScaledVector(axis(sign, 0, 0), this.shoulderWidth * 0.58)
            .addScaledVector(up, this.height * 0.075)
            .addScaledVector(forward, this.height * 0.035),
          direction: up.clone().negate(),
        });
      if (anchor === 'chin' && this.head)
        targets.set(side, {
          target: this.head
            .getWorldPosition(new THREE.Vector3())
            .addScaledVector(up, -this.height * 0.11)
            .addScaledVector(forward, this.height * 0.06),
          direction: up.clone(),
        });
      if (anchor === 'brow' && this.head)
        targets.set(side, {
          target: this.head
            .getWorldPosition(new THREE.Vector3())
            .addScaledVector(up, this.height * 0.09)
            .addScaledVector(axis(sign, 0, 0), this.shoulderWidth * 0.14)
            .addScaledVector(forward, this.height * 0.075),
          direction: axis(-sign, 0, 0),
        });
      if (anchor === 'crossed' && this.chest)
        targets.set(side, {
          target: this.chest
            .getWorldPosition(new THREE.Vector3())
            .addScaledVector(chestAxis(-sign, 0, 0), this.shoulderWidth * 0.27)
            .addScaledVector(chestAxis(0, 1, 0), this.height * (side === 'left' ? 0.06 : 0.09))
            .addScaledVector(chestAxis(0, 0, 1), this.height * 0.09),
          direction: chestAxis(-sign, 0, 0),
        });
    }
    const weight = pose.contacts.weight;
    for (const [side, { target, direction }] of targets) {
      const chain = this.arms.get(side);
      if (!chain) continue;
      const armAxis = pose.contacts.hands[`${side}Hand`] === 'crossed' ? chestAxis : axis;
      const pole = chain.root
        .getWorldPosition(new THREE.Vector3())
        .addScaledVector(armAxis(side === 'left' ? 1 : -1, 0, 0), this.height * 0.3)
        .addScaledVector(armAxis(0, 0, 1), this.height * 0.08)
        .addScaledVector(
          armAxis(0, 1, 0),
          this.height * (pose.contacts.hands[`${side}Hand`] === 'brow' ? 0.28 : -0.15),
        );
      solveTwoBoneIK(chain.root, chain.middle, chain.end, target, pole, weight);
      const fingerDirection = new THREE.Vector3(side === 'left' ? 1 : -1, 0, 0).applyQuaternion(
        chain.orientation,
      );
      const wrist =
        pose.contacts.hands[`${side}Hand`] === 'crossed'
          ? crossedHandOrientation(chestOrientation)
          : new THREE.Quaternion()
              .setFromUnitVectors(fingerDirection.normalize(), direction.normalize())
              .multiply(chain.orientation);
      setWorldQuaternion(chain.end, wrist, weight);
    }
    if (pose.contacts.feet && (pose.hipsDrop ?? 0) > 1e-7) {
      for (const chain of this.legs.values()) {
        const pole = chain.root
          .getWorldPosition(new THREE.Vector3())
          .addScaledVector(forward, this.height * 0.4);
        solveTwoBoneIK(chain.root, chain.middle, chain.end, chain.rest, pole);
        setWorldQuaternion(chain.end, chain.orientation);
      }
    }
  }
}
