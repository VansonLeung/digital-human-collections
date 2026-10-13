import type { AvatarRigAdapter } from '../rig';
import { openness, type Shape } from '../types';
import type { PerformancePose } from '../../performance/poseComposer';

type CubismParameters = {
  setParameterValueById(id: string, value: number): void;
  addParameterValueById(id: string, value: number, weight?: number): void;
};

/** Initial Live2D adapter: face and head only; unsupported body cues are omitted. */
export class Live2DRigAdapter implements AvatarRigAdapter {
  readonly supportedGestures = ['nod', 'shake_head'] as const;
  private target = 0;
  private value = 0;

  constructor(private core: CubismParameters) {}

  setMouth(shape: Shape) {
    this.target = openness[shape];
  }

  setMouthOpening(value: number) {
    this.target = Math.max(0, Math.min(1, value));
  }

  applyPose(pose: PerformancePose, dt: number) {
    this.value += (this.target - this.value) * (1 - Math.exp(-dt * 26));
    const smile = pose.expressions.happy ?? 0;
    const sad = pose.expressions.sad ?? 0;
    const surprised = pose.expressions.surprised ?? 0;
    const head = pose.bones.head;

    this.core.setParameterValueById('ParamMouthOpenY', this.value);
    // Apply after idle motion without writing these additions into its saved pose.
    this.core.addParameterValueById('ParamMouthForm', smile - sad);
    this.core.addParameterValueById('ParamEyeLSmile', smile * 0.8);
    this.core.addParameterValueById('ParamEyeRSmile', smile * 0.8);
    this.core.addParameterValueById('ParamBrowLY', surprised);
    this.core.addParameterValueById('ParamBrowRY', surprised);
    this.core.addParameterValueById('ParamAngleX', ((head?.y ?? 0) * 180) / Math.PI);
    this.core.addParameterValueById('ParamAngleY', ((head?.x ?? 0) * 180) / Math.PI);
    this.core.addParameterValueById('ParamAngleZ', ((head?.z ?? 0) * 180) / Math.PI);
  }
}
