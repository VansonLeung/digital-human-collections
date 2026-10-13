import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { Emotion, PhrasePerformance } from '@digital-human/shared';
import type { AvatarRenderer, Shape } from '../types';
import { openness } from '../types';
import { PerformanceController } from '../../performance/PerformanceController';
import { VrmRigAdapter } from './VrmRigAdapter';

/** Scene and drawing only; rig binding and performance planning are separate. */
export class VrmRenderer implements AvatarRenderer {
  readonly supportedGestures = ['nod', 'shake_head', 'wave', 'open_hand', 'shrug'] as const;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private vrm?: VRM;
  private rig?: VrmRigAdapter;
  private observer: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private last = performance.now();
  private opening = 0;
  private performance = new PerformanceController();

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
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const height = box.max.y - box.min.y;
    const focus = box.min.y + height * 0.82;
    this.camera.position.set(0, focus, height * 1.08);
    this.camera.lookAt(0, focus, 0);
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

  setPlaybackTime(seconds: number) {
    this.performance.setPlaybackTime(seconds);
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (this.vrm && this.rig) {
      this.rig.applyPose(this.performance.update(dt, this.opening, now), dt);
      this.vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
