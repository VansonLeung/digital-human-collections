import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ScenePlan, ServerEvent, Persona } from '@digital-human/shared';
import { VirtualScene } from '../src/scenes/VirtualScene.js';
import { Session } from '../src/sessions.js';
import { JsonReplyParser } from '../src/llm/JsonReplyParser.js';
import { runTurn, type Services } from '../src/pipeline.js';
import { MediaStore } from '../src/media.js';
import { readConfig } from '../src/config.js';
import {
  buildReplyMessages,
  buildDraftMessages,
  type ChatMessage,
} from '../src/llm/requestMessages.js';
import { needsSceneExtraction, extractSceneMetadata } from '../src/scenes/extractSceneMetadata.js';
import { outingContext } from '../src/scenes/outingContext.js';

const plan: ScenePlan = {
  title: 'A dessert outing',
  steps: [
    {
      location: 'On the way',
      activity: 'Walking',
      narration: 'Mira leads the way to a small dessert shop.',
      leader: 'mira',
    },
    {
      location: 'Dessert shop',
      activity: 'Choosing dessert',
      narration: 'They arrive and sit down with the menu.',
      leader: 'together',
    },
    {
      location: 'Dessert shop',
      activity: 'Tasting dessert',
      narration: 'Dessert arrives at the table.',
      leader: 'together',
    },
  ],
};
const persona: Persona = {
  id: 'test',
  name: 'Mira',
  renderer: 'vrm',
  modelUrl: '',
  description: '',
  credit: '',
  licenseUrl: '',
};
const command = {
  type: 'turn.send' as const,
  text: 'Let us chat.',
  personaId: 'test',
  language: 'en' as const,
  speech: false,
  virtualScenesEnabled: true,
};
const reply = (phrase: string, sceneProposal?: ScenePlan) =>
  JSON.stringify([
    { phrase, emotion: 'happy', gestures: [], ...(sceneProposal ? { sceneProposal } : {}) },
  ]);

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'virtual-scenes-'));
  const events: ServerEvent[] = [];
  const session = new Session((event) => events.push(event));
  const media = new MediaStore(dir, 900);
  await media.initialize();
  const config = {
    ...readConfig({ LLM_MODEL_NAME: 'fake', LIPSYNC_PROVIDER: 'amplitude' }),
    mediaDir: dir,
  };
  const spoken: string[] = [];
  const services: Services = {
    answer: async (_c, _h, _l, delta) => {
      const raw = reply('I can see a quiet table near the window.');
      delta(raw);
      return raw;
    },
    synthesize: async (_c, text) => {
      spoken.push(text);
      return { bytes: Buffer.from('wav'), duration: 0.1 };
    },
    mouthCues: async () => [],
  };
  return {
    session,
    events,
    media,
    config,
    spoken,
    services,
    close: async () => {
      session.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function acceptScene(session: Session) {
  session.configureScenes(true);
  assert.equal(session.scene.propose(plan), true);
  const state = session.scene.snapshot();
  assert.equal(
    session.decideScene({
      proposalId: state.proposal!.id,
      version: state.version,
      revision: session.revision,
      accept: true,
    }),
    true,
  );
}

test('major scene changes require a current decision; small steps advance only after completed turns', () => {
  const scene = new VirtualScene();
  assert.equal(scene.propose(plan), false);
  scene.configure(true);
  assert.equal(
    scene.propose({ title: 'A non-progressing plan', steps: [plan.steps[0], plan.steps[0]] }),
    false,
  );
  assert.equal(scene.propose(plan), true);
  let state = scene.snapshot();
  assert.equal(state.active, undefined);
  assert.equal(scene.decide(state.proposal!.id, state.version - 1, true), undefined);
  assert.ok(scene.decide(state.proposal!.id, state.version, true));
  state = scene.snapshot();
  assert.equal(state.active!.stepIndex, 0);
  scene.completeTurn(state.version);
  assert.equal(scene.beginTurn(), undefined);
  scene.completeTurn(state.version);
  assert.equal(scene.beginTurn()!.index, 1);
  assert.equal(scene.beginTurn(), undefined);
  assert.equal(scene.propose({ ...plan, title: 'A mid-outing suggestion' }), true);
  const pending = scene.snapshot();
  assert.equal(pending.active!.stepIndex, 1);
  scene.decide(pending.proposal!.id, pending.version, false);
  assert.equal(scene.snapshot().active!.stepIndex, 1);
  state = scene.snapshot();
  scene.completeTurn(state.version);
  scene.completeTurn(state.version);
  assert.equal(scene.beginTurn()!.index, 2);
  assert.equal(scene.propose({ ...plan, title: 'A different outing' }), true);
  state = scene.snapshot();
  assert.ok(scene.decide(state.proposal!.id, state.version, false));
  assert.equal(scene.propose({ ...plan, title: 'A different outing' }), false);
  scene.configure(false);
  scene.completeTurn(scene.snapshot().version);
  assert.equal(scene.beginTurn(), undefined);
  scene.reset();
  assert.equal(scene.snapshot().active, undefined);
  assert.equal(scene.snapshot().proposal, undefined);
});

test('scene metadata is parsed once from the first complete phrase and never becomes dialogue or rig controls', () => {
  const raw = reply('We could try a small dessert shop.', plan);
  for (const width of [1, 7, 41, raw.length]) {
    const proposals: ScenePlan[] = [];
    const spoken: any[] = [];
    const parser = new JsonReplyParser(
      () => {},
      (phrase) => spoken.push(phrase),
      (proposal) => proposals.push(proposal),
    );
    for (let index = 0; index < raw.length; index += width)
      parser.write(raw.slice(index, index + width));
    assert.equal(parser.finish(), 'We could try a small dessert shop.');
    assert.deepEqual(proposals, [plan]);
    assert.deepEqual(spoken, [
      {
        text: 'We could try a small dessert shop.',
        performance: { emotion: 'happy', gestures: [] },
      },
    ]);
  }
  const proposals: ScenePlan[] = [];
  const parser = new JsonReplyParser(
    () => {},
    () => {},
    (proposal) => proposals.push(proposal),
  );
  parser.write(
    JSON.stringify([
      {
        phrase: 'Keep chatting.',
        emotion: 'neutral',
        gestures: [],
        sceneProposal: { title: 'Invalid', steps: [] },
      },
      { phrase: 'No surprise scene.', emotion: 'neutral', gestures: [], sceneProposal: plan },
    ]),
  );
  parser.finish();
  assert.deepEqual(proposals, []);
});

test('a spoken proposal stays unaccepted until playback ends and a real scene decision arrives; narration is not TTS or history', async () => {
  const f = await fixture();
  try {
    await runTurn(f.config, f.session, { ...command, speech: true }, [persona], f.media, {
      ...f.services,
      answer: async (_c, _h, _l, delta) => {
        const raw = reply('Would you enjoy a quiet dessert outing?', plan);
        delta(raw);
        return raw;
      },
    });
    const state = f.session.scene.snapshot();
    assert.ok(state.proposal);
    assert.equal(state.active, undefined);
    const decision = {
      proposalId: state.proposal.id,
      version: state.version,
      revision: f.session.revision,
      accept: true,
    };
    assert.equal(f.session.decideScene(decision), false);
    assert.equal(
      f.events.some((event) => event.type === 'scene.step'),
      false,
    );
    assert.deepEqual(f.spoken, ['Would you enjoy a quiet dessert outing?']);
    assert.ok(!JSON.stringify(f.session.history).includes(plan.steps[0].narration));
    f.session.finish(f.session.active!);
    assert.equal(f.session.decideScene(decision), true);
    assert.equal(f.events.filter((event) => event.type === 'scene.step').length, 1);
    assert.equal(f.session.decideScene(decision), false);
    assert.equal(f.session.scene.snapshot().active!.stepIndex, 0);
  } finally {
    await f.close();
  }
});

test('scene progression waits for successful playback, ignores Stop and uses the new state before generating a subsequent turn', async () => {
  const f = await fixture();
  try {
    acceptScene(f.session);
    await runTurn(
      f.config,
      f.session,
      { ...command, speech: true },
      [persona],
      f.media,
      f.services,
    );
    assert.equal(f.session.scene.snapshot().active!.completedTurns, 0);
    f.session.stop();
    assert.equal(f.session.scene.snapshot().active!.completedTurns, 0);
    for (let index = 0; index < 2; index++) {
      await runTurn(
        f.config,
        f.session,
        { ...command, speech: true },
        [persona],
        f.media,
        f.services,
      );
      assert.ok(f.session.active);
      f.session.finish(f.session.active!);
    }
    assert.equal(f.session.scene.snapshot().active!.stepIndex, 0);
    await runTurn(f.config, f.session, command, [persona], f.media, {
      ...f.services,
      answer: async (_c, _h, _l, delta, _s, options) => {
        assert.equal(options?.scene?.active?.stepIndex, 1);
        const raw = reply('The menu is here; we have arrived.');
        delta(raw);
        return raw;
      },
    });
    assert.equal(f.session.scene.snapshot().active!.stepIndex, 1);
    assert.equal(f.events.filter((event) => event.type === 'scene.step').length, 2);
    f.session.reset();
    assert.equal(f.session.scene.snapshot().active, undefined);
    assert.equal(f.session.scene.snapshot().enabled, true);
  } finally {
    await f.close();
  }
});

test('a repeated automatic Mira turn is retried before text, TTS or a rejected proposal can escape', async () => {
  const f = await fixture();
  const duplicate =
    '跟住啦，柒頭帶路，唔好走丟。到時食完再同你計，我唔係特登幫你㗎，係我自己想食。';
  f.session.history = [
    { role: 'user', content: 'Let us continue.' },
    { role: 'assistant', content: duplicate },
  ];
  let calls = 0;
  try {
    await runTurn(
      f.config,
      f.session,
      { ...command, automatic: true, speech: true },
      [persona],
      f.media,
      {
        ...f.services,
        answer: async (_c, _h, _l, delta, _signal, options) => {
          assert.equal(f.spoken.length, 0);
          assert.equal(options?.repetitionRetry, calls > 0);
          const raw = calls++
            ? reply('The dessert has arrived, and the bowl is still warm.')
            : reply(duplicate, plan);
          delta(raw);
          return raw;
        },
      },
    );
    assert.equal(calls, 2);
    assert.deepEqual(f.spoken, ['The dessert has arrived, and the bowl is still warm.']);
    assert.equal(f.session.scene.snapshot().proposal, undefined);
    assert.ok(
      !JSON.stringify(
        f.events.filter((event) => event.type === 'answer.delta' || event.type === 'answer.phrase'),
      ).includes(duplicate),
    );
    assert.equal(f.session.history.at(-1)!.content, f.spoken[0]);
  } finally {
    await f.close();
  }
});

test('with recovery disabled persistent automatic repetition stops after two attempts without TTS, history changes or scene progress, and keeps diagnostics', async () => {
  const f = await fixture();
  const duplicate =
    'We can follow the same path and talk about the exact same dessert again later.';
  f.session.history = [
    { role: 'user', content: 'Hi.' },
    { role: 'assistant', content: duplicate },
  ];
  const original = structuredClone(f.session.history);
  let calls = 0;
  try {
    await runTurn(
      f.config,
      f.session,
      { ...command, automatic: true, speech: true, autoRecoverStalls: false },
      [persona],
      f.media,
      {
        ...f.services,
        answer: async (_c, _h, _l, delta) => {
          calls++;
          const raw = reply(duplicate, plan);
          delta(raw);
          return raw;
        },
      },
    );
    assert.equal(calls, 2);
    assert.deepEqual(f.spoken, []);
    assert.deepEqual(f.session.history, original);
    assert.equal(f.session.scene.snapshot().proposal, undefined);
    const error = f.events.find((event) => event.type === 'error');
    assert.ok(error?.type === 'error' && error.diagnostic);
    assert.match(error.message, /repeated recent dialogue twice/);
    assert.equal(error.retryable, false);
    assert.equal(error.diagnostic.rawOutput, reply(duplicate, plan));
    assert.equal((error.diagnostic.parser.repetition as any).attempts, 2);
    assert.equal(
      f.events.some((event) => event.type === 'answer.phrase'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('Stop during a repetition retry discards late model output and never synthesizes or commits it', async () => {
  const f = await fixture();
  const duplicate = 'We will keep saying the same thing and then keep saying it again tomorrow.';
  f.session.history = [
    { role: 'user', content: 'Hi.' },
    { role: 'assistant', content: duplicate },
  ];
  let release!: () => void;
  let ready!: () => void;
  const retryStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    const task = runTurn(
      f.config,
      f.session,
      { ...command, automatic: true, speech: true },
      [persona],
      f.media,
      {
        ...f.services,
        answer: async (_c, _h, _l, delta, _signal, options) => {
          if (options?.repetitionRetry) {
            ready();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          const raw = reply(
            options?.repetitionRetry
              ? 'This late reply must never be spoken or committed.'
              : duplicate,
          );
          delta(raw);
          return raw;
        },
      },
    );
    await retryStarted;
    f.session.stop();
    release();
    await task;
    assert.deepEqual(f.spoken, []);
    assert.equal(f.session.history.length, 2);
    assert.equal(
      f.events.some((event) => event.type === 'answer.phrase'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('automatic Mira recovery tries a related angle before a fresh topic within one turn, and speaks only the accepted result', async () => {
  for (const successAt of [2, 3]) {
    const f = await fixture();
    const duplicate =
      'We will keep following the same path and discussing this same dessert again later.';
    f.session.history = [{ role: 'assistant', content: duplicate }];
    const stages: unknown[] = [];
    try {
      await runTurn(
        f.config,
        f.session,
        { ...command, automatic: true, speech: true },
        [persona],
        f.media,
        {
          ...f.services,
          answer: async (_c, _h, _l, delta, _signal, options) => {
            assert.deepEqual(f.spoken, []);
            stages.push(options?.recoveryStage);
            const raw = reply(
              stages.length > successAt
                ? 'The quiet corner looks comfortable; shall we sit near the window?'
                : duplicate,
            );
            delta(raw);
            return raw;
          },
        },
      );
      assert.deepEqual(stages, [undefined, undefined, 'related', 'fresh'].slice(0, successAt + 1));
      assert.equal(f.events.filter((event) => event.type === 'turn.started').length, 1);
      assert.equal(f.spoken.length, 1);
      assert.equal(f.session.history.length, 3);
      assert.equal(f.session.history.at(-1)!.content, f.spoken[0]);
      assert.equal(f.events.filter((event) => event.type === 'answer.phrase').length, 1);
      assert.ok(!f.events.some((event) => event.type === 'error'));
    } finally {
      await f.close();
    }
  }
});

test('exhausted recovery stops at four generations and diagnostics name the failed stages', async () => {
  const f = await fixture();
  const duplicate =
    'We will keep following this same path and discussing the same dessert again later.';
  f.session.history = [{ role: 'assistant', content: duplicate }];
  let attempts = 0;
  try {
    await runTurn(
      f.config,
      f.session,
      { ...command, automatic: true, speech: true },
      [persona],
      f.media,
      {
        ...f.services,
        answer: async (_c, _h, _l, delta) => {
          attempts++;
          const raw = reply(duplicate);
          delta(raw);
          return raw;
        },
      },
    );
    assert.equal(attempts, 4);
    assert.equal(f.session.history.length, 1);
    assert.deepEqual(f.spoken, []);
    const error = f.events.find((event) => event.type === 'error');
    assert.ok(error?.type === 'error');
    assert.match(error.message, /related angle and a fresh topic/);
    assert.deepEqual(error.diagnostic?.parser.repetition, {
      role: 'assistant',
      score: 1,
      attempts: 4,
      recoveryExhausted: true,
    });
  } finally {
    await f.close();
  }
});

test('Stop during related-angle recovery prevents a late reply from being rendered or spoken', async () => {
  const f = await fixture();
  const duplicate =
    'We will keep following this same path and discussing the same dessert again later.';
  f.session.history = [{ role: 'assistant', content: duplicate }];
  let release!: () => void;
  let ready!: () => void;
  const reachedRecovery = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    const task = runTurn(
      f.config,
      f.session,
      { ...command, automatic: true, speech: true },
      [persona],
      f.media,
      {
        ...f.services,
        answer: async (_c, _h, _l, delta, _signal, options) => {
          if (options?.recoveryStage) {
            ready();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          const raw = reply(
            options?.recoveryStage ? 'This late recovery reply must never be spoken.' : duplicate,
          );
          delta(raw);
          return raw;
        },
      },
    );
    await reachedRecovery;
    f.session.stop();
    release();
    await task;
    assert.equal(f.session.history.length, 1);
    assert.deepEqual(f.spoken, []);
    assert.ok(!f.events.some((event) => event.type === 'answer.phrase'));
  } finally {
    await f.close();
  }
});

test('both speakers get scene ownership and completed steps while scene mode off preserves existing contracts', () => {
  const scene = new VirtualScene();
  scene.configure(true);
  scene.propose(plan);
  let state = scene.snapshot();
  scene.decide(state.proposal!.id, state.version, true);
  state = scene.snapshot();
  scene.completeTurn(state.version);
  scene.completeTurn(state.version);
  scene.beginTurn();
  const history = [{ role: 'user' as const, content: 'What next?' }];
  const options = { virtualScenesEnabled: true, scene: scene.snapshot() };
  for (const request of [
    buildReplyMessages(history, 'en', options),
    buildDraftMessages(history, 'en', options),
  ]) {
    assert.match(request.at(-1)!.content, /Earlier steps are completed/);
    assert.match(request.at(-1)!.content, /Leading: together/);
    assert.match(request.at(-1)!.content, /never phrase strings/);
    assert.match(request.at(-1)!.content, /never establish real-user biography/);
  }
  assert.match(
    buildReplyMessages(history, 'en', options).at(-1)!.content,
    /sceneProposal or sceneAgreement/,
  );
  assert.match(
    buildDraftMessages(history, 'en', options).at(-1)!.content,
    /cannot click or bypass/,
  );
  assert.ok(!buildReplyMessages(history, 'en').at(-1)!.content.includes('VIRTUAL SCENE MODE'));
});

test('scene prompts keep first-turn suggestions optional and require quoted agreement with now/later timing', () => {
  for (const language of ['en', 'zh', 'yue'] as const) {
    const request = buildReplyMessages([{ role: 'user', content: 'Hello.' }], language, {
      virtualScenesEnabled: true,
      autoEnterScenes: true,
      scene: { enabled: true, version: 1, dismissedTitles: [] },
    });
    const final = request.at(-1)!.content;
    assert.ok(!final.includes('FIRST object MUST include a valid sceneProposal'));
    assert.match(final, /not because this is the first reply/);
    assert.match(final, /offerQuote/);
    assert.match(final, /acceptanceQuote/);
    assert.match(final, /timing later/);
    assert.match(final, /unfinished outing after agreement/);
    const example = JSON.parse(final.split('Valid example:\n')[1].split('\n')[0]);
    assert.equal(example[0].sceneProposal, undefined);
  }
});

test('quoted agreement can start successive new outings before the previous plan finishes, after playback only', async () => {
  const f = await fixture();
  try {
    acceptScene(f.session);
    for (const title of ['A garden visit', 'A bookstore visit', 'A seaside walk']) {
      const input = `Let us try ${title} now.`;
      const phrase = 'Yes, let us go now. I prefer quiet places.';
      const raw = JSON.stringify([
        {
          phrase,
          emotion: 'happy',
          gestures: [],
          sceneProposal: { ...plan, title },
          sceneAgreement: {
            offerQuote: input,
            acceptanceQuote: 'Yes, let us go now.',
            timing: 'now',
          },
          memories: [
            {
              owner: 'mira',
              category: 'preferences',
              key: 'quiet_places',
              value: 'Likes quiet places.',
              quote: 'I prefer quiet places.',
            },
          ],
        },
      ]);
      await runTurn(
        f.config,
        f.session,
        { ...command, text: input, speech: true, autoEnterScenes: true },
        [persona],
        f.media,
        {
          ...f.services,
          answer: async (_c, _h, _l, delta, _s, options) => {
            assert.match(options!.memoryContext!, /CONVERSATION MEMORY/);
            delta(raw);
            return raw;
          },
        },
      );
      let state = f.session.scene.snapshot();
      assert.notEqual(state.active!.plan.title, title);
      assert.equal(state.proposal!.title, title);
      assert.equal(state.agreement, undefined);
      f.session.finish(f.session.active!);
      state = f.session.scene.snapshot();
      assert.deepEqual(state.agreement, { proposalId: state.proposal!.id, timing: 'now' });
      assert.equal(f.session.memory.snapshot()[0].source, 'mira_fiction');
      assert.equal(
        f.session.decideScene({
          proposalId: state.proposal!.id,
          version: state.version,
          revision: f.session.revision,
          accept: true,
        }),
        true,
      );
      assert.equal(f.session.scene.snapshot().active!.plan.title, title);
      assert.equal(f.session.scene.snapshot().active!.stepIndex, 0);
    }
    assert.equal(f.events.filter((event) => event.type === 'scene.step').length, 4);
    assert.equal(f.session.scene.snapshot().history!.length, 3);
    assert.equal(f.session.scene.snapshot().history![0].location, plan.steps[0].location);
    f.session.reset();
    assert.equal(f.session.scene.snapshot().history, undefined);
    assert.ok(f.spoken.every((text) => text === 'Yes, let us go now. I prefer quiet places.'));
    assert.ok(!JSON.stringify(f.session.history).includes('sceneAgreement'));
  } finally {
    await f.close();
  }
});

test('future agreements stay marked later; wrong quotes, Stop and failed playback cannot commit agreement or memory', async () => {
  for (const mode of ['later', 'wrong_quote', 'stop', 'failed'] as const) {
    const f = await fixture();
    try {
      const text = 'Let us visit a garden tomorrow.';
      const phrase = 'Yes, next time. I prefer tea.';
      const raw = JSON.stringify([
        {
          phrase,
          emotion: 'thoughtful',
          gestures: [],
          sceneProposal: plan,
          sceneAgreement: {
            offerQuote: mode === 'wrong_quote' ? 'Invented acceptance.' : text,
            acceptanceQuote: 'Yes, next time.',
            timing: 'later',
          },
          memories: [
            {
              owner: 'mira',
              category: 'preferences',
              key: 'drink',
              value: 'Likes tea.',
              quote: 'I prefer tea.',
            },
          ],
        },
      ]);
      await runTurn(f.config, f.session, { ...command, text, speech: true }, [persona], f.media, {
        ...f.services,
        answer: async (_c, _h, _l, delta) => {
          delta(raw);
          return raw;
        },
      });
      assert.deepEqual(f.session.memory.snapshot(), []);
      if (mode === 'stop') f.session.stop();
      else {
        if (mode === 'failed') f.session.active!.succeeded = false;
        f.session.finish(f.session.active!);
      }
      assert.equal(
        f.session.scene.snapshot().agreement?.timing,
        mode === 'later' ? 'later' : undefined,
      );
      assert.equal(
        f.session.memory.snapshot().length,
        mode === 'stop' || mode === 'failed' ? 0 : 1,
      );
      assert.equal(f.session.scene.snapshot().active, undefined);
    } finally {
      await f.close();
    }
  }
});

test('missing outing metadata gets one focused extraction without regenerating or speaking the dialogue twice; ordinary chat adds no call', async () => {
  const f = await fixture();
  const text = 'Let us go to a bookstore now.';
  const phrase = 'Yes, let us go now.';
  let calls = 0;
  const adapters: Services = {
    ...f.services,
    answer: async (_c, _h, _l, delta) => {
      const raw = reply(phrase);
      delta(raw);
      return raw;
    },
    sceneMetadata: async (_c, _state, input, actualReply) => {
      calls++;
      assert.equal(input, text);
      assert.equal(actualReply, phrase);
      return {
        proposal: plan,
        agreement: { offerQuote: text, acceptanceQuote: phrase, timing: 'now' },
      };
    },
  };
  try {
    await runTurn(
      f.config,
      f.session,
      { ...command, text, speech: true },
      [persona],
      f.media,
      adapters,
    );
    assert.equal(calls, 1);
    assert.deepEqual(f.spoken, [phrase]);
    f.session.finish(f.session.active!);
    assert.equal(f.session.scene.snapshot().agreement?.timing, 'now');
    await runTurn(
      f.config,
      f.session,
      { ...command, text: 'What is your favorite color?', speech: false },
      [persona],
      f.media,
      {
        ...adapters,
        answer: async (_c, _h, _l, delta) => {
          const raw = reply('I like blue.');
          delta(raw);
          return raw;
        },
      },
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('explicit spoken assent can supply missing agreement metadata, while withdrawals, unrelated yes and future plans remain safe', async () => {
  const { clearSpokenAgreement } = await import('../src/scenes/SceneDirector.js');
  const scene = { enabled: true, version: 1, dismissedTitles: [] };
  const input = '不如依家一齊去附近間書店睇書，你去唔去？';
  assert.equal(
    clearSpokenAgreement(scene, input, '好呀，我正想出去透下氣。你鍾意睇咩書？', true)?.timing,
    'now',
  );
  assert.equal(clearSpokenAgreement(scene, input, '去呀，點會唔去？', true)?.timing, 'now');
  assert.equal(
    clearSpokenAgreement(scene, '不如下次一齊去書店。', '好呀，改天去。', true)?.timing,
    'later',
  );
  assert.equal(clearSpokenAgreement(scene, input, '好呀，不過我唔想去喇。', true), undefined);
  assert.equal(clearSpokenAgreement(scene, '你識唔識廣東話？', '好呀，一齊去。', true), undefined);
  assert.equal(clearSpokenAgreement(scene, input, '可能啦，等我諗下。', true), undefined);
  assert.equal(clearSpokenAgreement(scene, input, '好呀。', false), undefined);
  assert.equal(clearSpokenAgreement(scene, input, '好啦，一齊去啦。', true)?.timing, 'now');
});

test('the optional scene extractor is gated to outing-like dialogue, not every conversational suggestion', async () => {
  const { needsSceneExtraction } = await import('../src/scenes/extractSceneMetadata.js');
  const scene = { enabled: true, version: 1, dismissedTitles: [] };
  assert.equal(needsSceneExtraction(scene, '不如講下你鍾意咩音樂？', '我鍾意爵士樂。'), false);
  assert.equal(needsSceneExtraction(scene, '我請你食糖水，好唔好？', '好呀。'), true);
  assert.equal(needsSceneExtraction(scene, 'We could go to a bookstore.', 'Sure.'), true);
  assert.equal(needsSceneExtraction({ ...scene, enabled: false }, 'Let us go now.', 'Yes.'), false);
});

const dinnerTranscript = JSON.parse(
  await readFile(new URL('./fixtures/cantonese-central-dinner.json', import.meta.url), 'utf8'),
) as {
  messages: { role: 'user' | 'assistant'; phrases: string[] }[];
};
const dinnerHistory: ChatMessage[] = dinnerTranscript.messages.map(({ role, phrases }) => ({
  role,
  content: phrases.join(' '),
}));
const dinnerPlan: ScenePlan = {
  title: '中環意大利菜晚餐',
  steps: [
    {
      location: '中環地鐵站 B 出口',
      activity: '會合',
      narration: '兩人喺約定嘅出口會合。',
      leader: 'user',
    },
    {
      location: '中環嘅意大利餐廳',
      activity: '揀意粉',
      narration: '兩人坐低睇餐牌，揀想食嘅意粉。',
      leader: 'together',
    },
    {
      location: '餐廳飯枱',
      activity: '食飯傾偈',
      narration: '意粉送到，兩人一邊食一邊傾偈。',
      leader: 'together',
    },
  ],
};

test('saved Cantonese dinner dialogue triggers extraction for invitations, departure and meetup follow-ups', () => {
  const scene = { enabled: true, version: 1, dismissedTitles: [] };
  assert.equal(dinnerHistory.length, 26);
  for (const index of [16, 18, 20, 22, 24]) {
    const input = dinnerHistory[index].content;
    const actualReply = dinnerHistory[index + 1].content;
    const history = dinnerHistory.slice(0, index + 1);
    assert.equal(needsSceneExtraction(scene, input, actualReply, history), true, input);
    assert.equal(
      needsSceneExtraction({ ...scene, enabled: false }, input, actualReply, history),
      false,
    );
  }
  assert.equal(needsSceneExtraction(scene, '我梗係識去啦，低B妹，而家行喔', '快啲啦。'), false);
  assert.equal(needsSceneExtraction(scene, '我每日搭地鐵返工。', '返工辛苦喇。'), false);
  const active = {
    ...scene,
    active: { plan: { ...dinnerPlan, id: 'existing' }, stepIndex: 0, completedTurns: 0 },
  };
  assert.equal(needsSceneExtraction(active, '到咗喇。', 'We have arrived.', dinnerHistory), false);
  assert.equal(needsSceneExtraction(active, '不如去花園。', '好呀。', dinnerHistory), true);
  assert.equal(
    needsSceneExtraction(scene, '我唔鍾意意大利菜。', '我明白。', dinnerHistory.slice(0, 19)),
    false,
  );
  assert.equal(
    needsSceneExtraction(scene, '不如講下你鍾意咩音樂？', '我鍾意爵士樂。', dinnerHistory),
    false,
  );
});

test('scene fallback receives bounded spoken context, keeps valid proposals when agreement is absent or invalid, and never fabricates acceptance', async () => {
  const requests: any[] = [];
  let response: Record<string, unknown> = { sceneProposal: dinnerPlan };
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = readConfig({
    LLM_MODEL_NAME: 'fake',
    LLM_STREAM: 'false',
    LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
  });
  const scene = { enabled: true, version: 1, dismissedTitles: [] };
  const history = dinnerHistory.slice(0, 23);
  const input = dinnerHistory[22].content;
  const actualReply = dinnerHistory[23].content;
  try {
    for (const sceneAgreement of [
      undefined,
      { offerQuote: input, acceptanceQuote: '好', timing: 'now' },
    ]) {
      response = { sceneProposal: dinnerPlan, ...(sceneAgreement ? { sceneAgreement } : {}) };
      const result = await extractSceneMetadata(
        config,
        scene,
        input,
        actualReply,
        AbortSignal.timeout(3000),
        history,
      );
      assert.deepEqual(result.proposal, dinnerPlan);
      assert.equal(result.agreement, undefined, 'asking where to meet is not fresh acceptance');
    }
    const messages = requests[0].messages;
    const context = JSON.parse(messages[1].content.split('\n')[1]);
    assert.equal(context.length, 8);
    assert.ok(context.some((entry: any) => entry.text.includes('中環嗰間')));
    assert.ok(context.some((entry: any) => entry.text.includes('意大利菜')));
    assert.equal(context.at(-1).speaker, 'Mira');
    assert.equal(
      context.some((entry: any) => entry.text === input),
      false,
      'latest input is not duplicated',
    );
    assert.ok(!JSON.stringify(messages).includes('ABOUT ME'));
    assert.ok(!JSON.stringify(messages).includes('ABOUT MIRA'));
    response = { sceneProposal: null, sceneAgreement: null };
    const refused = await extractSceneMetadata(
      config,
      scene,
      '不如去食飯？',
      '唔去，我想留喺度。',
      AbortSignal.timeout(3000),
      history,
    );
    assert.equal(refused.proposal, undefined);
    assert.equal(refused.agreement, undefined);
    assert.deepEqual(
      outingContext([{ role: 'user', content: 'x'.repeat(3000) }], 'new message')[0].text.length,
      2000,
    );
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('the reported dinner departure recovers a scene through the production pipeline without changing or re-speaking dialogue', async () => {
  const f = await fixture();
  const index = 20;
  const input = dinnerHistory[index].content;
  const actualReply = dinnerHistory[index + 1].content;
  f.session.history = dinnerHistory.slice(0, index);
  let extractionCalls = 0;
  try {
    await runTurn(
      f.config,
      f.session,
      { ...command, text: input, language: 'yue', speech: true, autoEnterScenes: true },
      [persona],
      f.media,
      {
        ...f.services,
        answer: async (_c, _history, _language, delta) => {
          const raw = JSON.stringify(
            dinnerTranscript.messages[index + 1].phrases.map((phrase) => ({
              phrase,
              emotion: 'neutral',
              gestures: [],
            })),
          );
          delta(raw);
          return raw;
        },
        sceneMetadata: async (_config, _scene, text, replyText, _signal, context) => {
          extractionCalls++;
          assert.equal(text, input);
          assert.equal(replyText, actualReply);
          assert.ok(context?.some((message) => message.content.includes('意大利菜')));
          assert.ok(!JSON.stringify(context).includes('RESPONSE REQUIREMENTS'));
          return {
            proposal: dinnerPlan,
            agreement: {
              offerQuote: '而家行喔',
              acceptanceQuote: '咁就快啲啦，唔好俾人等。',
              timing: 'now',
            },
          };
        },
      },
    );
    assert.equal(extractionCalls, 1);
    assert.deepEqual(f.spoken, dinnerTranscript.messages[index + 1].phrases);
    let state = f.session.scene.snapshot();
    assert.deepEqual(state.proposal?.steps, dinnerPlan.steps);
    assert.equal(state.agreement, undefined);
    assert.equal(state.active, undefined);
    f.session.finish(f.session.active!);
    state = f.session.scene.snapshot();
    assert.equal(state.agreement?.timing, 'now');
    assert.ok(
      f.events.some(
        (event) => event.type === 'scene.state' && event.scene.proposal?.title === dinnerPlan.title,
      ),
    );
    assert.equal(
      f.session.decideScene({
        proposalId: state.proposal!.id,
        version: state.version,
        revision: f.session.revision,
        accept: true,
      }),
      true,
    );
    assert.equal(f.session.scene.snapshot().active?.stepIndex, 0);
    assert.deepEqual(f.session.memory.snapshot(), []);
    assert.ok(!JSON.stringify(f.session.history).includes(dinnerPlan.steps[0].narration));
  } finally {
    await f.close();
  }
});
