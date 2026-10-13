import { z } from 'zod';
import type { Config } from '../config.js';
import { request, stageSignal } from './http.js';

const resultSchema = z.object({
  text: z.string(),
  language: z.string().nullable().optional(),
  words: z.array(z.unknown()).default([]),
  alignment_performed: z.boolean(),
  duration_seconds: z.number(),
  processing_seconds: z.number(),
});

export async function transcribe(
  config: Config,
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  language: string,
  parent: AbortSignal,
) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes], { type: mime || 'application/octet-stream' }),
    'recording.audio',
  );
  form.append('language', language);
  form.append('align', 'false');
  const response = await request(
    `${config.ASR_BASE_URL.replace(/\/$/, '')}/v1/audio/transcriptions`,
    { method: 'POST', body: form, signal: stageSignal(parent, config.SPEECH_TIMEOUT_SECONDS) },
    'ASR',
  );
  return resultSchema.parse(await response.json());
}
