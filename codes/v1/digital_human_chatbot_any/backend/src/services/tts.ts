import type { Emotion, Language } from '@digital-human/shared';
import type { Config } from '../config.js';
import { request, stageSignal, readLimited } from './http.js';

export function speechText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

export async function synthesize(
  config: Config,
  text: string,
  language: Language,
  parent: AbortSignal,
  emotion: Emotion = 'neutral',
) {
  if (language === 'yue' && config.CANTONESE_TTS_ENABLED !== 'true')
    throw new Error(
      'Cantonese speech awaits voice validation. Turn off spoken replies to continue in text.',
    );
  const voice =
    language === 'en'
      ? config.TTS_ENGLISH_VOICE
      : language === 'yue'
        ? config.TTS_CANTONESE_VOICE
        : config.TTS_CHINESE_VOICE;
  const lang =
    language === 'en' ? 'english' : language === 'yue' ? config.CANTONESE_TTS_LANGUAGE : 'chinese';
  const response = await request(
    `${config.TTS_BASE_URL.replace(/\/$/, '')}/v1/audio/speech`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: speechText(text), voice, language: lang, emotion }),
      signal: stageSignal(parent, config.SPEECH_TIMEOUT_SECONDS),
    },
    'TTS',
  );
  if (!response.headers.get('content-type')?.startsWith('audio/wav'))
    throw new Error('TTS returned an unexpected audio format');
  const bytes = await readLimited(response, 48 * 1024 * 1024);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('TTS returned an invalid WAV');
  const duration = Number(response.headers.get('X-Audio-Duration'));
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120)
    throw new Error('TTS returned an invalid duration');
  return { bytes, duration };
}
