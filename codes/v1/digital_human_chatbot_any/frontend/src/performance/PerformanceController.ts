import type { Emotion, PhrasePerformance, PoseName } from '@digital-human/shared';
import { TalkingPerformance } from './idleMotion';
import { gesturePose } from './gestureLibrary';
import { composePose, rotation, type PerformancePose } from './poseComposer';
import { PoseController } from './PoseController';

/** Combines idle motion and phrase instructions independently of any avatar SDK. */
export class PerformanceController {
  private idle = new TalkingPerformance();
  private poses = new PoseController();
  private phrase?: PhrasePerformance;
  private duration = 0;
  private elapsed = 0;
  private expressionWeights = { happy: 0, sad: 0, surprised: 0, relaxed: 0, angry: 0 };

  setSpeaking(speaking: boolean) {
    this.idle.speaking = speaking;
  }

  setEmotion(emotion: Emotion) {
    this.phrase = undefined;
    this.idle.setEmotion(emotion);
  }

  beginPhrase(phrase: PhrasePerformance, duration: number) {
    this.phrase = phrase;
    this.duration = duration;
    this.elapsed = 0;
    this.idle.setEmotion(phrase.emotion);
    this.poses.beginPhrase(phrase.gestures);
  }

  setPlaybackTime(seconds: number) {
    this.elapsed = Math.max(0, seconds);
    this.poses.playbackTime(seconds);
  }

  previewPose(name: PoseName, strength: number, holdSeconds: number) {
    this.poses.preview(name, strength, holdSeconds);
  }
  stopPose() {
    this.poses.stop();
  }
  setPoseHoldSeconds(seconds: number) {
    this.poses.holdSeconds = Math.max(0.5, Math.min(10, seconds));
  }
  get fullBodyWeight() {
    return this.poses.fullBodyWeight;
  }

  update(dt: number, opening: number, now = performance.now()): PerformancePose {
    const motion = this.idle.update(dt, opening);
    const phase = (now / 1000) % 4.6;
    const base: PerformancePose = {
      bones: {
        head: rotation(
          this.phrase ? 0 : motion.nod,
          Math.sin(now * 0.0004) * 0.035,
          Math.sin(now * 0.0006) * 0.018 + motion.thoughtful * 0.16,
        ),
        spine: rotation(-0.012 * this.idle.level, 0, motion.sway * 0.45),
        chest: rotation(0, motion.sway * 0.6, motion.sway * 0.3),
        upperChest: rotation(0, motion.sway * 0.4),
      },
      expressions: {
        happy: motion.smile,
        sad: motion.sad,
        surprised: motion.surprised,
        relaxed: motion.relaxed,
        angry: motion.angry,
        blink: phase > 4.35 ? Math.sin(((phase - 4.35) / 0.25) * Math.PI) : 0,
      },
    };

    if (!this.phrase) {
      // Legacy untagged preview behavior. Explicit phrase plans suppress this loop.
      for (const side of ['left', 'right'] as const) {
        const sign = side === 'left' ? 1 : -1;
        const amount = side === 'left' ? motion.leftHand : motion.rightHand;
        base.bones[`${side}Shoulder`] = rotation(0, 0, sign * 0.025 * amount);
        base.bones[`${side}UpperArm`] = rotation(
          -0.12 * amount,
          sign * 0.06 * amount,
          sign * 0.55 * amount,
        );
        base.bones[`${side}LowerArm`] = rotation(0, -sign * 1.15 * amount);
        base.bones[`${side}Hand`] = rotation(-0.12 * amount, 0, sign * 0.12 * amount);
      }
    }

    const gestures =
      this.phrase?.gestures.map((gesture) =>
        gesturePose(gesture, this.elapsed, this.duration, this.idle.level),
      ) ?? [];
    const result = this.poses.update(composePose(base, ...gestures), dt, this.idle.level);
    for (const name of ['happy', 'sad', 'surprised', 'relaxed', 'angry'] as const) {
      this.expressionWeights[name] +=
        ((result.expressions[name] ?? 0) - this.expressionWeights[name]) *
        (1 - Math.exp(-Math.min(dt, 0.1) * 10));
      result.expressions[name] = this.expressionWeights[name];
    }
    return result;
  }
}
