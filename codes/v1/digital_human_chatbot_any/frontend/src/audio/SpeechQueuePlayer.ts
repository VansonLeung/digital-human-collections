import type { ServerEvent } from '@digital-human/shared';
import type { Shape } from '../avatars/types';
import { AmplitudeEnvelope } from './amplitude';

type SpeechReady = Extract<ServerEvent, { type: 'speech.ready' }>;

export type PlayablePhrase = Pick<
  SpeechReady,
  'phraseIndex' | 'text' | 'performance' | 'audioUrl' | 'duration' | 'cues' | 'lipSyncMode'
>;

type Callbacks = {
  phraseStarted: (phrase: PlayablePhrase) => void;
  phraseTime: (seconds: number) => void;
  ended: () => void;
  failed: (error: Error) => void;
};

type ScheduledPhrase = {
  phrase: PlayablePhrase;
  source: AudioBufferSourceNode;
  start: number;
  end: number;
};

/** Fetches ahead and schedules contiguous phrases on a single audio clock. */
export class SpeechQueuePlayer {
  private context?: AudioContext;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private envelope = new AmplitudeEnvelope();
  private generation = 0;
  private controller = new AbortController();
  private loaded = new Map<number, { phrase: PlayablePhrase; buffer: AudioBuffer }>();
  private scheduled = new Map<number, ScheduledPhrase>();
  private received = new Set<number>();
  private nextToSchedule = 0;
  private completed = 0;
  private expected?: number;
  private scheduledEnd = 0;
  private current?: ScheduledPhrase;
  private active = false;
  private frame = 0;
  private lastTime = 0;
  private callbacks?: Callbacks;

  paused = false;
  muted = false;

  constructor(
    private mouth: (shape: Shape) => void,
    private mouthOpening: (value: number) => void,
    private speaking: (value: boolean) => void = () => {},
    private playbackGain = 1,
  ) {}

  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.gain);
      this.gain.connect(this.context.destination);
    }
    await this.context.resume();
  }

  begin(callbacks: Callbacks) {
    this.stop();
    this.callbacks = callbacks;
    this.active = true;
    this.controller = new AbortController();
  }

  async enqueue(phrase: PlayablePhrase) {
    if (!this.active || this.received.has(phrase.phraseIndex)) return;
    if (
      phrase.phraseIndex >= 32 ||
      (this.expected !== undefined && phrase.phraseIndex >= this.expected)
    ) {
      this.fail(new Error('Invalid speech phrase order.'));
      return;
    }
    this.received.add(phrase.phraseIndex);
    const generation = this.generation;
    const signal = this.controller.signal;

    try {
      if (!this.context || !this.paused) await this.unlock();
      if (generation !== this.generation) return;
      const response = await fetch(phrase.audioUrl, { signal });
      if (!response.ok) throw new Error('Audio expired. Send another message.');
      const buffer = await this.context!.decodeAudioData(await response.arrayBuffer());
      if (generation !== this.generation) return;
      this.applyPlaybackGain(buffer);
      this.loaded.set(phrase.phraseIndex, { phrase, buffer });
      this.schedule();
    } catch (error) {
      if (generation === this.generation && !signal.aborted) this.fail(error as Error);
    }
  }

  private applyPlaybackGain(buffer: AudioBuffer) {
    if (this.playbackGain === 1) return;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
      buffer.getChannelData(channel),
    );
    let peak = 0;
    for (const samples of channels)
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    if (!peak) return;
    // Boost each clip consistently without letting its loudest peak clip.
    const gain = Math.min(this.playbackGain, 0.98 / peak);
    for (const samples of channels)
      for (let index = 0; index < samples.length; index++) samples[index] *= gain;
  }

  finish(phraseCount: number) {
    if (!this.active) return;
    if (
      phraseCount < 1 ||
      phraseCount > 32 ||
      [...this.received].some((index) => index >= phraseCount)
    ) {
      this.fail(new Error('Invalid speech queue completion.'));
      return;
    }
    this.expected = phraseCount;
    this.checkComplete();
  }

  private schedule() {
    const context = this.context!;
    while (this.loaded.has(this.nextToSchedule)) {
      const { phrase, buffer } = this.loaded.get(this.nextToSchedule)!;
      this.loaded.delete(this.nextToSchedule++);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser!);
      const start = Math.max(context.currentTime + 0.025, this.scheduledEnd);
      const entry = {
        phrase: { ...phrase, duration: buffer.duration },
        source,
        start,
        end: start + buffer.duration,
      };
      this.scheduledEnd = entry.end;
      this.scheduled.set(phrase.phraseIndex, entry);
      source.onended = () => {
        if (!this.scheduled.has(phrase.phraseIndex)) return;
        source.disconnect();
        this.scheduled.delete(phrase.phraseIndex);
        this.completed++;
        this.tick();
        this.checkComplete();
      };
      source.start(start);
    }
    if (!this.frame) {
      this.lastTime = context.currentTime;
      this.frame = requestAnimationFrame(this.animate);
    }
  }

  private tick() {
    if (!this.context || !this.active) return;
    const time = this.context.currentTime;
    const dt = Math.min(Math.max(0, time - this.lastTime), 0.1);
    const entry = [...this.scheduled.values()].find(
      (item) => time >= item.start && time < item.end,
    );

    if (entry && entry !== this.current) {
      this.current = entry;
      this.callbacks?.phraseStarted(entry.phrase);
    }

    if (!entry || this.paused || this.context.state !== 'running') {
      this.clearMouth();
      this.speaking(false);
    } else {
      this.speaking(true);
      const position = time - entry.start;
      this.callbacks?.phraseTime(position);
      if (entry.phrase.lipSyncMode === 'amplitude') {
        this.mouthOpening(this.envelope.sample(this.analyser!, dt));
      } else {
        const cue = entry.phrase.cues.find((item) => position >= item.start && position < item.end);
        this.mouth(cue?.shape ?? 'X');
      }
    }
    this.lastTime = time;
  }

  private animate = () => {
    this.frame = 0;
    this.tick();
    if (this.active) this.frame = requestAnimationFrame(this.animate);
  };

  private checkComplete() {
    if (!this.active || this.expected === undefined || this.completed !== this.expected) return;
    this.active = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.clearMouth();
    this.speaking(false);
    this.callbacks?.ended();
  }

  private fail(error: Error) {
    const failed = this.callbacks?.failed;
    this.stop();
    failed?.(error);
  }

  private clearMouth() {
    this.envelope.reset();
    this.mouth('X');
  }

  async togglePause() {
    if (!this.context || !this.active) return;
    if (this.paused) await this.context.resume();
    else await this.context.suspend();
    this.paused = !this.paused;
    if (this.paused) {
      this.clearMouth();
      this.speaking(false);
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  stop() {
    this.generation++;
    this.active = false;
    this.controller.abort();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const { source } of this.scheduled.values()) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.loaded.clear();
    this.scheduled.clear();
    this.received.clear();
    this.nextToSchedule = 0;
    this.completed = 0;
    this.expected = undefined;
    this.scheduledEnd = 0;
    this.current = undefined;
    this.paused = false;
    this.clearMouth();
    this.speaking(false);
  }

  dispose() {
    this.stop();
    void this.context?.close();
  }
}
