import * as THREE from 'three';
import {
  VRMLookAtBoneApplier,
  VRMLookAtExpressionApplier,
  type VRMLookAtRangeMap,
  type VRM,
} from '@pixiv/three-vrm';
import { vrmTuning } from './tuning';

type SavedRange = { map: VRMLookAtRangeMap; inputMaxValue: number; outputScale: number };

/** A pose may request a glance toward the camera. Calibrate its horizontal
 * mapping for a visible glance, then restore the model's original settings. */
export class VrmGazeController {
  private previous?: {
    target: THREE.Object3D | null | undefined;
    autoUpdate: boolean;
    yaw: number;
    pitch: number;
  };
  private targetPosition = new THREE.Vector3();
  private ranges: SavedRange[] = [];

  constructor(private vrm: VRM) {}

  update(camera: THREE.Object3D, amount: number) {
    const lookAt = this.vrm.lookAt;
    if (!lookAt) return;
    const weight = Math.max(0, Math.min(1, amount));
    if (weight <= 1e-5) {
      this.reset();
      return;
    }
    if (!this.previous) {
      this.previous = {
        target: lookAt.target,
        autoUpdate: lookAt.autoUpdate,
        yaw: lookAt.yaw,
        pitch: lookAt.pitch,
      };
      lookAt.target = undefined;
      lookAt.autoUpdate = false;
      this.calibrateHorizontalGaze();
    }
    // VRMLookAt measures the raw head. Synchronize the current normalized pose
    // before calculating gaze; vrm.update will apply the resulting eye movement.
    this.vrm.humanoid.update();
    this.vrm.humanoid.getRawBoneNode('head')?.updateWorldMatrix(true, false);
    lookAt.lookAt(camera.getWorldPosition(this.targetPosition));
    lookAt.yaw = this.previous.yaw + (lookAt.yaw - this.previous.yaw) * weight;
    lookAt.pitch = this.previous.pitch + (lookAt.pitch - this.previous.pitch) * weight;
  }

  private calibrateHorizontalGaze() {
    const applier = this.vrm.lookAt?.applier;
    const bone = applier instanceof VRMLookAtBoneApplier;
    if (!bone && !(applier instanceof VRMLookAtExpressionApplier)) return;
    // An authored 90-degree input / 10-degree output gives only 4 degrees of
    // actual eye movement for a 38-degree head turn. Input yaw alone is not a
    // reliable measure of the visible gaze. Bone and expression outputs have
    // different units, so keep expression outputs at their authored weight.
    for (const map of new Set([applier.rangeMapHorizontalInner, applier.rangeMapHorizontalOuter])) {
      this.ranges.push({ map, inputMaxValue: map.inputMaxValue, outputScale: map.outputScale });
      map.inputMaxValue = bone
        ? vrmTuning.poseGazeMaxDegrees
        : vrmTuning.poseGazeExpressionInputDegrees;
      if (bone) map.outputScale = vrmTuning.poseGazeMaxDegrees;
    }
  }

  reset() {
    if (!this.previous || !this.vrm.lookAt) return;
    const lookAt = this.vrm.lookAt;
    for (const { map, inputMaxValue, outputScale } of this.ranges) {
      map.inputMaxValue = inputMaxValue;
      map.outputScale = outputScale;
    }
    this.ranges = [];
    lookAt.target = this.previous.target;
    lookAt.autoUpdate = this.previous.autoUpdate;
    lookAt.yaw = this.previous.yaw;
    lookAt.pitch = this.previous.pitch;
    this.previous = undefined;
  }
}
