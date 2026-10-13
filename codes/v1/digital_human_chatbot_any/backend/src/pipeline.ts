import { randomUUID } from 'node:crypto';
import type { Command, Persona, MouthCue } from '@digital-human/shared';
import type { Config } from './config.js';
import type { Session, ActiveTurn } from './sessions.js';
import type { MediaStore } from './media.js';
import { answer } from './services/llm.js';
import { synthesize } from './services/tts.js';
import { mouthCues } from './services/lipsync.js';
import { UpstreamError } from './services/http.js';
import { resolveLanguage } from './services/language.js';
import { TaggedReplyParser } from './llm/taggedReplyParser.js';
import { PhraseQueue } from './speech/phraseQueue.js';

export type Services = {
  answer: typeof answer;
  synthesize: typeof synthesize;
  mouthCues: typeof mouthCues;
};

export const services: Services = { answer, synthesize, mouthCues };

export async function runTurn(
  config: Config,
  session: Session,
  command: Extract<Command, { type: 'turn.send' }>,
  personas: Persona[],
  media: MediaStore,
  adapters: Services = services,
) {
  if (session.active) {
    session.send({
      type: 'error',
      stage: 'session',
      message: 'Stop the current response before sending another.',
      retryable: false,
    });
    return;
  }

  if (!personas.some((persona) => persona.id === command.personaId)) {
    session.send({
      type: 'error',
      stage: 'persona',
      message: 'Unknown persona.',
      retryable: false,
    });
    return;
  }

  const turn: ActiveTurn = {
    id: randomUUID(),
    controller: new AbortController(),
    mediaIds: new Set(),
  };
  session.active = turn;
  session.send({ type: 'turn.started', text: command.text });

  const current = () => session.valid(turn);
  const language = resolveLanguage(command.text, command.language, session.language);
  let stage = 'LLM';
  let speechFailureStage = 'TTS';
  let audioDuration = 0;

  const removeMedia = () => Promise.all([...turn.mediaIds!].map((id) => media.remove(id)));
  turn.controller.signal.addEventListener(
    'abort',
    () => {
      void removeMedia().catch(() => {});
    },
    { once: true },
  );

  function watchPlayback() {
    clearTimeout(turn.timeout);
    turn.timeout = setTimeout(
      () => {
        if (!current()) return;
        session.send({
          type: 'error',
          stage: 'playback',
          message: 'Playback did not finish. Please try again.',
          retryable: true,
        });
        session.finish(turn);
        turn.controller.abort();
      },
      (audioDuration + config.SPEECH_TIMEOUT_SECONDS + 90) * 1000,
    );
    turn.timeout.unref();
  }

  const queue = new PhraseQueue(async (phrase, phraseIndex) => {
    if (!current()) return;
    let phraseStage = 'TTS';
    try {
      if (!turn.playbackStarted) session.send({ type: 'state.changed', state: 'Preparing voice' });
      const wav = await adapters.synthesize(
        config,
        phrase.text,
        language,
        turn.controller.signal,
        phrase.performance.emotion,
      );
      if (!current()) return;
      audioDuration += wav.duration;
      if (audioDuration > 120) throw new Error('Reply speech exceeds duration limit');

      const item = await media.create(session.id, wav.bytes);
      turn.mediaIds!.add(item.id);
      if (!current()) {
        await media.remove(item.id);
        return;
      }

      let cues: MouthCue[] = [];
      if (config.LIPSYNC_PROVIDER === 'rhubarb') {
        phraseStage = 'lip sync';
        if (!turn.playbackStarted)
          session.send({ type: 'state.changed', state: 'Preparing mouth animation' });
        cues = await adapters.mouthCues(config, item.file, language, turn.controller.signal);
      }
      if (!current()) {
        await media.remove(item.id);
        return;
      }

      session.send({
        type: 'speech.ready',
        phraseIndex,
        text: phrase.text,
        performance: phrase.performance,
        audioUrl: `/api/sessions/${session.id}/media/${item.id}`,
        duration: wav.duration,
        cues,
        lipSyncMode: config.LIPSYNC_PROVIDER,
        personaId: command.personaId,
        language,
      });
      watchPlayback();
    } catch (error) {
      speechFailureStage = phraseStage;
      throw error;
    }
  }, turn.controller.signal);

  const parser = new TaggedReplyParser(
    (text) => {
      if (current()) session.send({ type: 'answer.delta', text });
    },
    (phrase) => {
      if (command.speech && current()) queue.push(phrase);
    },
  );

  try {
    session.send({ type: 'state.changed', state: 'Thinking' });
    const history = [...session.history, { role: 'user' as const, content: command.text }];
    let receivedDelta = false;
    const raw = await adapters.answer(
      config,
      history,
      language,
      (delta) => {
        if (!current()) return;
        receivedDelta = true;
        parser.write(delta);
      },
      turn.controller.signal,
    );

    if (!current()) return;
    if (!receivedDelta) parser.write(raw);
    const text = parser.finish();
    if (!text) throw new Error('LLM returned no spoken answer');

    session.history = [...history, { role: 'assistant' as const, content: text }].slice(-12);
    session.language = language;
    session.send({ type: 'answer.final', text });

    if (!command.speech) {
      session.finish(turn);
      return;
    }
    stage = 'speech';
    const phraseCount = await queue.finish();
    if (!current()) return;
    if (!phraseCount) throw new Error('No speech phrases');

    turn.speechFinished = true;
    session.send({ type: 'speech.queue.finished', phraseCount });
    watchPlayback();
  } catch (error) {
    await removeMedia();
    if (!current()) return;
    const failedStage = stage === 'speech' ? speechFailureStage : stage;
    const message =
      error instanceof UpstreamError
        ? error.message
        : failedStage === 'lip sync'
          ? 'Mouth animation failed. Check Rhubarb setup; the answer remains available.'
          : failedStage === 'TTS' && language === 'yue' && config.CANTONESE_TTS_ENABLED !== 'true'
            ? 'Cantonese voice is awaiting validation. Turn off spoken replies to continue in Cantonese text.'
            : `${failedStage} is unavailable or timed out. Check service readiness and backend configuration.`;
    session.send({
      type: 'error',
      stage: failedStage,
      message,
      retryable: !(error instanceof UpstreamError) || ![401, 403, 413, 422].includes(error.status),
    });
    session.finish(turn);
    turn.controller.abort();
  }
}
