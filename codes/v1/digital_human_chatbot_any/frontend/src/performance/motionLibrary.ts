import { rotation, type PerformancePose } from './poseComposer';
import { closedFists } from './handShapes';

/** Three small hops, followed by a grounded angry stance. Audio time owns motion. */
export function angryHop(time: number): PerformancePose {
  const elapsed = Math.max(0, time - 0.35);
  const hopping = elapsed < 2.1;
  const phase = (elapsed % 0.7) / 0.7;
  const flight = hopping && phase >= 0.2 && phase < 0.85;
  const height = flight ? Math.sin(((phase - 0.2) / 0.65) * Math.PI) * 0.035 : 0;
  const crouch =
    hopping && !flight
      ? 0.009 * Math.sin((phase < 0.2 ? phase / 0.2 : (1 - phase) / 0.15) * Math.PI)
      : 0;
  const wave = hopping ? Math.sin(elapsed * Math.PI * 7) : 0;
  return {
    bones: {
      ...closedFists,
      spine: rotation(-0.04),
      chest: rotation(-0.05),
      head: rotation(-0.06, 0, wave * 0.025),
      leftUpperArm: rotation(-0.25, 0.1, 0.85 + wave * 0.55),
      rightUpperArm: rotation(-0.25, -0.1, -0.85 + wave * 0.55),
      leftLowerArm: rotation(0, -0.95, -0.18),
      rightLowerArm: rotation(0, 0.95, 0.18),
      leftHand: rotation(-0.15),
      rightHand: rotation(-0.15),
      leftUpperLeg: rotation(-crouch * 18),
      rightUpperLeg: rotation(-crouch * 18),
      leftLowerLeg: rotation(crouch * 36),
      rightLowerLeg: rotation(crouch * 36),
    },
    hipsDrop: crouch - height,
    expressions: { angry: 0.9 },
    contacts: { hands: {}, weight: 1, feet: !flight },
  };
}
