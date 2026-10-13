import type { SpeechPhrase } from '@digital-human/shared';

/** One persistent TTS service, one inference at a time, ordered ready events. */
export class PhraseQueue {
  private work = Promise.resolve();
  private failure: unknown;
  private count = 0;

  constructor(
    private consume: (phrase: SpeechPhrase, index: number) => Promise<void>,
    private signal: AbortSignal,
  ) {}

  push(phrase: SpeechPhrase) {
    if (this.count >= 32) throw new Error('Too many speech phrases');
    const index = this.count++;

    this.work = this.work.then(async () => {
      if (this.failure || this.signal.aborted) return;
      try {
        await this.consume(phrase, index);
      } catch (error) {
        // Always observe failures even while the LLM is still streaming.
        this.failure = error;
      }
    });
  }

  async finish() {
    await this.work;
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    return this.count;
  }
}
