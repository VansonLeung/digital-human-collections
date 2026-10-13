import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

export const appRoot = fileURLToPath(new URL('../../', import.meta.url));

dotenv({ path: path.join(appRoot, '.env'), quiet: true });

const envSchema = z.object({
  APP_HOST: z.string().default('127.0.0.1'),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  LLM_BASE_URL: z.url().default('http://127.0.0.1:1234/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL_NAME: z.string().default(''),
  LLM_STREAM: z.enum(['true', 'false']).default('true'),
  LLM_MAX_TOKENS: z.coerce.number().int().min(128).max(8192).default(1600),
  LLM_THINKING: z.enum(['true', 'false']).default('false'),
  ASR_BASE_URL: z.url().default('http://127.0.0.1:38001'),
  TTS_BASE_URL: z.url().default('http://127.0.0.1:38002'),
  RHUBARB_BIN: z.string().default(path.join(appRoot, 'tools/rhubarb/rhubarb')),
  LIPSYNC_PROVIDER: z.enum(['amplitude', 'rhubarb']).default('amplitude'),
  RHUBARB_ENGLISH_RECOGNIZER: z.enum(['phonetic', 'pocketSphinx']).default('phonetic'),
  LLM_TIMEOUT_SECONDS: z.coerce.number().positive().default(120),
  SPEECH_TIMEOUT_SECONDS: z.coerce.number().positive().default(180),
  LIPSYNC_TIMEOUT_SECONDS: z.coerce.number().positive().default(60),
  MEDIA_TTL_SECONDS: z.coerce.number().positive().default(900),
  SESSION_TTL_SECONDS: z.coerce.number().positive().default(3600),
  MAX_SESSIONS: z.coerce.number().int().positive().default(20),
  CANTONESE_TTS_ENABLED: z.enum(['true', 'false']).default('true'),
  CANTONESE_TTS_LANGUAGE: z.string().default('chinese'),
  TTS_ENGLISH_VOICE: z.string().default('Ryan'),
  TTS_CHINESE_VOICE: z.string().default('Vivian'),
  TTS_CANTONESE_VOICE: z.string().default('Vivian'),
});

export type Config = z.infer<typeof envSchema> & { mediaDir: string };

export function readConfig(overrides: Record<string, unknown> = {}): Config {
  const values = envSchema.parse({ ...process.env, ...overrides });
  return { ...values, mediaDir: path.join(appRoot, 'runtime/media') };
}
