import type { MouthCue, LipSyncMode } from '@digital-human/shared';
import { SpeechQueuePlayer } from './SpeechQueuePlayer';

/** Single-clip entry point retained for standalone playback checks and callers. */
export class SpeechPlayer extends SpeechQueuePlayer {
  async play(
    url: string,
    cues: MouthCue[],
    started: () => void,
    ended: () => void,
    mode: LipSyncMode = 'rhubarb',
  ) {
    let failure: Error | undefined;
    this.begin({
      phraseStarted: started,
      phraseTime: () => {},
      ended,
      failed: (error) => {
        failure = error;
      },
    });
    await this.enqueue({
      phraseIndex: 0,
      text: '',
      performance: { emotion: 'neutral', gestures: [] },
      audioUrl: url,
      duration: 0,
      cues,
      lipSyncMode: mode,
    });
    this.finish(1);
    if (failure) throw failure;
  }
}
