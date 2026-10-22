import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { Session } from '../src/sessions.js';
import { runTurn } from '../src/pipeline.js';
import { userPhraseListSchema } from '@digital-human/shared';

async function fixture() {
  const requests: any[] = [];
  const speech: any[] = [];
  let output = JSON.stringify({ phrases: ['I am tired.', 'But I would like to keep chatting.'] });
  const outputs: string[] = [];
  let configured = true;
  let delay = 0;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    if (req.url === '/health')
      return res.end(
        JSON.stringify({ status: 'ready', voice_profiles: { user_male: { configured } } }),
      );
    if (req.url === '/v1/chat/completions') {
      requests.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          choices: [{ message: { content: outputs.shift() ?? output }, finish_reason: 'stop' }],
        }),
      );
    }
    speech.push(JSON.parse(body));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Audio-Duration': '0.1' });
    res.end(wav);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const provider = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'user-speech-'));
  const config = {
    ...readConfig({
      LLM_BASE_URL: provider + '/v1',
      LLM_MODEL_NAME: 'mock',
      TTS_BASE_URL: provider,
      CANTONESE_TTS_ENABLED: 'true',
    }),
    mediaDir: dir,
  };
  const context = await createApplication(config);
  const session = new Session();
  session.history = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'How are you?' },
  ];
  context.sessions.set(session.id, session);
  const server = createServer(context.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (route: string, data: object) =>
    fetch(`${base}/api/sessions/${session.id}/user-message/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: session.revision, language: 'en', ...data }),
    });
  return {
    requests,
    speech,
    context,
    session,
    post,
    base,
    config,
    setOutput(value: string) {
      output = value;
    },
    setOutputs(...values: string[]) {
      outputs.push(...values);
    },
    setConfigured(value: boolean) {
      configured = value;
    },
    setDelay(value: number) {
      delay = value;
    },
    async close() {
      await context.close();
      server.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('manual rewriting preserves source instructions and automatic phrases reuse draft context without conflicting formats', async () => {
  const f = await fixture();
  try {
    const history = structuredClone(f.session.history);
    const original = 'I cannot stay past 8, but I want to chat.';
    const manual = await f.post('prepare', {
      kind: 'rewrite',
      text: original,
      localizedProfanity: true,
      getToKnowEachOther: true,
      aboutMe: 'I like quiet walks.',
      miraBehavior: 'MIRA_ONLY_SECRET_82: loves peach tea.',
    });
    assert.equal(manual.status, 200);
    assert.equal((await manual.json()).phrases.length, 2);
    const request = f.requests.at(-1);
    assert.match(request.messages[0].content, /faithful editor/);
    assert.match(request.messages.at(-1).content, /Preserve|preserving/);
    assert.ok(request.messages.at(-1).content.includes(JSON.stringify(original)));
    assert.ok(!JSON.stringify(request.messages).includes('CURRENT TURN GUIDANCE'));
    assert.ok(!JSON.stringify(request.messages).includes('LOCALIZED PROFANITY MODE'));
    assert.ok(!JSON.stringify(request.messages).includes('I like quiet walks.'));
    assert.ok(
      !JSON.stringify(request.messages).includes('CONVERSATION FOCUS: GET TO KNOW EACH OTHER'),
    );
    const automatic = await f.post('prepare', {
      kind: 'automatic',
      language: 'yue',
      localizedProfanity: true,
      getToKnowEachOther: true,
      aboutMe: 'I like quiet walks.',
      miraBehavior: 'MIRA_ONLY_SECRET_82: loves peach tea.',
    });
    assert.equal(automatic.status, 200);
    const messages = f.requests.at(-1).messages;
    assert.match(messages[0].content, /phrases key/);
    assert.match(messages.at(-1).content, /CURRENT TURN GUIDANCE/);
    assert.match(messages.at(-1).content, /LOCALIZED PROFANITY MODE: ON/);
    assert.match(messages.at(-1).content, /CONVERSATION FOCUS: GET TO KNOW EACH OTHER/);
    assert.match(messages.at(-1).content, /I like quiet walks/);
    assert.ok(!JSON.stringify(messages).includes('MIRA_ONLY_SECRET_82'));
    assert.match(messages.at(-1).content, /「屌」、「撚」/);
    const clean = await f.post('prepare', { kind: 'automatic' });
    assert.equal(clean.status, 200);
    assert.match(f.requests.at(-1).messages.at(-1).content, /LOCALIZED PROFANITY MODE: OFF/);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      JSON.parse(messages[1].content.split('\n')[1]),
      history.map((message) => ({
        speaker: message.role === 'assistant' ? 'Mira' : 'user',
        text: message.content,
      })),
    );
    assert.ok(!JSON.stringify(messages).includes('"draft":"the suggested user message"'));
    assert.deepEqual(f.session.history, history);
    assert.equal(f.session.revision, 0);
    assert.equal(f.speech.length, 0, 'Preview must not synthesize before editing');
  } finally {
    await f.close();
  }
});

test('user speech uses the male profile, keeps history unchanged, and scopes media and deletion to its session', async () => {
  const f = await fixture();
  try {
    const history = structuredClone(f.session.history);
    const response = await f.post('speech', { text: '屌，真係估你唔到。', language: 'yue' });
    assert.equal(response.status, 200);
    const audio = await response.json();
    assert.equal(f.speech[0].profile, 'user_male');
    assert.equal(f.speech[0].text, '屌，真係估你唔到。');
    assert.equal((await fetch(f.base + audio.audioUrl)).status, 200);
    const other = new Session();
    f.context.sessions.set(other.id, other);
    assert.equal(
      (await fetch(f.base + audio.audioUrl.replace(f.session.id, other.id), { method: 'DELETE' }))
        .status,
      404,
    );
    assert.equal((await fetch(f.base + audio.audioUrl, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(f.base + audio.audioUrl)).status, 404);
    assert.deepEqual(f.session.history, history);
  } finally {
    await f.close();
  }
});

test('missing voice, stale revision and invalid phrase plans fail explicitly without speaking or committing', async () => {
  const f = await fixture();
  try {
    f.setConfigured(false);
    const voice = await f.post('speech', { text: 'Hello.' });
    assert.equal(voice.status, 422);
    assert.match((await voice.json()).error, /TTS_USER_MALE_REF_AUDIO/);
    assert.equal(f.speech.length, 0);
    assert.equal(
      (await f.post('prepare', { kind: 'automatic', aboutMe: 'x'.repeat(2001) })).status,
      422,
    );
    assert.equal(
      (await f.post('prepare', { kind: 'rewrite', text: 'Hello', revision: 99 })).status,
      409,
    );
    f.setOutput('{"phrases":[""]}');
    const invalid = await f.post('prepare', { kind: 'rewrite', text: 'Hello' });
    assert.equal(invalid.status, 502);
    const error = await invalid.json();
    assert.equal(error.diagnostic.rawOutput, '{"phrases":[""]}');
    assert.deepEqual(error.diagnostic.requestBody, f.requests.at(-1));
    assert.equal(f.session.history.length, 2);
    assert.equal(userPhraseListSchema.safeParse(['x'.repeat(601)]).success, false);
    assert.equal(userPhraseListSchema.safeParse(Array(8).fill('x'.repeat(600))).success, false);
  } finally {
    await f.close();
  }
});

test('Stop during user synthesis discards late audio and a stale spoken submission cannot start a Mira turn', async () => {
  const f = await fixture();
  try {
    f.setDelay(150);
    const pending = f.post('speech', { text: 'Do not send this.' });
    while (!f.speech.length) await new Promise((resolve) => setTimeout(resolve, 5));
    f.session.stop();
    assert.equal((await pending).status, 409);
    assert.equal(f.context.media.files.size, 0);
    assert.equal(f.session.history.length, 2);
    await runTurn(
      f.config,
      f.session,
      {
        type: 'turn.send',
        displayMode: 'full',
        text: 'Do not send this.',
        personaId: f.context.personas[0].id,
        language: 'en',
        speech: false,
        expectedRevision: 99,
      },
      f.context.personas,
      f.context.media,
    );
    assert.equal(f.session.active, undefined);
    assert.equal(f.session.history.length, 2);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test('spoken automatic messages retry a copied turn once; manual faithful rewrites may preserve that same text', async () => {
  const f = await fixture();
  const duplicate =
    '跟住啦，柒頭帶路，唔好走丟。到時食完再同你計，我唔係特登幫你㗎，係我自己想食。';
  f.session.history = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: duplicate },
  ];
  try {
    f.setOutputs(
      JSON.stringify({ phrases: [duplicate] }),
      JSON.stringify({ phrases: ['糖水已經送到，等我試一啖先。'] }),
    );
    const automatic = await f.post('prepare', { kind: 'automatic', language: 'yue' });
    assert.equal(automatic.status, 200);
    assert.deepEqual((await automatic.json()).phrases, ['糖水已經送到，等我試一啖先。']);
    assert.equal(f.requests.length, 2);
    assert.match(f.requests[1].messages.at(-1).content, /REPETITION RETRY/);
    f.setOutputs(JSON.stringify({ phrases: [duplicate] }));
    const manual = await f.post('prepare', { kind: 'rewrite', language: 'yue', text: duplicate });
    assert.equal(manual.status, 200);
    assert.equal(f.requests.length, 3);
    assert.deepEqual((await manual.json()).phrases, [duplicate]);
    assert.equal(f.speech.length, 0);
    assert.equal(f.session.history.length, 2);
  } finally {
    await f.close();
  }
});

test('text suggestions retry a copied response and persistent user-side repeats retain the exact raw response and request', async () => {
  const f = await fixture();
  const duplicate =
    'We can keep following the same path and discuss this same dessert again later.';
  f.session.history = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: duplicate },
  ];
  const suggest = () =>
    fetch(`${f.base}/api/sessions/${f.session.id}/suggest-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'en', revision: f.session.revision }),
    });
  try {
    f.setOutputs(
      JSON.stringify({ draft: duplicate }),
      JSON.stringify({ draft: 'The tea is warm. I would like a quiet moment at this table.' }),
    );
    const response = await suggest();
    assert.equal(response.status, 200);
    assert.equal(f.requests.length, 2);
    assert.match(f.requests[1].messages.at(-1).content, /REPETITION RETRY/);
    f.setOutput(JSON.stringify({ phrases: [duplicate] }));
    const failed = await f.post('prepare', { kind: 'automatic', autoRecoverStalls: false });
    assert.equal(failed.status, 502);
    const error = await failed.json();
    assert.match(error.error, /repeated recent dialogue twice/);
    assert.equal(error.diagnostic.rawOutput, JSON.stringify({ phrases: [duplicate] }));
    assert.deepEqual(error.diagnostic.requestBody, f.requests.at(-1));
    assert.equal(error.diagnostic.parser.repetition.attempts, 2);
    assert.equal(f.requests.length, 4);
    assert.equal(f.session.history.length, 2);
    assert.equal(f.speech.length, 0);
  } finally {
    await f.close();
  }
});

test('text and spoken automatic user suggestions share related-then-fresh recovery without committing history or synthesizing rejected phrases', async () => {
  const f = await fixture();
  const duplicate =
    'We can keep following the same path and discussing the exact same dessert later.';
  f.session.history = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: duplicate },
  ];
  const original = structuredClone(f.session.history);
  try {
    for (const format of ['draft', 'phrases'] as const) {
      const encode = (text: string) =>
        JSON.stringify(format === 'draft' ? { draft: text } : { phrases: [text] });
      f.setOutputs(
        encode(duplicate),
        encode(duplicate),
        encode(duplicate),
        encode('What kind of music would suit a quiet evening?'),
      );
      const start = f.requests.length;
      const response =
        format === 'phrases'
          ? await f.post('prepare', { kind: 'automatic' })
          : await fetch(`${f.base}/api/sessions/${f.session.id}/suggest-reply`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ revision: f.session.revision, language: 'en' }),
            });
      assert.equal(response.status, 200);
      assert.equal(f.requests.length - start, 4);
      assert.match(f.requests[start + 2].messages.at(-1).content, /RELATED ANGLE/);
      assert.match(f.requests[start + 3].messages.at(-1).content, /FRESH TOPIC/);
      assert.deepEqual(f.session.history, original);
      assert.deepEqual(f.speech, []);
    }
  } finally {
    await f.close();
  }
});
