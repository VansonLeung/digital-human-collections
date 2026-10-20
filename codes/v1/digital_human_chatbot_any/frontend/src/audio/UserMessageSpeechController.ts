import {
  userPhraseListSchema,
  userSpeechPlanSchema,
  type UserSpeechPlan,
  type ReplyLanguage,
  type ReplyDiagnostic,
  type ConversationPreferences,
} from '@digital-human/shared';
import { SpeechQueuePlayer } from './SpeechQueuePlayer';

export type UserSpeechContext = Partial<ConversationPreferences> & {
  sessionId: string;
  revision: number;
  language: ReplyLanguage;
  localizedProfanity?: boolean;
};
export type UserSpeechState = {
  phase: 'idle' | 'preparing' | 'preview' | 'synthesizing' | 'speaking' | 'paused';
  plan?: UserSpeechPlan;
  /** Origin of the current operation or retained phrase plan. */
  automatic: boolean;
};
type Callbacks = {
  changed: (state: UserSpeechState) => void;
  phraseStarted: (group: string, index: number, text: string) => void;
  interrupted: (group: string) => void;
  commit: (text: string, context: UserSpeechContext, group: string, automatic: boolean) => boolean;
  error: (message: string, diagnostic?: ReplyDiagnostic) => void;
};

class SpokenMessageError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: ReplyDiagnostic,
  ) {
    super(message);
  }
}

/** Both phrase generators feed this queue. User audio never owns avatar callbacks
 * and a cancelled or failed queue never commits a message to the conversation. */
export class UserMessageSpeechController {
  private player = new SpeechQueuePlayer(
    () => {},
    () => {},
  );
  private operation?: { controller: AbortController; group: string; speaking: boolean };
  private value: UserSpeechState = { phase: 'idle', automatic: false };

  constructor(private callbacks: Callbacks) {}

  get state() {
    return this.value;
  }
  private update(value: Partial<UserSpeechState>) {
    this.value = { ...this.value, ...value };
    this.callbacks.changed(this.value);
  }
  unlock() {
    return this.player.unlock();
  }
  setMuted(value: boolean) {
    this.player.setMuted(value);
  }

  cancel(clearPreview = false) {
    const operation = this.operation;
    this.operation = undefined;
    operation?.controller.abort();
    this.player.stop();
    if (operation?.speaking) this.callbacks.interrupted(operation.group);
    this.update({
      phase: clearPreview || !this.value.plan ? 'idle' : 'preview',
      ...(clearPreview ? { plan: undefined } : {}),
      automatic: clearPreview || !this.value.plan ? false : this.value.automatic,
    });
  }

  edit(index: number, text: string) {
    if (this.value.phase !== 'preview' || !this.value.plan) return;
    const phrases = [...this.value.plan.phrases];
    phrases[index] = text;
    this.update({ plan: { ...this.value.plan, phrases } });
  }

  async prepare(
    context: UserSpeechContext,
    kind: 'automatic' | 'rewrite',
    text = '',
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return;
    this.cancel(true);
    const operation = {
      controller: new AbortController(),
      group: crypto.randomUUID(),
      speaking: false,
    };
    this.operation = operation;
    const abort = () => this.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    this.update({ phase: 'preparing', automatic: kind === 'automatic' });
    try {
      const result = await this.post(
        context,
        'prepare',
        {
          kind,
          ...(kind === 'rewrite'
            ? { text }
            : {
                localizedProfanity: context.localizedProfanity ?? false,
                getToKnowEachOther: context.getToKnowEachOther ?? false,
                aboutMe: context.aboutMe ?? '',
              }),
          language: context.language,
        },
        operation.controller.signal,
      );
      if (this.operation !== operation || operation.controller.signal.aborted) return;
      const plan = userSpeechPlanSchema.parse(result);
      if (plan.revision !== context.revision)
        throw new Error('The conversation changed. Prepare the message again.');
      this.update({ phase: 'preview', plan });
      return plan;
    } catch (error) {
      if (!operation.controller.signal.aborted) {
        this.update({ phase: 'idle', automatic: false });
        this.report(error);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.operation === operation) this.operation = undefined;
    }
  }

  async speak(
    context: UserSpeechContext,
    automatic = false,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const plan = this.value.plan;
    if (!plan || signal?.aborted) return false;
    const parsed = userPhraseListSchema.safeParse(plan.phrases);
    if (!parsed.success) {
      this.callbacks.error(
        'Use one to eight nonblank phrases, each at most 600 characters and 4000 characters total.',
      );
      return false;
    }
    if (plan.revision !== context.revision) {
      this.callbacks.error('The conversation changed. Prepare the message again.');
      return false;
    }
    this.cancel();
    const operation = {
      controller: new AbortController(),
      group: crypto.randomUUID(),
      speaking: true,
    };
    this.operation = operation;
    const controller = operation.controller;
    const audioUrls: string[] = [];
    const abort = () => this.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    this.update({ phase: 'synthesizing', automatic });
    let ended!: () => void;
    let failed!: (error: unknown) => void;
    const playback = new Promise<void>((resolve, reject) => {
      ended = resolve;
      failed = reject;
    });
    const cancelled = () => failed(new DOMException('Spoken message cancelled.', 'AbortError'));
    controller.signal.addEventListener('abort', cancelled, { once: true });
    this.player.begin({
      phraseStarted: (phrase) => {
        if (this.operation !== operation || controller.signal.aborted) return;
        this.update({ phase: this.player.paused ? 'paused' : 'speaking' });
        this.callbacks.phraseStarted(operation.group, phrase.phraseIndex, phrase.text);
      },
      phraseTime: () => {},
      ended,
      failed: (error) => {
        failed(error);
        controller.abort();
      },
    });
    try {
      await Promise.all([
        playback,
        (async () => {
          for (const [phraseIndex, text] of parsed.data.entries()) {
            const audio = await this.post(
              context,
              'speech',
              { text, language: plan.language },
              controller.signal,
            );
            if (
              typeof audio.audioUrl !== 'string' ||
              typeof audio.duration !== 'number' ||
              audio.revision !== context.revision
            )
              throw new Error('The spoken-message audio response was invalid.');
            audioUrls.push(audio.audioUrl);
            controller.signal.throwIfAborted();
            await this.player.enqueue({
              phraseIndex,
              text,
              audioUrl: audio.audioUrl,
              duration: audio.duration,
              performance: { emotion: 'neutral', gestures: [] },
              cues: [],
              lipSyncMode: 'amplitude',
            });
          }
          this.player.finish(parsed.data.length);
        })(),
      ]);
      if (controller.signal.aborted || this.operation !== operation) return false;
      // Detach before committing: app state changes must not cancel a completed
      // queue or mark its already-spoken bubbles as interrupted.
      this.operation = undefined;
      const sent = this.callbacks.commit(
        parsed.data.join(' '),
        { ...context, language: plan.language },
        operation.group,
        automatic,
      );
      if (!sent) {
        this.callbacks.interrupted(operation.group);
        this.callbacks.error(
          'The spoken reply was not sent because the conversation changed. Review it and try again.',
        );
      }
      this.update({
        phase: sent ? 'idle' : 'preview',
        plan: sent ? undefined : plan,
        automatic: sent ? false : automatic,
      });
      return sent;
    } catch (error) {
      const current = this.operation === operation;
      if (current) {
        this.operation = undefined;
        this.callbacks.interrupted(operation.group);
        this.update({ phase: 'preview' });
      }
      if (current && !(error instanceof DOMException && error.name === 'AbortError'))
        this.report(error);
      return false;
    } finally {
      controller.abort();
      controller.signal.removeEventListener('abort', cancelled);
      signal?.removeEventListener('abort', abort);
      if (!this.operation || this.operation === operation) this.player.stop();
      void Promise.allSettled(audioUrls.map((url) => fetch(url, { method: 'DELETE' })));
    }
  }

  async togglePause() {
    await this.player.togglePause();
    if (this.operation?.speaking)
      this.update({ phase: this.player.paused ? 'paused' : 'speaking' });
  }

  private async post(context: UserSpeechContext, path: string, body: object, signal: AbortSignal) {
    const response = await fetch(`/api/sessions/${context.sessionId}/user-message/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, revision: context.revision }),
      signal,
    });
    const result = await response.json();
    if (!response.ok)
      throw new SpokenMessageError(
        result.error || 'The spoken-message request failed.',
        result.diagnostic,
      );
    return result;
  }
  private report(error: unknown) {
    this.callbacks.error(
      error instanceof Error ? error.message : 'Spoken message failed.',
      error instanceof SpokenMessageError ? error.diagnostic : undefined,
    );
  }
  dispose() {
    this.cancel(true);
    this.player.dispose();
  }
}
