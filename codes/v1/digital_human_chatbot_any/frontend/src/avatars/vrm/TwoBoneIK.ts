import * as THREE from 'three';

function aim(
  node: THREE.Object3D,
  direction: THREE.Vector3,
  target: THREE.Vector3,
  weight: number,
) {
  const currentWorld = node.getWorldQuaternion(new THREE.Quaternion());
  const desiredWorld = new THREE.Quaternion()
    .setFromUnitVectors(direction.normalize(), target.normalize())
    .multiply(currentWorld);
  const parentWorld =
    node.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  node.quaternion.slerp(parentWorld.invert().multiply(desiredWorld), weight);
  node.updateWorldMatrix(true, true);
}

/** Analytic normalized-bone IK. Lengths remain fixed; unreachable targets are
 * clamped. The pole selects an elbow/knee bend plane rather than raw angles. */
export function solveTwoBoneIK(
  root: THREE.Object3D,
  middle: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  weight = 1,
) {
  const amount = Math.max(0, Math.min(1, weight));
  if (amount === 0) return;
  root.updateWorldMatrix(true, true);
  const start = root.getWorldPosition(new THREE.Vector3());
  const joint = middle.getWorldPosition(new THREE.Vector3());
  const tip = end.getWorldPosition(new THREE.Vector3());
  const a = start.distanceTo(joint);
  const b = joint.distanceTo(tip);
  if (a < 1e-6 || b < 1e-6) return;
  const axis = target.clone().sub(start);
  const distance = axis.length();
  if (distance < 1e-6) return;
  axis.divideScalar(distance);
  const reach = Math.max(Math.abs(a - b) + 1e-8, Math.min(a + b - 1e-8, distance));
  const plane = pole.clone().sub(start);
  plane.addScaledVector(axis, -plane.dot(axis));
  if (plane.lengthSq() < 1e-10) {
    plane.set(Math.abs(axis.z) < 0.9 ? 0 : 1, 0, Math.abs(axis.z) < 0.9 ? 1 : 0);
    plane.addScaledVector(axis, -plane.dot(axis));
  }
  plane.normalize();
  const along = (a * a - b * b + reach * reach) / (2 * reach);
  const bend = Math.sqrt(Math.max(0, a * a - along * along));
  const desiredJoint = start.clone().addScaledVector(axis, along).addScaledVector(plane, bend);
  const reachableTarget = start.clone().addScaledVector(axis, reach);
  aim(root, joint.clone().sub(start), desiredJoint.sub(start), amount);
  const actualJoint = middle.getWorldPosition(new THREE.Vector3());
  const actualTip = end.getWorldPosition(new THREE.Vector3());
  aim(middle, actualTip.sub(actualJoint), reachableTarget.sub(actualJoint), amount);
}

export function setWorldQuaternion(node: THREE.Object3D, value: THREE.Quaternion, weight = 1) {
  const parent = node.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  node.quaternion.slerp(parent.invert().multiply(value), weight);
  node.updateWorldMatrix(true, true);
}
