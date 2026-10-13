import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readConfig, appRoot } from '../backend/src/config.js';
import { answer } from '../backend/src/services/llm.js';
import { TaggedReplyParser } from '../backend/src/llm/taggedReplyParser.js';
import { synthesize } from '../backend/src/services/tts.js';
import { mouthCues } from '../backend/src/services/lipsync.js';
import { transcribe } from '../backend/src/services/asr.js';
import type { Language } from '@digital-human/shared';

const config = readConfig();
const dir = path.join(appRoot, 'runtime/qa/live');

await mkdir(dir, { recursive: true });

const results = [];

for (const language of ['en', 'zh'] as Language[]) {
  const signal = AbortSignal.timeout(240000);
  const started = performance.now();
  const prompt =
    language === 'en'
      ? 'Introduce yourself in one short sentence.'
      : '請用一句簡短的普通話介紹自己。';
  const raw = await answer(config, [{ role: 'user', content: prompt }], language, () => {}, signal);
  const parser = new TaggedReplyParser(
    () => {},
    () => {},
  );
  parser.write(raw);
  const text = parser.finish();
  const llmEnd = performance.now();
  const audio = await synthesize(config, text, language, signal);
  const ttsEnd = performance.now();
  const file = path.join(dir, `${language}.wav`);
  await writeFile(file, audio.bytes);
  const cues =
    config.LIPSYNC_PROVIDER === 'rhubarb' ? await mouthCues(config, file, language, signal) : [];
  const cueEnd = performance.now();
  const transcript = await transcribe(
    config,
    new Uint8Array(audio.bytes),
    'audio/wav',
    language,
    signal,
  );
  const asrEnd = performance.now();
  const result = {
    language,
    lipSyncMode: config.LIPSYNC_PROVIDER,
    text,
    transcript: transcript.text,
    audioSeconds: audio.duration,
    cueCount: cues.length,
    seconds: {
      llm: (llmEnd - started) / 1000,
      tts: (ttsEnd - llmEnd) / 1000,
      cues: (cueEnd - ttsEnd) / 1000,
      asr: (asrEnd - cueEnd) / 1000,
      totalToAudioAndCues: (cueEnd - started) / 1000,
    },
  };
  results.push(result);
  console.log(JSON.stringify(result));
}

await writeFile(
  path.join(dir, 'results.json'),
  JSON.stringify(
    {
      date: '2026-10-13',
      scope:
        'Individual live service checks, not sustained latency or fluent-listener quality validation',
      results,
    },
    null,
    2,
  ),
);
