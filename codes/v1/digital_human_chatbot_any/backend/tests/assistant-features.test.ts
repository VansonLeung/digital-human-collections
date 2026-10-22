import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Persona, ServerEvent } from '@digital-human/shared';
import { readConfig } from '../src/config.js';
import { Session } from '../src/sessions.js';
import { MediaStore } from '../src/media.js';
import { runTurn, type Services } from '../src/pipeline.js';
import { createApplication } from '../src/app.js';
import { answer } from '../src/services/llm.js';
import { suggestReply } from '../src/llm/replySuggestion.js';
import { ReplyFormatError } from '../src/llm/JsonReplyParser.js';

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
  text: 'Hello',
  language: 'en' as const,
  personaId: 'sample',
  speech: false,
};

test('phrase display streams validated phrases and keeps assistant history plain', async () => {
  const f = await fixture();
  const phrases = ['Well,', 'let me think.', 'Here is an idea.'];
  try {
    await runTurn(
      f.config,
      f.session,
      {
        ...command,
        displayMode: 'phrases',
        localizedProfanity: true,
        getToKnowEachOther: true,
        aboutMe: 'I like walks.',
      },
      [persona],
      f.media,
      {
        answer: async (_c, _h, _l, delta, _s, options) => {
          assert.equal(options?.conversationalPhrases, true);
          assert.equal(options?.localizedProfanity, true);
          assert.equal(options?.getToKnowEachOther, true);
          assert.equal(options?.aboutMe, undefined);
          const raw = JSON.stringify(
            phrases.map((phrase) => ({ phrase, emotion: 'neutral', gestures: [] })),
          );
          for (let i = 0; i < raw.length; i += 7) delta(raw.slice(i, i + 7));
          return raw;
        },
        synthesize: async () => {
          throw new Error('Text-only turn must not synthesize');
        },
        mouthCues: async () => [],
      },
    );
    assert.deepEqual(
      f.events
        .filter((event) => event.type === 'answer.phrase')
        .map((event) =>
          event.type === 'answer.phrase' ? { text: event.text, index: event.phraseIndex } : null,
        ),
      phrases.map((text, index) => ({ text, index })),
    );
    assert.deepEqual(f.session.history, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: phrases.join(' ') },
    ]);
    const started = f.events.find((event) => event.type === 'turn.started');
    assert.ok(started?.type === 'turn.started');
    assert.equal(started.displayMode, 'phrases');
    assert.equal(started.speech, false);
  } finally {
    await f.close();
  }
});

test('empty and malformed suggested replies retain raw output and completion details', async () => {
  const outputs = ['', '{"unexpected":"raw reply for debugging"}'];
  let raw = '';
  let sentBody: unknown;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    sentBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const config = readConfig({
      LLM_MODEL_NAME: 'fake',
      LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    });
    const history = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello!' },
    ];
    for (raw of outputs) {
      await assert.rejects(
        suggestReply(config, history, 'en', new AbortController().signal),
        (error) => {
          assert.ok(error instanceof ReplyFormatError);
          assert.equal(error.details.source, raw);
          assert.equal(error.details.outputComplete, true);
          assert.equal(error.details.finishReason, 'stop');
          assert.deepEqual(error.details.requestBody, sentBody);
          const inspected = error.details.requestBody?.messages.at(-1)?.content;
          assert.match(inspected ?? '', /CURRENT TURN GUIDANCE/);
          assert.match(
            inspected ?? '',
            /Optional style: (natural|warm|coy|playful|straightforward)/,
          );
          assert.match(error.message, raw ? /valid draft/ : /empty reply/);
          return true;
        },
      );
      assert.equal(history.length, 2);
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('normal reply diagnostics capture the exact sent request for parse and HTTP failures', async () => {
  for (const streaming of [true, false]) {
    const f = await fixture();
    const history = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `Plain history ${index}`,
    }));
    f.session.history = [...history];
    let sentBody: any;
    let rejectRequest = false;
    const upstream = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      sentBody = JSON.parse(body);
      assert.equal(req.headers.authorization, `Bearer ${f.config.LLM_API_KEY}`);
      if (rejectRequest) {
        res.writeHead(503).end();
        return;
      }
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Plain prose without JSON.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'Plain prose without JSON.' }, finish_reason: 'stop' }],
          }),
        );
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const config = {
        ...f.config,
        LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
        LLM_STREAM: String(streaming) as 'true' | 'false',
      };
      const adapters: Services = {
        answer,
        synthesize: async () => {
          throw new Error('No speech');
        },
        mouthCues: async () => [],
      };
      for (rejectRequest of [false, true]) {
        await runTurn(
          config,
          f.session,
          { ...command, displayMode: 'phrases' },
          [persona],
          f.media,
          adapters,
        );
        const error = f.events.findLast((event) => event.type === 'error');
        assert.ok(error?.type === 'error' && error.diagnostic);
        assert.deepEqual(error.diagnostic.requestBody, sentBody);
        assert.ok(sentBody.messages.length <= 13);
        assert.equal(sentBody.messages[0].role, 'system');
        assert.equal(sentBody.messages[1].role, 'user');
        assert.equal(sentBody.messages.at(-1).role, 'user');
        assert.ok(
          sentBody.messages
            .at(-1)
            .content.startsWith('Given I say:\n"Hello"\n\nRESPONSE REQUIREMENTS:\n'),
        );
        assert.match(sentBody.messages.at(-1).content, /Give your response in JSON array format/);
        assert.equal(sentBody.stream, streaming);
        assert.equal(sentBody.max_tokens, config.LLM_MAX_TOKENS);
        assert.equal(error.diagnostic.outputComplete, !rejectRequest);
        assert.deepEqual(f.session.history, history);
        const file = (await readdir(path.join(f.dir, 'diagnostics'))).find((name) =>
          name.includes(error.diagnostic!.id),
        )!;
        const disk = await readFile(path.join(f.dir, 'diagnostics', file), 'utf8');
        assert.deepEqual(JSON.parse(disk).requestBody, sentBody);
        assert.ok(!disk.includes(config.LLM_API_KEY));
        assert.ok(!disk.includes('Authorization'));
      }
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await f.close();
    }
  }
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'assistant-features-'));
  const config = {
    ...readConfig({
      LLM_MODEL_NAME: 'fake',
      LLM_API_KEY: 'secret-must-not-be-in-diagnostics',
      LIPSYNC_PROVIDER: 'amplitude',
    }),
    mediaDir: dir,
  };
  const events: ServerEvent[] = [];
  const session = new Session((event) => events.push(event));
  const media = new MediaStore(dir, 900);
  await media.initialize();
  return {
    dir,
    config,
    events,
    session,
    media,
    async close() {
      session.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('conversation progress commits after successful completion, not before playback or after Stop', async () => {
  for (const outcome of ['text', 'played', 'stopped']) {
    const f = await fixture();
    try {
      const raw = JSON.stringify([
        {
          phrase: 'Let us go.',
          emotion: 'happy',
          gestures: [],
          conversationProgress: {
            topic: 'dessert',
            angle: 'outing',
            kind: 'decision',
            summary: 'Agree to go',
            quote: 'Let us go.',
          },
        },
      ]);
      await runTurn(
        f.config,
        f.session,
        { ...command, speech: outcome !== 'text' },
        [persona],
        f.media,
        {
          answer: async (_c, _h, _l, delta) => {
            delta(raw);
            return raw;
          },
          synthesize: async () => ({ bytes: Buffer.from('wav'), duration: 0.1 }),
          mouthCues: async () => [],
        },
      );
      if (outcome !== 'text') {
        assert.equal(f.session.progress.context(), '');
        assert.ok(f.session.active?.succeeded);
        if (outcome === 'played') f.session.finish(f.session.active!);
        else f.session.stop();
      }
      assert.equal(f.session.progress.context().includes('dessert'), outcome !== 'stopped');
      assert.ok(
        !f.session.history.some((message) => message.content.includes('conversationProgress')),
      );
    } finally {
      await f.close();
    }
  }
});

test('reaction controls reach audio unchanged, cooldown filters the next three completed replies and inspector retains both decisions', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 5; index++) {
      await runTurn(
        f.config,
        f.session,
        {
          ...command,
          text: `Playful turn ${index}`,
          speech: true,
          miraBehavior: 'Mira reacts with playful embarrassed anger.',
          miraAngryHopEnabled: true,
        },
        [persona],
        f.media,
        {
          answer: async (_c, _h, _l, delta, _s, options) => {
            assert.equal(options?.angryHopCooldown, [0, 3, 2, 1, 0][index]);
            assert.match(options?.miraBehavior ?? '', /embarrassed/);
            const raw = JSON.stringify([
              {
                phrase: `A playful response ${index}.`,
                emotion: 'angry',
                gestures: [],
                reaction: { name: 'flustered_denial', intensity: 0.85 },
              },
            ]);
            delta(raw);
            return raw;
          },
          synthesize: async () => ({ bytes: Buffer.from('wav'), duration: 0.2 }),
          mouthCues: async () => [],
        },
      );
      const selected = f.events.filter((event) => event.type === 'performance.phrase').at(-1)!;
      assert.equal(selected.type, 'performance.phrase');
      if (selected.type !== 'performance.phrase') throw new Error('Missing inspector controls');
      assert.equal(selected.selected.reaction?.name, 'flustered_denial');
      assert.deepEqual(selected.selected.gestures, []);
      assert.equal(
        selected.applied.gestures[0].name,
        index === 0 || index === 4 ? 'angry_hop' : 'tsundere_turn',
      );
      assert.equal(selected.decision, index === 0 || index === 4 ? 'reaction_mapped' : 'cooldown');
      const audio = f.events.filter((event) => event.type === 'speech.ready').at(-1)!;
      assert.ok(audio.type === 'speech.ready');
      assert.deepEqual(audio.performance, selected.applied);
      assert.equal(f.session.reactions.remaining, index === 0 ? 0 : [0, 3, 2, 1, 0][index]);
      f.session.finish(f.session.active!);
    }
  } finally {
    await f.close();
  }
});

test('format failure retains the entire streamed raw output, validation details, finish reason and disk artifact', async () => {
  const f = await fixture();
  const raw =
    '[{"emotion":"angry","gestures":[]},{"phrase":"This later fragment must appear in diagnostics.","emotion":"neutral","gestures":[]}]';
  try {
    await runTurn(f.config, f.session, command, [persona], f.media, {
      answer: async (_c, _h, _l, delta, _s, options) => {
        for (let offset = 0; offset < raw.length; offset += 11)
          delta(raw.slice(offset, offset + 11));
        options?.onFinishReason?.('length');
        return raw;
      },
      synthesize: async () => {
        throw new Error('Malformed reply must not be spoken');
      },
      mouthCues: async () => [],
    });
    const error = f.events.find((event) => event.type === 'error');
    assert.ok(error?.type === 'error' && error.diagnostic);
    assert.equal(error.diagnostic.rawOutput, raw);
    assert.equal(error.diagnostic.outputComplete, true);
    assert.equal(error.diagnostic.finishReason, 'length');
    assert.ok(error.diagnostic.parser.validation);
    assert.equal(error.diagnostic.parser.acceptedPhrases, 0);
    assert.deepEqual(f.session.history, []);
    assert.ok(
      !f.events.some((event) => event.type === 'answer.delta' || event.type === 'speech.ready'),
    );
    const file = (await readdir(path.join(f.dir, 'diagnostics')))[0];
    const contents = await readFile(path.join(f.dir, 'diagnostics', file), 'utf8');
    assert.equal(JSON.parse(contents).rawOutput, raw);
    assert.ok(!contents.includes(f.config.LLM_API_KEY));
  } finally {
    await f.close();
  }
});

test('partial provider failures preserve received raw text and mark the output incomplete', async () => {
  const f = await fixture();
  try {
    await runTurn(f.config, f.session, command, [persona], f.media, {
      answer: async (_c, _h, _l, delta) => {
        delta('[{"phrase":"partial');
        throw new Error('Provider disconnected');
      },
      synthesize: async () => {
        throw new Error('No speech');
      },
      mouthCues: async () => [],
    });
    const error = f.events.find((event) => event.type === 'error');
    assert.ok(error?.type === 'error' && error.diagnostic);
    assert.equal(error.diagnostic.rawOutput, '[{"phrase":"partial');
    assert.equal(error.diagnostic.outputComplete, false);
    assert.equal(error.diagnostic.parser.insideString, true);
  } finally {
    await f.close();
  }
});

test('proactive replies require opt-in, idle time and current history; only one follows each user turn', async () => {
  const f = await fixture();
  f.session.history = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi!' },
  ];
  f.session.proactive.eligible = true;
  f.session.proactive.delaySeconds = 1;
  const proactive = {
    type: 'turn.proactive' as const,
    localizedProfanity: true,
    getToKnowEachOther: true,
    aboutMe: 'I like tea.',
    revision: 0,
    personaId: 'sample',
    language: 'auto' as const,
    speech: false,
  };
  let calls = 0;
  const adapters: Services = {
    answer: async (_c, history, _l, delta, _s, options) => {
      calls++;
      assert.equal(options?.proactive, true);
      assert.equal(options?.getToKnowEachOther, true);
      assert.equal(options?.aboutMe, undefined);
      assert.equal(options?.localizedProfanity, true);
      assert.deepEqual(history, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);
      const raw =
        '[{"phrase":"What would you like to explore?","emotion":"neutral","gestures":[]}]';
      delta(raw);
      return raw;
    },
    synthesize: async () => {
      throw new Error('Text-only proactive reply');
    },
    mouthCues: async () => [],
  };
  try {
    await runTurn(f.config, f.session, proactive, [persona], f.media, adapters);
    assert.equal(calls, 0);
    f.session.proactive.enabled = true;
    await runTurn(f.config, f.session, proactive, [persona], f.media, adapters);
    assert.equal(calls, 0);
    f.session.proactive.lastActivity = Date.now() - 2000;
    await runTurn(f.config, f.session, { ...proactive, revision: 9 }, [persona], f.media, adapters);
    assert.equal(calls, 0);
    await runTurn(f.config, f.session, proactive, [persona], f.media, adapters);
    assert.equal(calls, 1);
    assert.equal(f.session.history.length, 3);
    assert.equal(f.session.history.at(-1)?.role, 'assistant');
    f.session.proactive.lastActivity = Date.now() - 2000;
    await runTurn(
      f.config,
      f.session,
      { ...proactive, revision: f.session.revision },
      [persona],
      f.media,
      adapters,
    );
    assert.equal(calls, 1);
    assert.ok(
      f.events.some(
        (event) =>
          event.type === 'turn.started' && event.origin === 'proactive' && event.text === '',
      ),
    );
  } finally {
    await f.close();
  }
});

test('activity cancels a pending proactive reply without committing late history', async () => {
  const f = await fixture();
  f.session.history = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi!' },
  ];
  f.session.proactive = {
    enabled: true,
    eligible: true,
    delaySeconds: 1,
    lastActivity: Date.now() - 2000,
  };
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const work = runTurn(
      f.config,
      f.session,
      { type: 'turn.proactive', revision: 0, personaId: 'sample', language: 'en', speech: false },
      [persona],
      f.media,
      {
        answer: async (_c, _h, _l, delta) => {
          await waiting;
          delta('[{"phrase":"Late.","emotion":"angry","gestures":[]}]');
          return 'unused';
        },
        synthesize: async () => {
          throw new Error('No speech');
        },
        mouthCues: async () => [],
      },
    );
    f.session.activity();
    release();
    await work;
    assert.equal(f.session.history.length, 2);
    assert.ok(!f.events.some((event) => event.type === 'answer.delta'));
    assert.equal(f.session.active, undefined);
  } finally {
    release();
    await f.close();
  }
});

test('spoken proactive replies use the same angry emotion for TTS and avatar metadata', async () => {
  const f = await fixture();
  f.session.history = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
  ];
  f.session.proactive = {
    enabled: true,
    eligible: true,
    delaySeconds: 1,
    lastActivity: Date.now() - 2000,
  };
  const spoken: unknown[] = [];
  try {
    await runTurn(
      f.config,
      f.session,
      { type: 'turn.proactive', revision: 0, personaId: 'sample', language: 'en', speech: true },
      [persona],
      f.media,
      {
        answer: async (_c, _h, _l, delta) => {
          const raw =
            '[{"phrase":"That sounds frustrating. Want to talk about it?","emotion":"angry","gestures":[]}]';
          delta(raw);
          return raw;
        },
        synthesize: async (_c, text, _l, _s, emotion) => {
          spoken.push({ text, emotion });
          return { bytes: Buffer.from('wav'), duration: 1 };
        },
        mouthCues: async () => [],
      },
    );
    const ready = f.events.find((event) => event.type === 'speech.ready');
    assert.ok(ready?.type === 'speech.ready');
    assert.equal(ready.performance.emotion, 'angry');
    assert.deepEqual(spoken, [{ text: ready.text, emotion: 'angry' }]);
    assert.ok(
      f.events.some((event) => event.type === 'speech.queue.finished' && event.phraseCount === 1),
    );
    assert.ok(f.session.active, 'spoken follow-up waits for playback acknowledgement');
    assert.equal(f.session.history.filter((message) => message.role === 'user').length, 1);
  } finally {
    await f.close();
  }
});

test('real proactive HTTP requests open a new generation without persisting the idle cue', async () => {
  for (const streaming of [true, false]) {
    const f = await fixture();
    const history = [
      { role: 'user' as const, content: 'Introduce yourself' },
      { role: 'assistant' as const, content: "I'm Mira, and I'm really curious about the world." },
    ];
    f.session.history = [...history];
    f.session.proactive = {
      enabled: true,
      eligible: true,
      delaySeconds: 1,
      lastActivity: Date.now() - 2000,
    };
    const requests: any[] = [];
    let empty = false;
    const upstream = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      const input = JSON.parse(body);
      requests.push(input);
      const reply =
        empty || input.messages.at(-1).role !== 'user'
          ? ''
          : '[{"phrase":"What stories would you like to share?","emotion":"thoughtful","gestures":[]}]';
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (let start = 0; start < reply.length; start += 9)
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(start, start + 9) } }] })}\n\n`,
          );
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }),
        );
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const config = {
        ...f.config,
        LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
        LLM_STREAM: String(streaming) as 'true' | 'false',
      };
      const adapters: Services = {
        answer,
        synthesize: async () => {
          throw new Error('text-only');
        },
        mouthCues: async () => [],
      };
      const proactive = {
        type: 'turn.proactive' as const,
        revision: 0,
        personaId: 'sample',
        language: 'en' as const,
        speech: false,
      };
      await runTurn(config, f.session, proactive, [persona], f.media, adapters);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].messages.slice(1, -1), history);
      assert.equal(requests[0].messages.at(-1).role, 'user');
      assert.match(requests[0].messages.at(-1).content, /user is quiet/);
      assert.deepEqual(f.session.history, [
        ...history,
        { role: 'assistant', content: 'What stories would you like to share?' },
      ]);
      assert.ok(!f.events.some((event) => event.type === 'error'));

      // The same completed-but-empty response must expose diagnostics even
      // though it never supplies a text delta, including its finish reason.
      empty = true;
      f.session.proactive.eligible = true;
      f.session.proactive.lastActivity = Date.now() - 2000;
      await runTurn(
        config,
        f.session,
        { ...proactive, revision: f.session.revision },
        [persona],
        f.media,
        adapters,
      );
      const error = f.events.find((event) => event.type === 'error');
      assert.ok(error?.type === 'error' && error.diagnostic);
      assert.match(error.message, /empty reply/);
      assert.equal(error.diagnostic.rawOutput, '');
      assert.equal(error.diagnostic.outputComplete, true);
      assert.equal(error.diagnostic.finishReason, 'stop');
      assert.deepEqual(error.diagnostic.requestBody, requests.at(-1));
      assert.equal(f.session.history.length, 3);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await f.close();
    }
  }
});

test('suggested replies stay outside history and diagnostic downloads are scoped to their session', async () => {
  let calls = 0;
  let slow = false;
  let invalid = false;
  let sentBody: any;
  let release!: () => void;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const input = JSON.parse(body);
    sentBody = input;
    calls++;
    assert.match(input.messages[0].content, /FROM THE USER/);
    assert.equal(input.messages.length, 2);
    assert.deepEqual(JSON.parse(input.messages[1].content.split('\n')[1]), [
      { speaker: 'user', text: 'Hi' },
      { speaker: 'Mira', text: 'Hello!' },
    ]);
    assert.equal(input.messages.at(-1).role, 'user');
    assert.match(input.messages.at(-1).content, /suggested next message/);
    if (slow)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: invalid
                ? '{"bad":"Malformed draft"}'
                : '{"draft":"Tell me more about that."}',
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const f = await fixture();
  const context = await createApplication({
    ...f.config,
    LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
  });
  const server = createServer(context.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = new Session();
  session.history = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
  ];
  context.sessions.set(session.id, session);
  const request = (localizedProfanity?: boolean, preferences: Record<string, unknown> = {}) =>
    fetch(`${url}/api/sessions/${session.id}/suggest-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'en', revision: 0, localizedProfanity, ...preferences }),
    });
  try {
    const response = await request(true, {
      getToKnowEachOther: true,
      aboutMe: 'I like quiet walks.',
      miraBehavior: 'MIRA_PRIVATE_SECRET_93: fond of bluebells.',
    });
    assert.equal(response.status, 200);
    assert.match(sentBody.messages.at(-1).content, /LOCALIZED PROFANITY MODE: ON/);
    assert.match(sentBody.messages.at(-1).content, /CONVERSATION FOCUS: GET TO KNOW EACH OTHER/);
    assert.match(sentBody.messages.at(-1).content, /I like quiet walks/);
    assert.ok(!JSON.stringify(sentBody).includes('MIRA_PRIVATE_SECRET_93'));
    assert.equal((await request(false, { aboutMe: 'x'.repeat(2001) })).status, 422);
    assert.deepEqual(await response.json(), { draft: 'Tell me more about that.', revision: 0 });
    assert.equal(session.history.length, 2);
    invalid = true;
    const failed = await request();
    assert.equal(failed.status, 502);
    assert.match(sentBody.messages.at(-1).content, /LOCALIZED PROFANITY MODE: OFF/);
    assert.ok(
      !sentBody.messages.at(-1).content.includes('CONVERSATION FOCUS: GET TO KNOW EACH OTHER'),
    );
    assert.ok(!sentBody.messages.at(-1).content.includes('I like quiet walks'));
    const failedDraft = await failed.json();
    assert.deepEqual(failedDraft.diagnostic.requestBody, sentBody);
    assert.equal(session.history.length, 2);
    assert.ok(!JSON.stringify(failedDraft).includes(f.config.LLM_API_KEY));
    const failedDownload = await fetch(url + failedDraft.diagnostic.downloadUrl);
    assert.equal(failedDownload.status, 200);
    assert.deepEqual((await failedDownload.json()).requestBody, sentBody);
    invalid = false;
    slow = true;
    const work = request();
    for (let i = 0; i < 100 && calls < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await request()).status, 409);
    session.revision++;
    session.suggestion?.abort();
    release();
    assert.equal((await work).status, 409);
    const other = new Session();
    context.sessions.set(other.id, other);
    session.diagnostics.push({
      id: 'sample-diagnostic',
      turnId: 'sample',
      createdAt: 'now',
      model: 'fake',
      reason: 'bad JSON',
      rawOutput: 'raw',
      outputComplete: true,
      truncated: false,
      finishReason: 'stop',
      parser: {},
    });
    const own = await fetch(`${url}/api/sessions/${session.id}/diagnostics/sample-diagnostic`);
    assert.equal(own.status, 200);
    assert.equal((await own.json()).rawOutput, 'raw');
    assert.equal(
      (await fetch(`${url}/api/sessions/${other.id}/diagnostics/sample-diagnostic`)).status,
      404,
    );
  } finally {
    release?.();
    await context.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    await f.close();
  }
});

test('only unreviewed automatic submissions mark user history as generated', async () => {
  const f = await fixture();
  try {
    for (const automatic of [true, false]) {
      await runTurn(f.config, f.session, { ...command, automatic }, [persona], f.media, {
        answer: async (_c, history, _l, delta) => {
          assert.equal(history.at(-1)?.generated, automatic ? true : undefined);
          const raw = '[{"phrase":"A reply.","emotion":"neutral","gestures":[]}]';
          delta(raw);
          return raw;
        },
        synthesize: async () => {
          throw new Error('No speech');
        },
        mouthCues: async () => [],
      });
      assert.equal(f.session.history.at(-2)?.generated, automatic ? true : undefined);
      assert.equal(f.session.history.at(-2)?.content, 'Hello');
      assert.equal(f.session.history.at(-1)?.content, 'A reply.');
    }
  } finally {
    await f.close();
  }
});
