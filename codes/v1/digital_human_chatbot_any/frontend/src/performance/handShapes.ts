import { rotation, type FingerBone, type PerformancePose } from './poseComposer';

/** Mirrored offsets for the normalized VRM rig; absent finger bones are optional. */
export const closedFists: PerformancePose['bones'] = {};

for (const side of ['left', 'right'] as const) {
  const mirror = side === 'left' ? -1 : 1;
  for (const finger of ['Index', 'Middle', 'Ring', 'Little'] as const) {
    for (const [joint, curl] of [
      ['Proximal', 1.25],
      ['Intermediate', 1.45],
      ['Distal', 0.9],
    ] as const)
      closedFists[`${side}${finger}${joint}` as FingerBone] = rotation(0, 0, mirror * curl);
  }
  // Bring the thumb across the curled fingers instead of leaving it splayed.
  closedFists[`${side}ThumbMetacarpal`] = rotation(0, -mirror * 0.65, mirror * 0.35);
  closedFists[`${side}ThumbProximal`] = rotation(0, -mirror * 0.45, mirror * 0.45);
  closedFists[`${side}ThumbDistal`] = rotation(0, 0, mirror * 0.5);
}
