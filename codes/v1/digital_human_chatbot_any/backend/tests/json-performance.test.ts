import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerEvent, Persona } from '@digital-human/shared';
import { runTurn, type Services } from '../src/pipeline.js';
import { Session } from '../src/sessions.js';
import { MediaStore } from '../src/media.js';
import { readConfig } from '../src/config.js';
import { synthesize } from '../src/services/tts.js';
import { createServer } from 'node:http';
import { answer } from '../src/services/llm.js';
import { systemPrompt } from '../src/llm/prompts.js';

test('TTS HTTP requests carry canonical emotions separately from speech text', async () => {
  const payloads: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Audio-Duration': '1' });
    res.end(Buffer.from('RIFF0000WAVE'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = readConfig({
      TTS_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    for (const emotion of ['sad', 'surprised', 'neutral'] as const)
      await synthesize(config, 'Hello!', 'en', new AbortController().signal, emotion);
    assert.deepEqual(
      payloads.map((payload: any) => payload.emotion),
      ['sad', 'surprised', 'neutral'],
    );
    assert.ok(payloads.every((payload: any) => payload.text === 'Hello!'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const persona: Persona = {
  id: 'sample',
  name: 'Sample',
  renderer: 'vrm',
  modelUrl: '',
  description: '',
  credit: '',
  licenseUrl: '',
};

const command = {
  type: 'turn.send' as const,
  text: 'Explain octopuses',
  language: 'en' as const,
  personaId: 'sample',
  speech: true,
};

test('subsequent LLM HTTP requests carry plain assistant history in streaming and buffered modes', async () => {
  for (const streaming of [true, false]) {
    const requests: any[] = [];
    const first = [
      { phrase: '你好！', emotion: 'happy', gestures: [] },
      {
        phrase: '八爪魚有八條腕。',
        emotion: 'thoughtful',
        gestures: [{ name: 'nod', strength: 0.3 }],
      },
    ];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      requests.push(JSON.parse(body));
      const reply = JSON.stringify(
        requests.length === 1 ? first : [{ phrase: '係呀。', emotion: 'neutral', gestures: [] }],
      );
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (let offset = 0; offset < reply.length; offset += 7)
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(offset, offset + 7) } }] })}\n\n`,
          );
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'json-history-'));
    const events: ServerEvent[] = [];
    const session = new Session((event) => events.push(event));
    const media = new MediaStore(dir, 900);
    await media.initialize();
    try {
      const config = {
        ...readConfig({
          LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          LLM_MODEL_NAME: 'fake',
          LLM_STREAM: String(streaming),
        }),
        mediaDir: dir,
      };
      const adapters: Services = {
        answer,
        synthesize: async () => {
          throw new Error('Text-only request must not synthesize');
        },
        mouthCues: async () => [],
      };
      await runTurn(
        config,
        session,
        { ...command, speech: false, language: 'yue' },
        [persona],
        media,
        adapters,
      );
      await runTurn(
        config,
        session,
        { ...command, text: '繼續講', speech: false, language: 'yue' },
        [persona],
        media,
        adapters,
      );
      assert.equal(requests.length, 2);
      assert.equal(requests[1].stream, streaming);
      assert.deepEqual(requests[1].messages.slice(1, -1), [
        { role: 'user', content: command.text },
        { role: 'assistant', content: '你好！ 八爪魚有八條腕。' },
      ]);
      assert.equal(requests[1].messages[0].content, systemPrompt());
      assert.equal(requests[1].messages.at(-1).role, 'user');
      assert.ok(
        requests[1].messages
          .at(-1)
          .content.startsWith('Given I say:\n"繼續講"\n\nRESPONSE REQUIREMENTS:\n'),
      );
      assert.match(
        requests[1].messages.at(-1).content,
        /Reply in natural colloquial Hong Kong Cantonese/,
      );
      assert.match(requests[1].messages.at(-1).content, /Give your response in JSON array format/);
      assert.deepEqual(
        session.history
          .filter((message) => message.role === 'user')
          .map((message) => message.content),
        [command.text, '繼續講'],
      );
      assert.equal(session.history.at(-1)?.content, '係呀。');
      assert.ok(!events.some((event) => event.type === 'error'));
    } finally {
      session.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('unrecoverable JSON shows a format error without speaking raw output or committing history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'json-error-'));
  const events: ServerEvent[] = [];
  const session = new Session((event) => events.push(event));
  const media = new MediaStore(dir, 900);
  await media.initialize();
  let ttsCalls = 0;
  try {
    await runTurn({ ...readConfig(), mediaDir: dir }, session, command, [persona], media, {
      answer: async (_c, _h, _l, delta) => {
        delta('[{"emotion":"happy","gestures":[]}]');
        return 'unused';
      },
      synthesize: async () => {
        ttsCalls++;
        return { bytes: Buffer.from('wav'), duration: 1 };
      },
      mouthCues: async () => [],
    });
    assert.equal(ttsCalls, 0);
    assert.deepEqual(session.history, []);
    assert.ok(
      !events.some(
        (event) =>
          event.type === 'answer.delta' ||
          event.type === 'answer.final' ||
          event.type === 'speech.ready',
      ),
    );
    assert.ok(
      events.some((event) => event.type === 'error' && /usable JSON phrase/.test(event.message)),
    );
    assert.equal(session.active, undefined);
  } finally {
    session.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('first phrase becomes ready while LLM streams, TTS stays serial, and history is plain text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'json-phrases-'));
  const events: ServerEvent[] = [];
  const session = new Session((event) => events.push(event));
  const media = new MediaStore(dir, 900);
  await media.initialize();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let activeTts = 0;
  const spoken: string[] = [];
  const emotions: string[] = [];
  const adapters: Services = {
    answer: async (_config, _history, _language, delta) => {
      delta(
        '[{"phrase":"Octopuses have eight arms!","emotion":"surprised","gestures":[{"name":"open_hand","strength":0.5}]}',
      );
      await waiting;
      delta(
        ',{"phrase":"They can camouflage.","emotion":"thoughtful","gestures":[{"name":"nod","strength":0.5}]}]',
      );
      return 'unused: streamed deltas are authoritative';
    },
    synthesize: async (_config, text, _language, _signal, emotion) => {
      assert.equal(activeTts++, 0);
      spoken.push(text);
      emotions.push(emotion!);
      await new Promise((resolve) => setImmediate(resolve));
      activeTts--;
      return { bytes: Buffer.from('wav'), duration: 1 };
    },
    mouthCues: async () => {
      throw new Error('No Rhubarb expected');
    },
  };
  try {
    const work = runTurn(
      { ...readConfig({ LIPSYNC_PROVIDER: 'amplitude' }), mediaDir: dir },
      session,
      command,
      [persona],
      media,
      adapters,
    );
    for (let i = 0; i < 100 && !events.some((event) => event.type === 'speech.ready'); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(events.some((event) => event.type === 'speech.ready'));
    assert.ok(!events.some((event) => event.type === 'answer.final'));
    release();
    await work;
    assert.deepEqual(spoken, ['Octopuses have eight arms!', 'They can camouflage.']);
    assert.deepEqual(emotions, ['surprised', 'thoughtful']);
    const ready = events.filter((event) => event.type === 'speech.ready');
    assert.deepEqual(
      ready.map((event) => event.performance.emotion),
      emotions,
    );
    assert.deepEqual(
      ready.map((event) => event.phraseIndex),
      [0, 1],
    );
    assert.deepEqual(
      ready.map((event) => event.performance.gestures[0]?.name),
      ['open_hand', 'nod'],
    );
    assert.equal(
      session.history.at(-1)?.content,
      'Octopuses have eight arms! They can camouflage.',
    );
    assert.ok(
      events.some((event) => event.type === 'speech.queue.finished' && event.phraseCount === 2),
    );
    assert.ok(session.active);
    session.finish(session.active!);
  } finally {
    release();
    session.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Stop during queued synthesis discards all late phrases and removes already-produced media', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'json-cancel-'));
  const events: ServerEvent[] = [];
  const session = new Session((event) => events.push(event));
  const media = new MediaStore(dir, 900);
  await media.initialize();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let called = 0;
  try {
    const work = runTurn(
      { ...readConfig({ LIPSYNC_PROVIDER: 'amplitude' }), mediaDir: dir },
      session,
      command,
      [persona],
      media,
      {
        answer: async (_c, _h, _l, delta) => {
          const reply = JSON.stringify(
            ['First!', 'Second!', 'Third!'].map((phrase) => ({
              phrase,
              emotion: 'neutral',
              gestures: [],
            })),
          );
          delta(reply);
          return reply;
        },
        synthesize: async () => {
          if (++called === 2) await pending;
          return { bytes: Buffer.from('wav'), duration: 1 };
        },
        mouthCues: async () => [],
      },
    );
    for (let i = 0; i < 100 && called < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(called, 2);
    session.stop();
    release();
    await work;
    assert.equal(called, 2);
    assert.equal(events.filter((event) => event.type === 'speech.ready').length, 1);
    assert.ok(!events.some((event) => event.type === 'speech.queue.finished'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(media.files.size, 0);
  } finally {
    release();
    session.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
