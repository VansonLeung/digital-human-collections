import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  VRMLookAtBoneApplier,
  VRMLookAtExpressionApplier,
  VRMLookAtRangeMap,
  VRMExpressionManager,
  VRMExpression,
  type VRM,
  type VRMHumanoid,
} from '@pixiv/three-vrm';
import { poseNameSchema, llmPhraseSchema } from '@digital-human/shared';
import { PoseController } from '../../frontend/src/performance/PoseController.js';
import { solveTwoBoneIK } from '../../frontend/src/avatars/vrm/TwoBoneIK.js';
import { VrmGazeController } from '../../frontend/src/avatars/vrm/VrmGazeController.js';
import type { PerformancePose } from '../../frontend/src/performance/poseComposer.js';

const base: PerformancePose = { bones: {}, expressions: { happy: 0.6, blink: 0.2 } };

test('all pose names validate as LLM gestures without changing phrase or emotion', () => {
  for (const name of poseNameSchema.options) {
    const phrase = llmPhraseSchema.parse({
      phrase: 'Hello',
      emotion: 'happy',
      gestures: [{ name, strength: 0.9 }],
    });
    assert.equal(phrase.phrase, 'Hello');
    assert.equal(phrase.gestures[0].name, name);
  }
  assert.equal(
    llmPhraseSchema.safeParse({
      phrase: 'Hello',
      emotion: 'happy',
      gestures: [{ name: 'invented_pose', strength: 0.9 }],
    }).success,
    false,
  );
});

test('previews hold without speech, preserve facial weights, then release to idle', () => {
  const controller = new PoseController();
  controller.preview('raise_hand', 0.8, 0.5);
  let pose = base;
  for (let i = 0; i < 5; i++) pose = controller.update(base, 0.1, 0);
  assert.ok((pose.bones.rightUpperArm?.z ?? 0) < -1.8);
  assert.deepEqual(pose.expressions, base.expressions);
  assert.ok(controller.fullBodyWeight > 0.8);
  for (let i = 0; i < 20; i++) pose = controller.update(base, 0.1, 0);
  assert.deepEqual(pose, base);
  assert.ok(controller.fullBodyWeight < 0.01);
});

test('LLM poses follow audio time across pause/resume and Stop discards queued replacements', () => {
  const controller = new PoseController();
  controller.beginPhrase([{ name: 'dramatic_lean', strength: 1 }]);
  controller.playbackTime(0.6);
  const held = controller.update(base, 0.1, 1);
  for (let i = 0; i < 50; i++) assert.deepEqual(controller.update(base, 0.1, 1).bones, held.bones);
  const paused = controller.update(base, 0.1, 0);
  assert.ok(Math.abs(paused.bones.spine?.z ?? 0) < 1e-6);
  assert.deepEqual(controller.update(base, 0.1, 1).bones, held.bones);
  controller.preview('raise_hand', 1, 3);
  controller.stop();
  for (let i = 0; i < 30; i++) controller.update(base, 0.1, 1);
  assert.deepEqual(controller.update(base, 0.1, 1), base);
  assert.equal(controller.previewing, false);
});

test('two-bone constraints reach hand/foot anchors without moving the root or stretching bones', () => {
  const scene = new THREE.Object3D();
  const root = new THREE.Object3D();
  const middle = new THREE.Object3D();
  const end = new THREE.Object3D();
  scene.add(root);
  root.add(middle);
  middle.add(end);
  root.position.set(0, 1.2, 0);
  middle.position.set(0, -0.7, 0);
  end.position.set(0, -0.5, 0);
  const target = new THREE.Vector3(0.3, 0.4, 0.1);
  solveTwoBoneIK(root, middle, end, target, new THREE.Vector3(0.2, 0.8, 0.5));
  assert.ok(end.getWorldPosition(new THREE.Vector3()).distanceTo(target) < 1e-6);
  assert.deepEqual(root.position.toArray(), [0, 1.2, 0]);
  assert.ok(Math.abs(middle.position.length() - 0.7) < 1e-6);
  assert.ok(Math.abs(end.position.length() - 0.5) < 1e-6);
  solveTwoBoneIK(root, middle, end, new THREE.Vector3(10, 10, 10), new THREE.Vector3(1, 0, 0));
  assert.ok(
    end
      .getWorldPosition(new THREE.Vector3())
      .distanceTo(root.getWorldPosition(new THREE.Vector3())) <= 1.2,
  );
  assert.ok(root.quaternion.toArray().every(Number.isFinite));
});

test('tsundere turn follows phrase time, preserves the face, and releases camera gaze', () => {
  const controller = new PoseController();
  controller.beginPhrase([{ name: 'tsundere_turn', strength: 1 }]);
  controller.playbackTime(0.6);
  const held = controller.update(base, 0.1, 1);
  const yaw = (held.bones.spine?.y ?? 0) + (held.bones.chest?.y ?? 0) + (held.bones.head?.y ?? 0);
  assert.ok(yaw > Math.PI / 6 && yaw < Math.PI / 4);
  assert.equal(held.cameraGaze, 1);
  assert.equal(held.contacts?.hands.leftHand, 'crossed');
  assert.deepEqual(held.expressions, base.expressions);
  assert.equal(controller.fullBodyWeight, 0);
  const paused = controller.update(base, 0.1, 0);
  assert.equal(paused.cameraGaze, 0);
  assert.deepEqual(controller.update(base, 0.1, 1), held);
  controller.stop();
  for (let i = 0; i < 5; i++) controller.update(base, 0.1, 0);
  assert.deepEqual(controller.update(base, 0.1, 0), base);
});

test('pose gaze blends toward the camera and restores existing tracking after release', () => {
  const head = new THREE.Object3D();
  const camera = new THREE.Object3D();
  camera.position.set(0, 1, 3);
  const originalTarget = new THREE.Object3D();
  const lookAt = {
    target: originalTarget as THREE.Object3D | null | undefined,
    autoUpdate: true,
    yaw: 8,
    pitch: 2,
    lookAt(position: THREE.Vector3) {
      assert.deepEqual(position.toArray(), [0, 1, 3]);
      this.yaw = -30;
      this.pitch = 10;
    },
  };
  let updates = 0;
  const vrm = {
    lookAt,
    humanoid: {
      update() {
        updates++;
      },
      getRawBoneNode() {
        return head;
      },
    },
  } as unknown as VRM;
  const gaze = new VrmGazeController(vrm);
  gaze.update(camera, 0.5);
  assert.equal(lookAt.target, undefined);
  assert.equal(lookAt.autoUpdate, false);
  assert.equal(lookAt.yaw, -11);
  assert.equal(lookAt.pitch, 6);
  gaze.update(camera, 1);
  assert.equal(lookAt.yaw, -30);
  assert.equal(updates, 2);
  gaze.update(camera, 0);
  assert.equal(lookAt.target, originalTarget);
  assert.equal(lookAt.autoUpdate, true);
  assert.equal(lookAt.yaw, 8);
  assert.equal(lookAt.pitch, 2);
  lookAt.target = null;
  lookAt.autoUpdate = false;
  gaze.update(camera, 1);
  gaze.reset();
  assert.equal(lookAt.target, null);
  assert.equal(lookAt.autoUpdate, false);
  assert.doesNotThrow(() => new VrmGazeController({} as VRM).update(camera, 1));
});

test('pose gaze calibrates actual eye rotation and expression weights, then restores model ranges', () => {
  const head = new THREE.Object3D();
  const left = new THREE.Object3D();
  const right = new THREE.Object3D();
  head.add(left, right);
  const normalized = { leftEye: new THREE.Object3D(), rightEye: new THREE.Object3D() };
  const raw = { leftEye: left, rightEye: right, head };
  const humanoid = {
    update() {},
    getRawBoneNode(name: keyof typeof raw) {
      return raw[name];
    },
    getNormalizedBoneNode(name: keyof typeof normalized) {
      return normalized[name];
    },
  } as unknown as VRMHumanoid;
  const ranges = (output: number) =>
    Array.from({ length: 4 }, () => new VRMLookAtRangeMap(90, output)) as [
      VRMLookAtRangeMap,
      VRMLookAtRangeMap,
      VRMLookAtRangeMap,
      VRMLookAtRangeMap,
    ];
  const boneApplier = new VRMLookAtBoneApplier(humanoid, ...ranges(10));
  const manager = new VRMExpressionManager();
  for (const name of ['lookLeft', 'lookRight', 'lookUp', 'lookDown'])
    manager.registerExpression(new VRMExpression(name));
  const expressionApplier = new VRMLookAtExpressionApplier(manager, ...ranges(1));
  for (const applier of [boneApplier, expressionApplier]) {
    const lookAt = {
      applier,
      yaw: 0,
      pitch: 0,
      autoUpdate: true,
      target: undefined,
      lookAt() {
        this.yaw = -40;
        this.pitch = 0;
      },
    };
    const gaze = new VrmGazeController({ lookAt, humanoid } as unknown as VRM);
    gaze.update(new THREE.Object3D(), 1);
    applier.applyYawPitch(lookAt.yaw, lookAt.pitch);
    if (applier === boneApplier) {
      const angle = (left.quaternion.angleTo(new THREE.Quaternion()) * 180) / Math.PI;
      assert.ok(angle > 11.9 && angle < 12.1, `Actual eye angle: ${angle}`);
    } else {
      assert.equal(manager.getValue('lookRight'), 1);
    }
    assert.equal(applier.rangeMapVerticalUp.inputMaxValue, 90);
    gaze.reset();
    for (const map of [applier.rangeMapHorizontalInner, applier.rangeMapHorizontalOuter]) {
      assert.equal(map.inputMaxValue, 90);
      assert.equal(map.outputScale, applier === boneApplier ? 10 : 1);
    }
    applier.applyYawPitch(lookAt.yaw, lookAt.pitch);
    assert.ok(left.quaternion.angleTo(new THREE.Quaternion()) < 1e-6);
    assert.equal(manager.getValue('lookRight'), 0);
  }
});
