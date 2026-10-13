import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpeechPhrase, ServerEvent, Persona } from '@digital-human/shared';
import { TaggedReplyParser } from '../src/llm/taggedReplyParser.js';
import { runTurn, type Services } from '../src/pipeline.js';
import { Session } from '../src/sessions.js';
import { MediaStore } from '../src/media.js';
import { readConfig } from '../src/config.js';
import { synthesize } from '../src/services/tts.js';
import { createServer } from 'node:http';

test('fragmented control tags never enter displayed/spoken text and metadata follows its phrase', () => {
  const raw =
    '<emotion name="happy" /><gesture name="wave" strength="0.4" />你好！<gesture name="nod" />八爪魚有八條腕。';
  for (let width = 1; width <= raw.length; width++) {
    const phrases: SpeechPhrase[] = [];
    let displayed = '';
    const parser = new TaggedReplyParser(
      (text) => {
        displayed += text;
      },
      (phrase) => phrases.push(phrase),
    );
    for (let offset = 0; offset < raw.length; offset += width)
      parser.write(raw.slice(offset, offset + width));
    assert.equal(parser.finish(), '你好！八爪魚有八條腕。');
    assert.equal(displayed, '你好！八爪魚有八條腕。');
    assert.equal(phrases.length, 2);
    assert.deepEqual(phrases[0].performance, {
      emotion: 'happy',
      gestures: [{ name: 'wave', strength: 0.4 }],
    });
    assert.deepEqual(phrases[1].performance, {
      emotion: 'happy',
      gestures: [{ name: 'nod', strength: 0.5 }],
    });
  }
});

test('invalid and truncated instructions preserve usable text without executing gestures', () => {
  const phrases: SpeechPhrase[] = [];
  const parser = new TaggedReplyParser(
    () => {},
    (phrase) => phrases.push(phrase),
  );
  parser.write(
    '<gesture name="run_shell" /><gesture name="wave" strength="5" />Value is 1.5. Next sentence!<emotion name="sad"',
  );
  assert.equal(parser.finish(), 'Value is 1.5. Next sentence!');
  assert.deepEqual(
    phrases.map((phrase) => phrase.text),
    ['Value is 1.5.', 'Next sentence!'],
  );
  assert.ok(phrases.every((phrase) => phrase.performance.gestures.length === 0));
});

test('emotion aliases normalize and changes attach to the following phrase', () => {
  const phrases: SpeechPhrase[] = [];
  const parser = new TaggedReplyParser(
    () => {},
    (phrase) => phrases.push(phrase),
  );
  parser.write(
    '<emotion name="sad" />Sorry!<emotion name="surprise" />Really?<emotion name="normal" />Okay.',
  );
  parser.finish();
  assert.deepEqual(
    phrases.map((phrase) => phrase.performance.emotion),
    ['sad', 'surprised', 'neutral'],
  );
});

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

test('first phrase becomes ready while LLM streams, TTS stays serial, and history is tag-free', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tagged-phrases-'));
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
      delta('<emotion name="surprised" /><gesture name="open_hand" />Octopuses have eight arms!');
      await waiting;
      delta('<emotion name="thoughtful" /><gesture name="nod" />They can camouflage.');
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tagged-cancel-'));
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
          delta('First! Second! Third!');
          return 'First! Second! Third!';
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
