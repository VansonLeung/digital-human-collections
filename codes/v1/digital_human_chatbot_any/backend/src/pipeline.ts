import { generateSceneContinuation, prepareScene } from './scenes/prepareScene.js';
import { randomUUID } from 'node:crypto';
import type {
  Command,
  Persona,
  MouthCue,
  LlmRequestBody,
  SpeechPhrase,
  ScenePlan,
  MemoryCandidate,
  SceneAgreement,
} from '@digital-human/shared';
import type { Config } from './config.js';
import type { Session, ActiveTurn } from './sessions.js';
import type { MediaStore } from './media.js';
import { answer, EmptyCompletionError } from './services/llm.js';
import { synthesize } from './services/tts.js';
import { mouthCues } from './services/lipsync.js';
import { UpstreamError } from './services/http.js';
import { resolveLanguage } from './services/language.js';
import { JsonReplyParser, ReplyFormatError } from './llm/JsonReplyParser.js';
import { repeatedReply, RepetitiveReplyError, repetitionAttempts } from './llm/repetition.js';
import { extractSceneMetadata, needsSceneExtraction } from './scenes/extractSceneMetadata.js';
import {
  proposeScene,
  sceneAgreementTarget,
  clearSpokenAgreement,
} from './scenes/SceneDirector.js';
import { PhraseQueue } from './speech/phraseQueue.js';
import { saveReplyDiagnostic } from './llm/diagnostics.js';

export type Services = {
  answer: typeof answer;
  synthesize: typeof synthesize;
  mouthCues: typeof mouthCues;
  sceneMetadata?: typeof extractSceneMetadata;
  continueScene?: typeof generateSceneContinuation;
};

export const services: Services = {
  answer,
  synthesize,
  mouthCues,
  sceneMetadata: extractSceneMetadata,
  continueScene: generateSceneContinuation,
};

export async function runTurn(
  config: Config,
  session: Session,
  command: Extract<Command, { type: 'turn.send' | 'turn.proactive' }>,
  personas: Persona[],
  media: MediaStore,
  adapters: Services = services,
) {
  const proactive = command.type === 'turn.proactive';
  if (
    proactive &&
    (!session.proactive.enabled ||
      !session.proactive.eligible ||
      session.active ||
      session.suggestion ||
      session.userSpeech ||
      session.transcription ||
      command.revision !== session.revision ||
      Date.now() - session.proactive.lastActivity < session.proactive.delaySeconds * 1000 ||
      !session.history.some((message) => message.role === 'assistant'))
  ) {
    session.send({ type: 'proactive.skipped' }, null);
    return;
  }
  if (!proactive && session.active?.origin === 'proactive') session.stop();
  if (
    !proactive &&
    command.expectedRevision !== undefined &&
    command.expectedRevision !== session.revision
  ) {
    session.send({
      type: 'error',
      stage: 'session',
      message:
        'The conversation changed before your spoken message was sent. Review it and try again.',
      retryable: false,
    });
    return;
  }
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

  session.configureScenes(command.virtualScenesEnabled ?? false);
  const turn: ActiveTurn = {
    id: randomUUID(),
    controller: new AbortController(),
    mediaIds: new Set(),
    origin: proactive ? 'proactive' : 'user',
    sceneVersion: session.scene.snapshot().enabled ? session.scene.snapshot().version : undefined,
  };
  session.suggestion?.abort();
  session.userSpeech?.abort();
  if (proactive) session.proactive.eligible = false;
  else {
    session.revision++;
    session.proactive.eligible = true;
    session.proactive.lastActivity = Date.now();
  }
  session.active = turn;
  const current = () => session.valid(turn);
  if (adapters.continueScene && session.scene.needsContinuation())
    await prepareScene(config, session, turn.controller.signal, adapters.continueScene, current);
  else session.advanceScene();
  if (!current()) return;
  turn.sceneVersion = session.scene.snapshot().enabled
    ? session.scene.snapshot().version
    : undefined;
  session.send({
    type: 'turn.started',
    displayMode: command.displayMode ?? 'full',
    speech: command.speech,
    text: proactive ? '' : command.text,
    origin: proactive ? 'proactive' : 'user',
  });

  const language = resolveLanguage(
    proactive ? '' : command.text,
    command.language,
    session.language,
  );
  let stage = 'LLM';
  let speechFailureStage = 'TTS';
  let audioDuration = 0;
  let rawOutput = '';
  let requestBody: LlmRequestBody | null = null;
  let outputComplete = false;
  let truncated = false;
  let finishReason: string | null = null;
  let parserFailure: unknown;
  let parsedPhrases = 0;

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
        turn.succeeded = false;
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

  const guarded = proactive || (!proactive && command.automatic === true);
  // Automatic turns are checked before any text or TTS escapes. Manual normal
  // replies retain streaming; scene metadata is buffered/validated with dialogue.
  const buffered = guarded || command.virtualScenesEnabled === true;
  let pendingPhrases: SpeechPhrase[] = [];
  let acceptedPhrases: string[] = [];
  let proposedScene: ScenePlan | undefined;
  let memoryCandidates: MemoryCandidate[] = [];
  let agreement: SceneAgreement | undefined;
  let progress: import('./conversation/ConversationProgress.js').ProgressUpdate | undefined;
  const naturalVariation = command.naturalVariation ?? true;
  const delivery = naturalVariation ? session.director.next('mira') : undefined;
  const reactions = session.reactions.plan(command.miraAngryHopEnabled ?? true);
  const emitPhrase = (phrase: SpeechPhrase) => {
    if (!current()) return;
    const selected = phrase.performance;
    const applied = reactions.apply(selected, command.speech);
    phrase = { ...phrase, performance: applied.performance };
    session.send({
      type: 'performance.phrase',
      phraseIndex: parsedPhrases,
      text: phrase.text,
      selected,
      applied: phrase.performance,
      decision: applied.decision,
      speech: command.speech,
    });
    session.send({ type: 'answer.phrase', phraseIndex: parsedPhrases++, text: phrase.text });
    if (command.speech) queue.push(phrase);
  };
  function createParser() {
    return new JsonReplyParser(
      (text) => {
        if (current() && !buffered) session.send({ type: 'answer.delta', text });
      },
      (phrase) => {
        acceptedPhrases.push(phrase.text);
        if (buffered) pendingPhrases.push(phrase);
        else emitPhrase(phrase);
      },
      command.virtualScenesEnabled
        ? (proposal) => {
            proposedScene = proposal;
          }
        : undefined,
      (metadata) => {
        memoryCandidates = metadata.memories;
        agreement = metadata.sceneAgreement;
        progress = metadata.conversationProgress;
      },
    );
  }
  let parser = createParser();

  try {
    session.send({ type: 'state.changed', state: 'Thinking' });
    const history = proactive
      ? [...session.history]
      : [
          ...session.history,
          {
            role: 'user' as const,
            content: command.text,
            ...(command.automatic ? { generated: true } : {}),
          },
        ];
    let text = '';
    const attempts = repetitionAttempts(command.autoRecoverStalls ?? true);
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      turn.controller.signal.throwIfAborted();
      pendingPhrases = [];
      acceptedPhrases = [];
      proposedScene = undefined;
      memoryCandidates = [];
      agreement = undefined;
      progress = undefined;
      parser = createParser();
      rawOutput = '';
      outputComplete = false;
      finishReason = null;
      truncated = false;
      parserFailure = undefined;
      let receivedDelta = false;
      const raw = await adapters.answer(
        config,
        history,
        language,
        (delta) => {
          if (!current()) return;
          receivedDelta = true;
          truncated ||= rawOutput.length + delta.length > 16000;
          rawOutput = (rawOutput + delta).slice(0, 16000);
          if (!parserFailure) {
            try {
              parser.write(delta);
            } catch (error) {
              parserFailure = error;
            }
          }
        },
        turn.controller.signal,
        {
          proactive,
          naturalVariation,
          delivery,
          memoryContext: session.conversationContext(history.at(-1)?.content ?? ''),
          progressGuidance: session.progress.guidance(),
          localizedProfanity: command.localizedProfanity ?? false,
          getToKnowEachOther: command.getToKnowEachOther ?? false,
          miraBehavior: command.miraBehavior ?? '',
          miraAngryHopEnabled: command.miraAngryHopEnabled ?? true,
          angryHopCooldown: session.reactions.remaining,
          virtualScenesEnabled: command.virtualScenesEnabled ?? false,
          autoEnterScenes: command.autoEnterScenes ?? false,
          scene: command.virtualScenesEnabled ? session.scene.snapshot() : undefined,
          repetitionRetry: attempt === 1,
          recoveryStage: attempts[attempt],
          conversationalPhrases: command.displayMode === 'phrases',
          onFinishReason: (reason) => {
            finishReason = reason;
          },
          onRequestBody: (body) => {
            requestBody = body;
          },
        },
      );
      if (!current()) return;
      outputComplete = true;
      if (!receivedDelta) {
        truncated = raw.length > 16000;
        rawOutput = raw.slice(0, 16000);
        parser.write(raw);
      }
      if (parserFailure) throw parserFailure;
      text = parser.finish();
      if (!text) throw new Error('LLM returned no spoken answer');
      const match = guarded ? repeatedReply(text, history) : undefined;
      if (!match) break;
      if (attempt === attempts.length - 1) throw new RepetitiveReplyError(match, attempts.length);
      session.send({
        type: 'state.changed',
        state:
          attempts[attempt + 1] === 'related'
            ? 'Trying a related angle'
            : attempts[attempt + 1] === 'fresh'
              ? 'Trying a fresh topic'
              : 'Trying a different reply',
      });
    }
    if (buffered) {
      session.send({ type: 'answer.delta', text });
      for (const phrase of pendingPhrases) emitPhrase(phrase);
    }
    const userText = proactive ? '' : command.text;
    if (
      command.virtualScenesEnabled &&
      !proposedScene &&
      (!agreement || !agreement.proposalId) &&
      adapters.sceneMetadata &&
      needsSceneExtraction(session.scene.snapshot(), userText, text, history)
    ) {
      try {
        const extracted = await adapters.sceneMetadata(
          config,
          session.scene.snapshot(),
          userText,
          text,
          turn.controller.signal,
          history,
        );
        if (!current()) return;
        proposedScene = extracted.proposal;
        agreement = extracted.agreement ?? agreement;
      } catch (error) {
        if (!current()) return;
        console.warn(
          'Optional scene metadata extraction failed; dialogue continues.',
          error instanceof Error ? error.name : 'Unknown error',
        );
      }
    }
    if (command.virtualScenesEnabled && !agreement)
      agreement = clearSpokenAgreement(session.scene.snapshot(), userText, text, !!proposedScene);
    const quotedAgreement =
      agreement &&
      userText.includes(agreement.offerQuote) &&
      text.includes(agreement.acceptanceQuote);
    const newProposal =
      command.virtualScenesEnabled && !agreement?.proposalId
        ? proposeScene(session.scene, proposedScene, !!quotedAgreement)
        : undefined;
    if (newProposal) session.send({ type: 'scene.state', scene: session.scene.snapshot() }, null);
    const accepted = command.virtualScenesEnabled
      ? sceneAgreementTarget(session.scene, agreement, userText, text, newProposal)
      : undefined;
    const memories = memoryCandidates;
    const progressUpdate = progress;
    turn.onSuccess = () => {
      session.reactions.complete(reactions.hopped);
      session.progress.collect(progressUpdate, userText, text);
      if (accepted && session.scene.agree(accepted.id, accepted.timing))
        session.send({ type: 'scene.state', scene: session.scene.snapshot() }, null);
      if (
        session.memory.collect(memories, {
          turnId: turn.id,
          manualText: !proactive && !command.automatic ? command.text : '',
          counterpartText: userText,
          reply: text,
        })
      )
        session.send({ type: 'memory.state', memories: session.memory.snapshot() }, null);
      session.archive.complete({
        id: turn.id,
        ...(!proactive
          ? { input: command.text, generated: command.automatic, userPhrases: command.userPhrases }
          : {}),
        phrases: acceptedPhrases,
        text,
        personaName: personas.find((persona) => persona.id === command.personaId)!.name,
        settings: command,
      });
    };

    session.history = [...history, { role: 'assistant' as const, content: text }].slice(-12);
    if (proactive) session.revision++;
    session.language = language;
    session.send({ type: 'answer.final', text });

    if (!command.speech) {
      turn.succeeded = true;
      session.finish(turn);
      return;
    }
    stage = 'speech';
    const phraseCount = await queue.finish();
    if (!current()) return;
    if (!phraseCount) throw new Error('No speech phrases');

    turn.succeeded = true;
    turn.speechFinished = true;
    session.send({ type: 'speech.queue.finished', phraseCount });
    watchPlayback();
  } catch (error) {
    await removeMedia();
    if (!current()) return;
    const failedStage = stage === 'speech' ? speechFailureStage : stage;
    const diagnostic =
      failedStage === 'LLM'
        ? await saveReplyDiagnostic(config, session, {
            turnId: turn.id,
            rawOutput,
            requestBody,
            outputComplete: outputComplete || error instanceof EmptyCompletionError,
            truncated,
            finishReason,
            reason: error instanceof Error ? error.message : 'Reply parsing failed',
            parser: {
              ...parser.snapshot(),
              ...(error instanceof ReplyFormatError ? error.details : {}),
            },
          })
        : undefined;
    if (!current()) return;
    const message =
      error instanceof ReplyFormatError || error instanceof EmptyCompletionError
        ? error.message
        : error instanceof UpstreamError
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
      retryable:
        !(error instanceof RepetitiveReplyError) &&
        (!(error instanceof UpstreamError) || ![401, 403, 413, 422].includes(error.status)),
      diagnostic,
    });
    turn.succeeded = false;
    session.finish(turn);
    turn.controller.abort();
  }
}
