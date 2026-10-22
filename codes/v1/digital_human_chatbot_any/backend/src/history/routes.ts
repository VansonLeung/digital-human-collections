import type { Express } from 'express';
import { ConversationStore, ConversationConflict } from './ConversationStore.js';
import type { Session } from '../sessions.js';

export function registerConversationRoutes(
  app: Express,
  store: ConversationStore,
  sessions: Map<string, Session>,
) {
  app.get('/api/conversations', async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(await store.list());
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/conversations/:conversationId', async (req, res, next) => {
    try {
      const value = await store.get(String(req.params.conversationId));
      if (!value) return res.status(404).json({ error: 'Saved conversation not found.' });
      res.set('Cache-Control', 'no-store').attachment(`conversation-${value.id}.json`).json(value);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/sessions/:id/conversation', (req, res) => {
    const value = sessions.get(String(req.params.id))?.archive.snapshot();
    if (!value) return res.status(404).json({ error: 'No completed exchange to export yet.' });
    res.set('Cache-Control', 'no-store').attachment(`conversation-${value.id}.json`).json(value);
  });
  app.post('/api/sessions/:id/save', async (req, res, next) => {
    const session = sessions.get(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session expired.' });
    if (session.active || session.transcription || session.userSpeech || session.suggestion)
      return res.status(409).json({ error: 'Finish the current reply before saving.' });
    try {
      const value = await session.archive.save();
      if (!value) return res.status(409).json({ error: 'No completed exchange to save yet.' });
      res.set('Cache-Control', 'no-store').json({ id: value.id, version: value.version });
    } catch (error) {
      if (error instanceof ConversationConflict)
        return res.status(409).json({ error: error.message });
      next(error);
    }
  });
}
