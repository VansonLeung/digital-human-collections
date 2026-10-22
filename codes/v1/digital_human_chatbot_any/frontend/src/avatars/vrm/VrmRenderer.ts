import type { PerformancePlayback, PoseActionEvent } from '../../performance/events';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  gestureNameSchema,
  type Emotion,
  type PhrasePerformance,
  type PoseName,
} from '@digital-human/shared';
import type { AvatarRenderer, Shape } from '../types';
import { openness } from '../types';
import { PerformanceController } from '../../performance/PerformanceController';
import { VrmRigAdapter } from './VrmRigAdapter';
import { VrmGazeController } from './VrmGazeController';

/** Scene and drawing only; rig binding and performance planning are separate. */
export class VrmRenderer implements AvatarRenderer {
  readonly supportedGestures = gestureNameSchema.options;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private vrm?: VRM;
  private rig?: VrmRigAdapter;
  private gaze?: VrmGazeController;
  private observer: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private last = performance.now();
  private opening = 0;
  private performance = new PerformanceController();
  private framing?: { bottom: number; height: number };

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.host.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Animated 3D presenter');
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8580a5, 2.2));
    const key = new THREE.DirectionalLight(0xfff2e1, 2.3);
    key.position.set(2, 3, 3);
    this.scene.add(key);
    this.camera.position.set(0, 1.36, 2.2);
    this.camera.lookAt(0, 1.3, 0);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    this.animate();
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameCamera();
  }

  async load(url: string) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM;
    if (!vrm) throw new Error('Model has no VRM avatar');
    if (this.disposed) {
      VRMUtils.deepDispose(vrm.scene);
      return;
    }
    this.vrm = vrm;
    VRMUtils.rotateVRM0(vrm);
    this.scene.add(vrm.scene);
    this.rig = new VrmRigAdapter(vrm);
    this.gaze = new VrmGazeController(vrm);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const height = box.max.y - box.min.y;
    this.framing = { bottom: box.min.y, height };
    this.frameCamera();
  }

  setMouth(shape: Shape) {
    this.opening = openness[shape];
    this.rig?.setMouth(shape);
  }

  setMouthOpening(value: number) {
    this.opening = value;
    this.rig?.setMouthOpening(value);
  }

  setSpeaking(value: boolean) {
    this.performance.setSpeaking(value);
  }

  setEmotion(value: Emotion) {
    this.performance.setEmotion(value);
  }

  beginPhrase(value: PhrasePerformance, duration: number) {
    this.performance.beginPhrase(value, duration);
  }

  setPlaybackState(state: PerformancePlayback) {
    this.performance.setPlaybackState(state);
  }
  setPerformanceObserver(observer: (event: PoseActionEvent) => void) {
    this.performance.setPerformanceObserver(observer);
  }

  setPlaybackTime(seconds: number) {
    this.performance.setPlaybackTime(seconds);
  }

  previewPose(name: PoseName, strength: number, holdSeconds: number) {
    this.performance.previewPose(name, strength, holdSeconds);
  }
  stopPose() {
    this.performance.stopPose();
  }
  setPoseHoldSeconds(seconds: number) {
    this.performance.setPoseHoldSeconds(seconds);
  }

  private frameCamera() {
    if (!this.framing) return;
    const { bottom, height } = this.framing;
    const weight = this.performance.fullBodyWeight;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    // Fit both the raised hand and wide pointing stance, including on phones.
    const fullDistance = Math.max(
      (height * 0.8) / Math.tan(halfFov),
      (height * 0.65) / (Math.tan(halfFov) * this.camera.aspect),
    );
    const focus = bottom + height * (0.82 + (0.6 - 0.82) * weight);
    const distance = height * 1.08 + (fullDistance - height * 1.08) * weight;
    this.camera.position.set(0, focus, distance);
    this.camera.lookAt(0, focus, 0);
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (this.vrm && this.rig) {
      const pose = this.performance.update(dt, this.opening, now);
      this.rig.applyPose(pose, dt);
      this.frameCamera();
      this.gaze?.update(this.camera, pose.cameraGaze ?? 0);
      this.vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    this.gaze?.reset();
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
