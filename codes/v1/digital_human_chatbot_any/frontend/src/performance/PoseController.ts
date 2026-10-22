import { poseNameSchema, type Gesture, type PoseName } from '@digital-human/shared';
import { poseLibrary } from './poseLibrary';
import { angryHop } from './motionLibrary';
import { blendBodyPose, type PerformancePose } from './poseComposer';
import type { PerformancePlayback, PoseActionEvent } from './events';

type Action = {
  name: PoseName;
  strength: number;
  hold: number;
  time: number;
  origin: number;
  clock: 'preview' | 'speech' | 'tail';
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
  private phraseOffset = 0;
  private phraseDuration = 0;
  private paused = false;
  observe?: (event: PoseActionEvent) => void;

  private start(name: PoseName, strength: number, hold: number, clock: Action['clock']) {
    const next: Action = {
      name,
      strength: Math.max(0, Math.min(1, strength)),
      hold: name === 'angry_hop' && clock === 'speech' ? 2.1 : Math.max(0.5, Math.min(10, hold)),
      time: clock === 'speech' ? this.phraseOffset : 0,
      origin: clock === 'speech' ? this.phraseOffset : 0,
      clock,
    };
    if (this.visible && this.visible.weight > 0.001) {
      this.stop(undefined, 'replaced by another action');
      this.pending = next;
    } else {
      this.action = next;
      this.pending = undefined;
      this.releasing = undefined;
      this.observe?.({ action: next.name, status: 'started', reason: clock });
    }
  }

  preview(name: PoseName, strength: number, holdSeconds: number) {
    this.start(name, strength, holdSeconds, 'preview');
  }

  beginPhrase(gestures: Gesture[], duration = 0) {
    this.phraseOffset += this.phraseDuration;
    this.phraseDuration = Math.max(0, duration);
    if (this.previewing) return;
    const gesture = gestures.find((item) => poseNameSchema.safeParse(item.name).success);
    if (gesture) this.start(gesture.name as PoseName, gesture.strength, this.holdSeconds, 'speech');
    else if (this.action?.name !== 'angry_hop' && this.pending?.name !== 'angry_hop')
      this.stop('speech', 'next phrase has no held pose');
  }

  playbackTime(seconds: number) {
    for (const action of [this.action, this.pending])
      if (action?.clock === 'speech') action.time = this.phraseOffset + Math.max(0, seconds);
  }

  setPlaybackState(state: PerformancePlayback) {
    if (state === 'stopped') {
      this.stop(undefined, 'playback stopped or interrupted');
      this.phraseOffset = this.phraseDuration = 0;
      this.paused = false;
      return;
    }
    const action = this.pending ?? this.action;
    if (state === 'paused' || state === 'playing') {
      const paused = state === 'paused';
      if (paused !== this.paused && action)
        this.observe?.({ action: action.name, status: paused ? 'paused' : 'resumed' });
      this.paused = paused;
    }
    if (state === 'ended' || state === 'buffering') {
      this.playbackTime(this.phraseDuration);
      for (const item of [this.action, this.pending])
        if (item?.name === 'angry_hop' && item.clock === 'speech') item.clock = 'tail';
    }
  }

  stop(clock?: Action['clock'], reason = 'pose stopped') {
    if (clock && this.action?.clock !== clock && this.pending?.clock !== clock) return;
    if (this.visible && this.visible.weight > 0.001) this.releasing = { ...this.visible, time: 0 };
    for (const item of [this.action, this.pending])
      if (item) this.observe?.({ action: item.name, status: 'cancelled', reason });
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
        if (this.action)
          this.observe?.({
            action: this.action.name,
            status: 'started',
            reason: this.action.clock,
          });
        this.pending = undefined;
      }
    } else if (this.action) {
      const action = this.action;
      if (action.clock === 'preview' || (action.clock === 'tail' && !this.paused))
        action.time += step;
      const time = Math.max(0, action.time - action.origin);
      const envelope =
        smooth(time / transitionSeconds) *
        (1 - smooth((time - transitionSeconds - action.hold) / transitionSeconds));
      const preset = poseLibrary[action.name];
      layer = {
        pose: action.name === 'angry_hop' ? angryHop(time) : preset.pose,
        fullBody: preset.fullBody,
        weight:
          envelope *
          action.strength *
          (action.clock === 'speech' && action.name !== 'angry_hop' ? speakingLevel : 1),
      };
      if (time >= action.hold + transitionSeconds * 2) {
        this.observe?.({ action: action.name, status: 'completed' });
        this.action = undefined;
      }
    }
    this.visible = layer;
    const targetFrame = layer?.fullBody && layer.weight > 0.001 ? 1 : 0;
    this.camera += (targetFrame - this.camera) * (1 - Math.exp(-step * 7));
    const result = layer ? blendBodyPose(base, layer.pose, layer.weight) : base;
    if (layer?.pose.expressions.angry) {
      result.expressions.angry = Math.max(
        result.expressions.angry ?? 0,
        layer.pose.expressions.angry * layer.weight,
      );
      result.expressions.happy = (result.expressions.happy ?? 0) * (1 - layer.weight);
    }
    return result;
  }
}
