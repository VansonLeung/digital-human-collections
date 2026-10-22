import { z } from 'zod';
import { conversationPreferencesSchema } from './conversation.js';
import { conversationMemorySchema } from './memory.js';
import { sceneSnapshotSchema, sceneStepSchema } from './scenes.js';
import { conversationSummarySchema } from './history.js';
import { phrasePerformanceSchema } from './performance.js';

export * from './performance.js';
export * from './llmReply.js';
export * from './clientSettings.js';
export * from './conversation.js';
export * from './memory.js';
export * from './scenes.js';
export * from './userSpeech.js';
export * from './history.js';

export const languageSchema = z.enum(['en', 'zh', 'yue']);

export type Language = z.infer<typeof languageSchema>;

export const replyLanguageSchema = z.enum(['auto', 'en', 'zh', 'yue']);

export type ReplyLanguage = z.infer<typeof replyLanguageSchema>;

export const lipSyncModeSchema = z.enum(['amplitude', 'rhubarb']);

export const llmRequestBodySchema = z.record(z.string(), z.unknown());
export type LlmRequestBody = z.infer<typeof llmRequestBodySchema>;

export const replyDiagnosticSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  createdAt: z.string(),
  model: z.string(),
  reason: z.string(),
  rawOutput: z.string(),
  requestBody: llmRequestBodySchema.nullable().optional(),
  outputComplete: z.boolean(),
  truncated: z.boolean(),
  finishReason: z.string().nullable(),
  parser: z.record(z.string(), z.unknown()),
  downloadUrl: z.string().optional(),
});

export type ReplyDiagnostic = z.infer<typeof replyDiagnosticSchema>;

export type LipSyncMode = z.infer<typeof lipSyncModeSchema>;

export const displayModeSchema = z.enum(['full', 'phrases']);
export type DisplayMode = z.infer<typeof displayModeSchema>;

export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.send'),
    automatic: z.boolean().optional(),
    userPhrases: z.array(z.string().trim().min(1).max(600)).min(1).max(8).optional(),
    displayMode: displayModeSchema.default('full'),
    text: z.string().trim().min(1).max(4000),
    personaId: z.string().min(1).max(80),
    language: replyLanguageSchema,
    speech: z.boolean().default(true),
    localizedProfanity: z.boolean().optional(),
    ...conversationPreferencesSchema.partial().shape,
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('scene.configure'), enabled: z.boolean() }),
  z.object({
    type: z.literal('memory.edit'),
    id: z.string(),
    value: z.string().trim().min(1).max(240),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('memory.forget'),
    id: z.string(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('scene.decide'),
    proposalId: z.string(),
    version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    accept: z.boolean(),
  }),
  z.object({ type: z.literal('turn.stop'), turnId: z.string().optional() }),
  z.object({ type: z.literal('session.reset') }),
  z.object({ type: z.literal('conversation.activity') }),
  z.object({
    type: z.literal('proactive.configure'),
    enabled: z.boolean(),
    delaySeconds: z.number().int().min(1).max(3600),
  }),
  z.object({
    type: z.literal('turn.proactive'),
    displayMode: displayModeSchema.default('full'),
    revision: z.number().int().nonnegative(),
    personaId: z.string().min(1).max(80),
    language: replyLanguageSchema,
    speech: z.boolean().default(true),
    localizedProfanity: z.boolean().optional(),
    ...conversationPreferencesSchema.partial().shape,
  }),
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
  voiceProfiles?: Record<string, { configured: boolean }>;
};

export type Health = {
  performanceProtocolVersion?: number;
  conversationHistoryVersion?: number;
  backendStartedAt?: string;
  llm: ComponentHealth;
  asr: ComponentHealth;
  tts: ComponentHealth;
  lipsync: ComponentHealth;
  cantoneseSpeech: boolean;
  proactiveIdleSeconds?: number;
};

const base = {
  sessionId: z.string(),
  turnId: z.string().nullable(),
  seq: z.number().int(),
  revision: z.number().int().nonnegative().default(0),
};

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('session.ready') }),
  z.object({
    ...base,
    type: z.literal('conversation.saved'),
    conversation: conversationSummarySchema,
  }),
  z.object({ ...base, type: z.literal('conversation.save_failed'), message: z.string() }),
  z.object({
    ...base,
    type: z.literal('memory.state'),
    memories: z.array(conversationMemorySchema).max(48),
  }),
  z.object({ ...base, type: z.literal('scene.state'), scene: sceneSnapshotSchema }),
  z.object({
    ...base,
    type: z.literal('scene.step'),
    id: z.string(),
    step: sceneStepSchema,
    index: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  }),
  z.object({
    ...base,
    type: z.literal('turn.started'),
    displayMode: displayModeSchema.default('full'),
    speech: z.boolean().default(false),
    text: z.string(),
    origin: z.enum(['user', 'proactive']).default('user'),
  }),
  z.object({ ...base, type: z.literal('state.changed'), state: z.string() }),
  z.object({ ...base, type: z.literal('answer.delta'), text: z.string() }),
  z.object({ ...base, type: z.literal('answer.final'), text: z.string() }),
  z.object({
    ...base,
    type: z.literal('performance.phrase'),
    phraseIndex: z.number().int().nonnegative(),
    text: z.string(),
    selected: phrasePerformanceSchema,
    applied: phrasePerformanceSchema,
    decision: z.enum([
      'allowed',
      'reaction_mapped',
      'cooldown',
      'hop_disabled',
      'already_selected',
    ]),
    speech: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal('answer.phrase'),
    phraseIndex: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({ ...base, type: z.literal('proactive.skipped') }),
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
    diagnostic: replyDiagnosticSchema.optional(),
  }),
]);

export type ServerEvent = z.infer<typeof eventSchema>;

export type EventPayload = ServerEvent extends infer T
  ? T extends ServerEvent
    ? Omit<T, 'sessionId' | 'turnId' | 'seq' | 'revision'>
    : never
  : never;
