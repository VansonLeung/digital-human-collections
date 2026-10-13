import { z } from 'zod';
import { phrasePerformanceSchema } from './performance.js';

export * from './performance.js';

export const languageSchema = z.enum(['en', 'zh', 'yue']);

export type Language = z.infer<typeof languageSchema>;

export const replyLanguageSchema = z.enum(['auto', 'en', 'zh', 'yue']);

export type ReplyLanguage = z.infer<typeof replyLanguageSchema>;

export const lipSyncModeSchema = z.enum(['amplitude', 'rhubarb']);

export type LipSyncMode = z.infer<typeof lipSyncModeSchema>;

export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.send'),
    text: z.string().trim().min(1).max(4000),
    personaId: z.string().min(1).max(80),
    language: replyLanguageSchema,
    speech: z.boolean().default(true),
  }),
  z.object({ type: z.literal('turn.stop'), turnId: z.string().optional() }),
  z.object({ type: z.literal('session.reset') }),
  z.object({
    type: z.enum(['playback.started', 'playback.ended', 'playback.failed']),
    turnId: z.string(),
  }),
]);

export type Command = z.infer<typeof commandSchema>;

export const cueSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  shape: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X']),
});

export type MouthCue = z.infer<typeof cueSchema>;

export type Persona = {
  id: string;
  name: string;
  renderer: 'vrm' | 'live2d';
  modelUrl: string;
  description: string;
  credit: string;
  licenseUrl: string;
};

export type ComponentHealth = {
  status: 'ready' | 'busy' | 'unavailable';
  model?: string;
  languages?: string[];
  voices?: string[];
  detail?: string;
};

export type Health = {
  llm: ComponentHealth;
  asr: ComponentHealth;
  tts: ComponentHealth;
  lipsync: ComponentHealth;
  cantoneseSpeech: boolean;
};

const base = { sessionId: z.string(), turnId: z.string().nullable(), seq: z.number().int() };

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('session.ready') }),
  z.object({ ...base, type: z.literal('turn.started'), text: z.string() }),
  z.object({ ...base, type: z.literal('state.changed'), state: z.string() }),
  z.object({ ...base, type: z.literal('answer.delta'), text: z.string() }),
  z.object({ ...base, type: z.literal('answer.final'), text: z.string() }),
  z.object({
    ...base,
    type: z.literal('speech.ready'),
    phraseIndex: z.number().int().nonnegative().default(0),
    text: z.string().default(''),
    performance: phrasePerformanceSchema.default({ emotion: 'neutral', gestures: [] }),
    audioUrl: z.string(),
    duration: z.number(),
    cues: z.array(cueSchema),
    lipSyncMode: lipSyncModeSchema.default('rhubarb'),
    personaId: z.string(),
    language: languageSchema,
  }),
  z.object({
    ...base,
    type: z.literal('speech.queue.finished'),
    phraseCount: z.number().int().nonnegative(),
  }),
  z.object({ ...base, type: z.enum(['turn.interrupted', 'turn.completed', 'session.reset']) }),
  z.object({
    ...base,
    type: z.literal('error'),
    message: z.string(),
    stage: z.string(),
    retryable: z.boolean(),
  }),
]);

export type ServerEvent = z.infer<typeof eventSchema>;

export type EventPayload = ServerEvent extends infer T
  ? T extends ServerEvent
    ? Omit<T, 'sessionId' | 'turnId' | 'seq'>
    : never
  : never;
