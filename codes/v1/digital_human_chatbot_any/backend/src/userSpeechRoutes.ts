import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { replyLanguageSchema, languageSchema, llmRequestBodySchema } from '@digital-human/shared';
import type { Config } from './config.js';
import type { Session } from './sessions.js';
import type { MediaStore } from './media.js';
import { resolveLanguage } from './services/language.js';
import { synthesize } from './services/tts.js';
import { generateUserPhrases } from './llm/userPhrases.js';
import { ReplyFormatError } from './llm/JsonReplyParser.js';
import { saveReplyDiagnostic } from './llm/diagnostics.js';

const preparationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('automatic'),
    language: replyLanguageSchema,
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('rewrite'),
    text: z.string().trim().min(1).max(4000),
    language: replyLanguageSchema,
    revision: z.number().int().nonnegative(),
  }),
]);
const speechSchema = z.object({
  text: z.string().trim().min(1).max(600),
  language: languageSchema,
  revision: z.number().int().nonnegative(),
});

export function registerUserSpeechRoutes(
  app: Express,
  config: Config,
  sessions: Map<string, Session>,
  media: MediaStore,
) {
  async function task(
    req: Request,
    res: Response,
    next: NextFunction,
    operation: 'prepare' | 'speech',
  ) {
    const session = sessions.get(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session expired.' });
    const parsed = (operation === 'prepare' ? preparationSchema : speechSchema).safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'Invalid spoken-message request.' });
    if (
      session.active ||
      session.suggestion ||
      session.transcription ||
      session.userSpeech ||
      parsed.data.revision !== session.revision
    )
      return res.status(409).json({
        error:
          'The conversation changed or another task is active. Review your message and try again.',
      });
    const controller = new AbortController();
    session.userSpeech = controller;
    session.touched = session.proactive.lastActivity = Date.now();
    const revision = session.revision;
    let mediaId: string | undefined;
    const current = () =>
      !controller.signal.aborted && session.revision === revision && !session.active;
    const close = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', close);
    try {
      if (operation === 'prepare') {
        const input = preparationSchema.parse(parsed.data);
        if (
          input.kind === 'automatic' &&
          !session.history.some((message) => message.role === 'assistant')
        )
          return res
            .status(409)
            .json({ error: 'Wait for Mira to reply before generating an automatic message.' });
        const text = input.kind === 'rewrite' ? input.text : '';
        const language = resolveLanguage(text, input.language, session.language);
        const phrases = await generateUserPhrases(
          config,
          [...session.history],
          language,
          input.kind,
          text,
          controller.signal,
        );
        if (!current())
          return res.status(409).json({ error: 'Spoken-message preparation was cancelled.' });
        res.set('Cache-Control', 'no-store').json({ phrases, language, revision });
      } else {
        const input = speechSchema.parse(parsed.data);
        if (input.language === 'yue' && config.CANTONESE_TTS_ENABLED !== 'true')
          return res.status(422).json({
            error:
              'Cantonese speech awaits voice validation. Enable it in the app configuration after validating the male voice.',
          });
        const health = await fetch(`${config.TTS_BASE_URL.replace(/\/$/, '')}/health`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        });
        const status = health.ok ? await health.json() : {};
        if (status.voice_profiles?.user_male?.configured !== true)
          return res.status(422).json({
            error:
              'Configure TTS_USER_MALE_REF_AUDIO and TTS_USER_MALE_REF_TEXT in the TTS service .env, then restart that service to enable the male voice.',
          });
        const audio = await synthesize(
          config,
          input.text,
          input.language,
          controller.signal,
          'neutral',
          'user_male',
        );
        if (!current())
          return res.status(409).json({ error: 'Spoken-message audio was cancelled.' });
        const created = await media.create(session.id, audio.bytes);
        mediaId = created.id;
        if (!current()) {
          await media.remove(created.id);
          return res.status(409).json({ error: 'Spoken-message audio was cancelled.' });
        }
        res.set('Cache-Control', 'no-store').json({
          id: created.id,
          audioUrl: `/api/sessions/${session.id}/media/${created.id}`,
          duration: audio.duration,
          revision,
        });
      }
    } catch (error) {
      if (mediaId) await media.remove(mediaId);
      if (controller.signal.aborted) {
        if (!res.destroyed) res.status(409).json({ error: 'Spoken-message task cancelled.' });
      } else if (error instanceof ReplyFormatError) {
        const { requestBody, ...parser } = error.details;
        const captured = llmRequestBodySchema.safeParse(requestBody);
        const diagnostic = await saveReplyDiagnostic(config, session, {
          turnId: 'user-message',
          reason: error.message,
          rawOutput: typeof error.details.source === 'string' ? error.details.source : '',
          requestBody: captured.success ? captured.data : null,
          outputComplete: error.details.outputComplete === true,
          truncated: false,
          finishReason:
            typeof error.details.finishReason === 'string' ? error.details.finishReason : null,
          parser,
        });
        res.status(502).json({ error: error.message, diagnostic });
      } else next(error);
    } finally {
      res.off('close', close);
      if (session.userSpeech === controller) session.userSpeech = undefined;
      session.touched = session.proactive.lastActivity = Date.now();
    }
  }
  app.post(
    '/api/sessions/:id/user-message/prepare',
    (req, res, next) => void task(req, res, next, 'prepare').catch(next),
  );
  app.post(
    '/api/sessions/:id/user-message/speech',
    (req, res, next) => void task(req, res, next, 'speech').catch(next),
  );
  app.delete('/api/sessions/:id/media/:mediaId', async (req, res, next) => {
    try {
      if (
        !sessions.has(String(req.params.id)) ||
        !media.get(String(req.params.id), String(req.params.mediaId))
      )
        return res.status(404).json({ error: 'Audio expired or unavailable.' });
      await media.remove(String(req.params.mediaId));
      res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });
}
