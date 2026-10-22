import type { PerformancePlayback, PoseActionEvent } from '../performance/events';
import * as PIXI from 'pixi.js';
import type { AvatarRenderer, Shape } from './types';
import { openness } from './types';
import type { Emotion, PhrasePerformance } from '@digital-human/shared';
import { PerformanceController } from '../performance/PerformanceController';
import { Live2DRigAdapter } from './live2d/Live2DRigAdapter';

let corePromise: Promise<void> | undefined;

function loadCore() {
  corePromise ??= new Promise<void>((resolve, reject) => {
    if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = '/vendor/live2dcubismcore.min.js';
    script.onload = () => resolve();
    script.onerror = () => {
      corePromise = undefined;
      reject(new Error('Live2D Core is missing. Run npm run setup.'));
    };
    document.head.append(script);
  });
  return corePromise;
}

export class Live2DRenderer implements AvatarRenderer {
  readonly supportedGestures = ['nod', 'shake_head'] as const;
  private app: PIXI.Application;
  private model?: import('../vendor/pixi-live2d-display/cubism4.es.js').Live2DModel;
  private observer: ResizeObserver;
  private disposed = false;
  private target = 0;
  private rig?: Live2DRigAdapter;
  private performance = new PerformanceController();
  private last = performance.now();

  constructor(private host: HTMLElement) {
    this.app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(devicePixelRatio, 1.5),
      autoDensity: true,
    });
    host.appendChild(this.app.view as HTMLCanvasElement);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
  }

  async load(url: string) {
    await loadCore();
    (window as unknown as { PIXI: unknown }).PIXI = PIXI;
    const { Live2DModel, config } = await import('../vendor/pixi-live2d-display/cubism4.es.js');
    config.sound = false;
    Live2DModel.registerTicker(PIXI.Ticker);
    const model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: false });
    if (this.disposed) {
      model.destroy();
      return;
    }
    this.model = model;
    this.rig = new Live2DRigAdapter(model.internalModel.coreModel);
    this.app.stage.addChild(model);
    model.anchor.set(0.5, 0);
    model.internalModel.on('beforeModelUpdate', () => {
      const now = performance.now();
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      const motion = this.performance.update(dt, this.target);
      this.rig!.applyPose(motion, dt);
    });
    this.app.ticker.add(() => model.update(this.app.ticker.deltaMS));
    this.resize();
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.app.renderer.resize(w, h);
    if (this.model) {
      this.model.scale.set(1);
      const scale = Math.min((w * 0.88) / this.model.width, (h * 1.45) / this.model.height);
      this.model.scale.set(scale);
      this.model.position.set(w / 2, h * 0.035);
    }
  }

  setMouth(shape: Shape) {
    this.target = openness[shape];
    this.rig?.setMouth(shape);
  }

  setMouthOpening(value: number) {
    this.target = Math.max(0, Math.min(1, value));
    this.rig?.setMouthOpening(value);
  }

  setSpeaking(value: boolean) {
    this.performance.setSpeaking(value);
  }

  setEmotion(value: Emotion) {
    this.performance.setEmotion(value);
  }

  beginPhrase(value: PhrasePerformance, duration: number) {
    // This first adapter supports facial/head performance. Body gestures are omitted.
    const gestures = value.gestures.filter(
      (gesture) => gesture.name === 'nod' || gesture.name === 'shake_head',
    );
    this.performance.beginPhrase({ ...value, gestures }, duration);
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

  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    this.app.destroy(true, { children: true, texture: true, baseTexture: true });
  }
}
