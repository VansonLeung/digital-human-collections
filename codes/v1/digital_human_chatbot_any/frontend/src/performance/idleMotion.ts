import type { Emotion } from '@digital-human/shared';
import { emotionProfiles } from './emotions';

// One phrase-level envelope drives expression and posture. Audio energy only
// accents gestures, so silence between syllables doesn't switch the smile off.
export class TalkingPerformance {
  speaking = false;
  emotion: Emotion = 'neutral';
  level = 0;
  energy = 0;
  time = 0;

  setEmotion(emotion: Emotion) {
    this.emotion = emotion;
    this.time = 0;
  }

  update(dt: number, opening: number) {
    dt = Math.max(0, Math.min(dt, 0.1));
    if (this.speaking) this.time += dt;
    this.level +=
      ((this.speaking ? 1 : 0) - this.level) * (1 - Math.exp(-dt / (this.speaking ? 0.25 : 0.4)));
    this.energy += ((this.speaking ? opening : 0) - this.energy) * (1 - Math.exp(-dt / 0.14));
    const emphasis = this.level * (0.35 + 0.65 * this.energy);
    const emotion = emotionProfiles[this.emotion];
    return {
      nod: Math.sin(this.time * 5.2) * 0.045 * emphasis,
      sway: Math.sin(this.time * 1.7) * 0.018 * this.level,
      rightHand: this.gesture(0.25, 2.8) * this.level,
      leftHand: this.gesture(4.1, 2.5) * this.level,
      smile: emotion.happy * this.level,
      sad: emotion.sad * this.level,
      surprised: emotion.surprised * this.level,
      relaxed: emotion.relaxed * this.level,
      angry: emotion.angry * this.level,
      thoughtful: emotion.thoughtful * this.level,
    };
  }

  private gesture(offset: number, duration: number) {
    const phase = (this.time % 8) - offset;
    return phase > 0 && phase < duration ? Math.sin((phase / duration) * Math.PI) ** 2 : 0;
  }
}
