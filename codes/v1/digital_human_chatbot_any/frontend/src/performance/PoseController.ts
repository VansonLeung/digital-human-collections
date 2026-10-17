import { poseNameSchema, type Gesture, type PoseName } from '@digital-human/shared';
import { poseLibrary } from './poseLibrary';
import { blendBodyPose, type PerformancePose } from './poseComposer';

type Action = {
  name: PoseName;
  strength: number;
  hold: number;
  time: number;
  origin: number;
  clock: 'preview' | 'speech';
};
type Layer = { pose: PerformancePose; weight: number; fullBody: boolean };
const transitionSeconds = 0.35;
const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** One held body action owns the pose layer. Speech uses audio time; previews
 * use render time. Replacement first releases the previous contact targets. */
export class PoseController {
  holdSeconds = 3;
  private action?: Action;
  private pending?: Action;
  private visible?: Layer;
  private releasing?: Layer & { time: number };
  private camera = 0;

  private start(name: PoseName, strength: number, hold: number, clock: Action['clock']) {
    const next: Action = {
      name,
      strength: Math.max(0, Math.min(1, strength)),
      hold: Math.max(0.5, Math.min(10, hold)),
      time: 0,
      origin: 0,
      clock,
    };
    if (this.visible && this.visible.weight > 0.001) {
      this.stop();
      this.pending = next;
    } else {
      this.action = next;
      this.pending = undefined;
      this.releasing = undefined;
    }
  }

  preview(name: PoseName, strength: number, holdSeconds: number) {
    this.start(name, strength, holdSeconds, 'preview');
  }

  beginPhrase(gestures: Gesture[]) {
    if (this.previewing) return;
    const gesture = gestures.find((item) => poseNameSchema.safeParse(item.name).success);
    if (gesture) this.start(gesture.name as PoseName, gesture.strength, this.holdSeconds, 'speech');
    else this.stop('speech');
  }

  playbackTime(seconds: number) {
    for (const action of [this.action, this.pending])
      if (action?.clock === 'speech') action.time = Math.max(0, seconds);
  }

  stop(clock?: Action['clock']) {
    if (clock && this.action?.clock !== clock && this.pending?.clock !== clock) return;
    if (this.visible && this.visible.weight > 0.001) this.releasing = { ...this.visible, time: 0 };
    this.action = undefined;
    this.pending = undefined;
  }

  get previewing() {
    return this.action?.clock === 'preview' || this.pending?.clock === 'preview';
  }
  get fullBodyWeight() {
    return this.camera;
  }

  update(base: PerformancePose, dt: number, speakingLevel: number): PerformancePose {
    const step = Math.max(0, Math.min(0.1, dt));
    let layer: Layer | undefined;
    if (this.releasing) {
      this.releasing.time += step;
      layer = {
        ...this.releasing,
        weight: this.releasing.weight * (1 - smooth(this.releasing.time / transitionSeconds)),
      };
      if (this.releasing.time >= transitionSeconds) {
        this.releasing = undefined;
        this.action = this.pending;
        if (this.action) this.action.origin = this.action.time;
        this.pending = undefined;
      }
    } else if (this.action) {
      const action = this.action;
      if (action.clock === 'preview') action.time += step;
      const time = Math.max(0, action.time - action.origin);
      const envelope =
        smooth(time / transitionSeconds) *
        (1 - smooth((time - transitionSeconds - action.hold) / transitionSeconds));
      const preset = poseLibrary[action.name];
      layer = {
        pose: preset.pose,
        fullBody: preset.fullBody,
        weight: envelope * action.strength * (action.clock === 'speech' ? speakingLevel : 1),
      };
      if (time >= action.hold + transitionSeconds * 2) this.action = undefined;
    }
    this.visible = layer;
    const targetFrame = layer?.fullBody && layer.weight > 0.001 ? 1 : 0;
    this.camera += (targetFrame - this.camera) * (1 - Math.exp(-step * 7));
    return layer ? blendBodyPose(base, layer.pose, layer.weight) : base;
  }
}
