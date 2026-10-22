import express from 'express';
import { prepareScene, generateSceneContinuation } from './scenes/prepareScene.js';
import { ConversationStore } from './history/ConversationStore.js';
import { registerConversationRoutes } from './history/routes.js';
import multer from 'multer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ComponentHealth, Health, Persona } from '@digital-human/shared';
import {
  replyLanguageSchema,
  llmRequestBodySchema,
  conversationPreferencesSchema,
  performanceProtocolVersion,
} from '@digital-human/shared';
import { appRoot, type Config } from './config.js';
import { Session } from './sessions.js';
import { MediaStore } from './media.js';
import { transcribe } from './services/asr.js';
import { UpstreamError } from './services/http.js';
import { rhubarbAvailable } from './services/lipsync.js';
import { transcriptionLanguage } from './services/language.js';
import { resolveLanguage } from './services/language.js';
import { suggestReply } from './llm/replySuggestion.js';
import { ReplyFormatError } from './llm/JsonReplyParser.js';
import { saveReplyDiagnostic } from './llm/diagnostics.js';
import { registerUserSpeechRoutes } from './userSpeechRoutes.js';

export async function serviceHealth(url: string): Promise<ComponentHealth> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error();
    const data = (await response.json()) as Record<string, unknown>;
    return {
      status: data.status === 'ready' ? (data.busy ? 'busy' : 'ready') : 'unavailable',
      model: typeof data.model === 'string' ? data.model : undefined,
      detail:
        data.emotion_control === 'unsupported'
          ? 'This voice model follows reference audio and does not support emotion instructions.'
          : undefined,
      languages: Array.isArray(data.languages)
        ? data.languages.filter((x) => typeof x === 'string')
        : [],
      voices: Array.isArray(data.voices) ? data.voices.filter((x) => typeof x === 'string') : [],
      voiceProfiles: z
        .record(z.string(), z.object({ configured: z.boolean() }))
        .safeParse(data.voice_profiles).data,
    };
  } catch {
    return { status: 'unavailable', detail: 'Service is not reachable or not ready.' };
  }
}

export async function createApplication(config: Config) {
  const backendStartedAt = new Date().toISOString();
  const app = express();
  const sessions = new Map<string, Session>();
  const conversations = new ConversationStore(path.join(config.mediaDir, 'conversations'));
  const media = new MediaStore(config.mediaDir, config.MEDIA_TTL_SECONDS);
  const personas = z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        renderer: z.enum(['vrm', 'live2d']),
        modelUrl: z.string(),
        description: z.string(),
        credit: z.string(),
        licenseUrl: z.string(),
      }),
    )
    .parse(JSON.parse(await readFile(path.join(appRoot, 'personas.json'), 'utf8'))) as Persona[];
  await media.initialize();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
          return res.status(403).json({ error: 'Use the local application origin.' });
      } catch {
        return res.status(403).json({ error: 'Invalid origin.' });
      }
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  registerUserSpeechRoutes(app, config, sessions, media);
  registerConversationRoutes(app, conversations, sessions);
  app.get('/api/health', async (_req, res) => {
    const [asr, tts, lipsync] = await Promise.all([
      serviceHealth(config.ASR_BASE_URL),
      serviceHealth(config.TTS_BASE_URL),
      config.LIPSYNC_PROVIDER === 'amplitude' ? Promise.resolve(true) : rhubarbAvailable(config),
    ]);
    const health: Health = {
      performanceProtocolVersion,
      conversationHistoryVersion: 1,
      backendStartedAt,
      llm: {
        status: config.LLM_MODEL_NAME ? 'ready' : 'unavailable',
        detail: config.LLM_MODEL_NAME
          ? 'Configured; reachability is checked when sending a turn.'
          : 'LLM_MODEL_NAME is missing.',
      },
      asr,
      tts,
      lipsync: { status: lipsync ? 'ready' : 'unavailable' },
      cantoneseSpeech: config.CANTONESE_TTS_ENABLED === 'true',
      proactiveIdleSeconds: config.PROACTIVE_IDLE_SECONDS,
    };
    res.json(health);
  });
  app.get('/api/personas', (_req, res) => res.json(personas));
  app.post('/api/sessions', async (req, res, next) => {
    if (sessions.size >= config.MAX_SESSIONS)
      return res
        .status(503)
        .json({ error: 'Too many local sessions. Close an old session or retry after expiry.' });
    const input = z.object({ conversationId: z.uuid().optional() }).safeParse(req.body ?? {});
    if (!input.success) return res.status(422).json({ error: 'Invalid saved conversation id.' });
    const session = new Session();
    session.archive.store = conversations;
    try {
      if (input.data.conversationId) {
        const saved = await conversations.get(input.data.conversationId);
        if (!saved) return res.status(404).json({ error: 'Saved conversation not found.' });
        session.restoreConversation(saved);
      }
    } catch (error) {
      return next(error);
    }
    session.proactive.delaySeconds = config.PROACTIVE_IDLE_SECONDS;
    sessions.set(session.id, session);
    res.status(201).json({
      id: session.id,
      ...(session.archive.id ? { conversation: session.archive.snapshot() } : {}),
    });
  });
  app.get('/api/sessions/:id/diagnostics/:diagnosticId', (req, res) => {
    const diagnostic = sessions
      .get(String(req.params.id))
      ?.diagnostics.find((item) => item.id === req.params.diagnosticId);
    if (!diagnostic)
      return res.status(404).json({ error: 'Diagnostic expired or unavailable for this session.' });
    res.set('Cache-Control', 'no-store');
    res.attachment(`llm-reply-${diagnostic.id}.json`).json(diagnostic);
  });
  app.post('/api/sessions/:id/suggest-reply', async (req, res, next) => {
    const session = sessions.get(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session expired.' });
    const parsed = z
      .object({
        language: replyLanguageSchema,
        revision: z.number().int().nonnegative(),
        localizedProfanity: z.boolean().default(false),
        ...conversationPreferencesSchema.shape,
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'Invalid suggestion request.' });
    if (
      session.active ||
      session.suggestion ||
      session.userSpeech ||
      session.transcription ||
      parsed.data.revision !== session.revision ||
      !session.history.length
    )
      return res.status(409).json({
        error: 'The conversation changed or another task is active. Try again when it finishes.',
      });
    session.configureScenes(parsed.data.virtualScenesEnabled);
    const controller = new AbortController();
    session.suggestion = controller;
    session.proactive.lastActivity = Date.now();
    const revision = session.revision;
    const history = [...session.history];
    const language = resolveLanguage('', parsed.data.language, session.language);
    const close = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', close);
    try {
      await prepareScene(
        config,
        session,
        controller.signal,
        generateSceneContinuation,
        () => session.suggestion === controller && !session.active && session.revision === revision,
      );
      if (controller.signal.aborted) throw new DOMException('Suggestion cancelled.', 'AbortError');
      const draft = await suggestReply(
        config,
        history,
        language,
        controller.signal,
        parsed.data.localizedProfanity,
        {
          ...parsed.data,
          memoryContext: session.conversationContext(history.at(-1)?.content ?? ''),
          progressGuidance: session.progress.guidance(),
          delivery: parsed.data.naturalVariation ? session.director.next('user') : undefined,
          scene: parsed.data.virtualScenesEnabled ? session.scene.snapshot() : undefined,
        },
      );
      if (controller.signal.aborted || session.revision !== revision || session.active)
        return res
          .status(409)
          .json({ error: 'The suggestion was cancelled because the conversation changed.' });
      res.set('Cache-Control', 'no-store').json({ draft, revision });
    } catch (error) {
      if (controller.signal.aborted) {
        if (!res.destroyed) res.status(409).json({ error: 'Suggestion cancelled.' });
      } else if (error instanceof ReplyFormatError) {
        const { requestBody, ...parser } = error.details;
        const capturedBody = llmRequestBodySchema.safeParse(requestBody);
        const diagnostic = await saveReplyDiagnostic(config, session, {
          turnId: controller.signal.aborted ? 'cancelled' : 'suggestion',
          reason: error.message,
          rawOutput: typeof error.details.source === 'string' ? error.details.source : '',
          requestBody: capturedBody.success ? capturedBody.data : null,
          truncated: false,
          outputComplete: error.details.outputComplete === true,
          finishReason:
            typeof error.details.finishReason === 'string' ? error.details.finishReason : null,
          parser,
        });
        res.status(502).json({ error: error.message, diagnostic });
      } else next(error);
    } finally {
      res.off('close', close);
      if (session.suggestion === controller) session.suggestion = undefined;
      session.touched = Date.now();
      session.proactive.lastActivity = Date.now();
    }
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 2, fieldSize: 100 },
  });
  app.post(
    '/api/sessions/:id/transcribe',
    (req, res, next) => {
      const session = sessions.get(String(req.params.id));
      if (!session) return res.status(404).json({ error: 'Session expired.' });
      if (session.active || session.transcription || session.suggestion || session.userSpeech)
        return res.status(409).json({ error: 'Finish or stop the current task first.' });
      next();
    },
    upload.single('file'),
    async (req, res, next) => {
      const session = sessions.get(String(req.params.id));
      if (!session) return res.status(404).json({ error: 'Session expired.' });
      if (session.active || session.transcription || session.suggestion || session.userSpeech)
        return res.status(409).json({ error: 'Finish or stop the current task first.' });
      if (!req.file) return res.status(422).json({ error: 'An audio recording is required.' });
      const parsed = replyLanguageSchema.safeParse(req.body.language);
      if (!parsed.success) return res.status(422).json({ error: 'Select a supported language.' });
      const controller = new AbortController();
      session.transcription = controller;
      session.touched = Date.now();
      const close = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', close);
      try {
        const result = await transcribe(
          config,
          new Uint8Array(req.file.buffer),
          req.file.mimetype,
          parsed.data,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          if (parsed.data === 'auto')
            session.language = transcriptionLanguage(result.language) ?? session.language;
          res.json(result);
        }
      } catch (error) {
        if (!controller.signal.aborted) next(error);
      } finally {
        res.off('close', close);
        if (session.transcription === controller) session.transcription = undefined;
        session.touched = Date.now();
      }
    },
  );
  app.get('/api/sessions/:id/media/:mediaId', (req, res) => {
    if (!sessions.has(String(req.params.id)))
      return res.status(404).json({ error: 'Session expired.' });
    const file = media.get(String(req.params.id), String(req.params.mediaId));
    if (!file) return res.status(404).json({ error: 'Audio expired or unavailable.' });
    res.set('Cache-Control', 'no-store');
    res.type('audio/wav').sendFile(file);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use(express.static(path.join(appRoot, 'frontend/dist'), { dotfiles: 'deny' }));
  app.get('/{*splat}', (_req, res, next) =>
    res.sendFile(path.join(appRoot, 'frontend/dist/index.html'), (err) =>
      err ? next(err) : undefined,
    ),
  );
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;
      if (error instanceof multer.MulterError)
        return res.status(413).json({ error: 'Recording upload exceeds allowed limits.' });
      if (error instanceof UpstreamError)
        return res.status(error.status).json({ error: error.message });
      res
        .status(502)
        .json({ error: 'The service is unavailable or returned an invalid response.' });
    },
  );
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions)
      if (Date.now() - session.touched > config.SESSION_TTL_SECONDS * 1000) {
        session.stop();
        session.transcription?.abort();
        session.suggestion?.abort();
        sessions.delete(id);
        void media.cleanup(id).catch(() => {});
      }
    void media.cleanup().catch(() => {});
  }, 30000);
  cleanup.unref();
  return {
    app,
    sessions,
    media,
    personas,
    conversations,
    async close() {
      clearInterval(cleanup);
      for (const s of sessions.values()) {
        s.stop();
        s.transcription?.abort();
        s.suggestion?.abort();
      }
      await Promise.all([...sessions.values()].map((session) => session.archive.flush()));
      await conversations.flush();
      for (const id of sessions.keys()) await media.cleanup(id);
      sessions.clear();
    },
  };
}
