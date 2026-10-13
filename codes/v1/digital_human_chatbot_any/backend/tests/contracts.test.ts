import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { ServerEvent, Persona } from '@digital-human/shared';
import { commandSchema } from '@digital-human/shared';
import { Session } from '../src/sessions.js';
import { MediaStore } from '../src/media.js';
import { runTurn, type Services } from '../src/pipeline.js';
import { readConfig } from '../src/config.js';
import { parseCompletionStream, completionUrl } from '../src/services/llm.js';
import { createApplication } from '../src/app.js';
import { request, sleep } from '../src/services/http.js';
import { resolveLanguage, transcriptionLanguage } from '../src/services/language.js';

const persona: Persona = {
  id: 'sample',
  name: 'Sample',
  renderer: 'vrm',
  modelUrl: '/sample.vrm',
  description: '',
  credit: '',
  licenseUrl: '',
};

const command = {
  type: 'turn.send' as const,
  text: 'Hello',
  personaId: 'sample',
  language: 'en' as const,
  speech: true,
};

const adapters: Services = {
  answer: async (_c, _h, _l, delta) => {
    delta('Hello.');
    return 'Hello.';
  },
  synthesize: async () => ({ bytes: Buffer.from('wav'), duration: 1 }),
  mouthCues: async () => [{ start: 0, end: 1, shape: 'D' }],
};

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'digital-human-test-'));
  const events: ServerEvent[] = [];
  const session = new Session((event) => events.push(event));
  const media = new MediaStore(dir, 900);
  await media.initialize();
  return {
    dir,
    events,
    session,
    media,
    config: { ...readConfig(), mediaDir: dir },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('turn emits text and speech from the same WAV and waits for playback acknowledgement', async () => {
  const f = await fixture();
  try {
    f.config.LIPSYNC_PROVIDER = 'rhubarb';
    await runTurn(f.config, f.session, command, [persona], f.media, {
      ...adapters,
      mouthCues: async (_c, file) => {
        assert.equal((await readFile(file)).toString(), 'wav');
        return [{ start: 0, end: 1, shape: 'D' }];
      },
    });
    assert.equal(f.events.filter((e) => e.type === 'speech.ready').length, 1);
    assert.ok(f.session.active);
    assert.equal(f.session.history.at(-1)?.content, 'Hello.');
    f.session.finish(f.session.active!);
    assert.equal(f.events.at(-1)?.type, 'turn.completed');
    assert.equal(f.session.active, undefined);
  } finally {
    f.session.stop();
    await f.cleanup();
  }
});

test('Stop while LLM is pending discards late text, speech and history', async () => {
  const f = await fixture();
  let release!: (value: string) => void;
  try {
    const work = runTurn(f.config, f.session, command, [persona], f.media, {
      ...adapters,
      answer: async (_c, _h, _l, delta) => {
        const text = await new Promise<string>((r) => (release = r));
        delta(text);
        return text;
      },
    });
    f.session.stop();
    release('Obsolete answer');
    await work;
    assert.equal(f.session.history.length, 0);
    assert.ok(!f.events.some((e) => e.type === 'answer.delta' || e.type === 'speech.ready'));
  } finally {
    await f.cleanup();
  }
});

test('Reset during TTS clears history and never emits obsolete media', async () => {
  const f = await fixture();
  let release!: (value: { bytes: Buffer; duration: number }) => void;
  try {
    const work = runTurn(f.config, f.session, command, [persona], f.media, {
      ...adapters,
      synthesize: async () => new Promise((r) => (release = r)),
    });
    await new Promise((r) => setImmediate(r));
    f.session.reset();
    release({ bytes: Buffer.from('late'), duration: 1 });
    await work;
    assert.deepEqual(f.session.history, []);
    assert.equal(f.media.files.size, 0);
    assert.ok(!f.events.some((e) => e.type === 'speech.ready'));
  } finally {
    await f.cleanup();
  }
});

test('lip-sync failure removes media and preserves completed textual answer', async () => {
  const f = await fixture();
  try {
    f.config.LIPSYNC_PROVIDER = 'rhubarb';
    await runTurn(f.config, f.session, command, [persona], f.media, {
      ...adapters,
      mouthCues: async () => {
        throw new Error('failure');
      },
    });
    assert.equal(f.media.files.size, 0);
    assert.equal(f.session.history.at(-1)?.content, 'Hello.');
    assert.ok(f.events.some((e) => e.type === 'error' && e.stage === 'lip sync'));
    assert.equal(f.session.active, undefined);
  } finally {
    await f.cleanup();
  }
});

test('text-only turn never invokes speech and rejects simultaneous sends', async () => {
  const f = await fixture();
  try {
    await runTurn(f.config, f.session, { ...command, speech: false }, [persona], f.media, {
      ...adapters,
      synthesize: async () => {
        throw new Error('Must not synthesize');
      },
    });
    assert.ok(f.events.some((e) => e.type === 'turn.completed'));
    assert.ok(!f.events.some((e) => e.type === 'speech.ready'));
    await runTurn(f.config, f.session, command, [persona], f.media, adapters);
    const id = f.session.active!.id;
    await runTurn(f.config, f.session, command, [persona], f.media, adapters);
    assert.equal(f.session.active!.id, id);
    assert.ok(f.events.some((e) => e.type === 'error' && e.stage === 'session'));
  } finally {
    f.session.stop();
    await f.cleanup();
  }
});

test('SSE parser handles fragmented CRLF events and ignores reasoning fields', async () => {
  const encoded = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < encoded.length; i += 3) c.enqueue(encoded.slice(i, i + 3));
      c.close();
    },
  });
  let text = '';
  for await (const part of parseCompletionStream(stream)) text += part;
  assert.equal(text, '你好');
  assert.equal(completionUrl('http://localhost/v1/'), 'http://localhost/v1/chat/completions');
  assert.equal(
    completionUrl('http://localhost/v1/chat/completions'),
    'http://localhost/v1/chat/completions',
  );
});

test('media lookup enforces session association, expiry and opaque IDs', async () => {
  const f = await fixture();
  try {
    const item = await f.media.create('owner', Buffer.from('bytes'));
    assert.ok(f.media.get('owner', item.id));
    assert.equal(f.media.get('other', item.id), undefined);
    assert.equal(f.media.get('owner', '../../.env'), undefined);
    f.media.files.get(item.id)!.expires = 0;
    assert.equal(f.media.get('owner', item.id), undefined);
    await f.media.cleanup();
    assert.equal(f.media.files.size, 0);
  } finally {
    await f.cleanup();
  }
});

test('HTTP 429 retry can be interrupted immediately', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(429, { 'Retry-After': '5' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const controller = new AbortController();
  const started = Date.now();
  try {
    const work = request(`http://127.0.0.1:${address.port}`, { signal: controller.signal }, 'TTS');
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(work);
    assert.ok(Date.now() - started < 1000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('Express forwards multipart audio with align=false and validates transcript response', async () => {
  let body = '';
  const upstream = createServer(async (req, res) => {
    body = '';
    for await (const chunk of req) body += chunk.toString();
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'recognized',
        language: body.includes('\r\n\r\nauto') ? 'Cantonese' : 'English',
        words: [],
        alignment_performed: false,
        duration_seconds: 1,
        processing_seconds: 0.1,
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asr-route-test-'));
  const context = await createApplication({
    ...readConfig({
      ASR_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      TTS_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      LIPSYNC_PROVIDER: 'amplitude',
      RHUBARB_BIN: '/missing/rhubarb',
    }),
    mediaDir: dir,
  });
  const server = createServer(context.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${url}/api/sessions`, { method: 'POST' });
    const { id } = (await response.json()) as { id: string };
    const form = new FormData();
    form.append('file', new Blob(['recording'], { type: 'audio/webm' }), 'recording.webm');
    form.append('language', 'en');
    const transcript = await fetch(`${url}/api/sessions/${id}/transcribe`, {
      method: 'POST',
      body: form,
    });
    assert.equal(transcript.status, 200);
    assert.equal(((await transcript.json()) as { text: string }).text, 'recognized');
    assert.match(body, /name="align"\r\n\r\nfalse/);
    form.set('language', 'auto');
    const automatic = await fetch(`${url}/api/sessions/${id}/transcribe`, {
      method: 'POST',
      body: form,
    });
    assert.equal(automatic.status, 200);
    assert.equal(context.sessions.get(id)?.language, 'yue');
    assert.match(body, /name="language"\r\n\r\nauto/);
    const health = await fetch(`${url}/api/health`);
    assert.equal(
      ((await health.json()) as { lipsync: { status: string } }).lipsync.status,
      'ready',
    );
    const forbidden = await fetch(`${url}/api/sessions`, {
      method: 'POST',
      headers: { Origin: 'https://unrelated.example' },
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await context.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => upstream.close(() => r())),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime schema rejects unknown languages and blank prompts', () => {
  assert.equal(commandSchema.safeParse({ ...command, language: 'unknown' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, text: '   ' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, language: 'auto' }).success, true);
});

test('automatic language follows Cantonese, Mandarin and English, with manual overrides', () => {
  assert.equal(resolveLanguage('八爪魚嘅特徵', 'auto'), 'yue');
  assert.equal(resolveLanguage('佢點樣 camouflage？', 'auto'), 'yue');
  assert.equal(resolveLanguage('章魚有哪些特徵？', 'auto'), 'zh');
  assert.equal(resolveLanguage('Explain octopus camouflage', 'auto', 'yue'), 'en');
  assert.equal(resolveLanguage('章魚有哪些特徵？', 'auto', 'yue'), 'yue');
  assert.equal(resolveLanguage('👍', 'auto', 'yue'), 'yue');
  assert.equal(resolveLanguage('八爪魚嘅特徵', 'en'), 'en');
  assert.equal(resolveLanguage('Hello', 'yue'), 'yue');
  assert.equal(transcriptionLanguage('Cantonese'), 'yue');
  assert.equal(transcriptionLanguage('zh-HK'), 'yue');
  assert.equal(transcriptionLanguage(null), undefined);
});

test('amplitude mode skips Rhubarb and routes one resolved language through LLM and TTS', async () => {
  const f = await fixture();
  const called: string[] = [];
  try {
    f.config.LIPSYNC_PROVIDER = 'amplitude';
    f.config.RHUBARB_BIN = '/missing/rhubarb';
    await runTurn(
      f.config,
      f.session,
      { ...command, text: '八爪魚嘅特徵', language: 'auto' },
      [persona],
      f.media,
      {
        answer: async (_c, _h, language, delta) => {
          called.push(`llm:${language}`);
          delta('佢有八條腕。');
          return '佢有八條腕。';
        },
        synthesize: async (_c, _text, language) => {
          called.push(`tts:${language}`);
          return { bytes: Buffer.from('wav'), duration: 1 };
        },
        mouthCues: async () => {
          throw new Error('Rhubarb must not run in amplitude mode');
        },
      },
    );
    assert.deepEqual(called, ['llm:yue', 'tts:yue']);
    const ready = f.events.find((e) => e.type === 'speech.ready');
    assert.ok(ready && ready.type === 'speech.ready');
    assert.equal(ready.lipSyncMode, 'amplitude');
    assert.equal(ready.language, 'yue');
    assert.deepEqual(ready.cues, []);
    assert.ok(
      !f.events.some((e) => e.type === 'state.changed' && e.state === 'Preparing mouth animation'),
    );
    assert.equal(f.session.language, 'yue');
    f.session.reset();
    assert.equal(f.session.language, 'en');
  } finally {
    f.session.stop();
    await f.cleanup();
  }
});
