import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ScenePlan, ServerEvent, Persona } from '@digital-human/shared';
import { VirtualScene } from '../src/scenes/VirtualScene.js';
import { Session } from '../src/sessions.js';
import { JsonReplyParser } from '../src/llm/JsonReplyParser.js';
import { runTurn, type Services } from '../src/pipeline.js';
import { MediaStore } from '../src/media.js';
import { readConfig } from '../src/config.js';
import { buildReplyMessages, buildDraftMessages } from '../src/llm/requestMessages.js';

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
  assert.equal(scene.propose({ ...plan, title: 'A different outing' }), false);
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
    assert.match(request.at(-1)!.content, /not a personal fact/);
  }
  assert.match(
    buildReplyMessages(history, 'en', options).at(-1)!.content,
    /first object may additionally include sceneProposal/,
  );
  assert.match(
    buildDraftMessages(history, 'en', options).at(-1)!.content,
    /cannot accept a proposed scene/,
  );
  assert.ok(!buildReplyMessages(history, 'en').at(-1)!.content.includes('VIRTUAL SCENE MODE'));
});

test('initial scene requests demonstrate a complete valid localized plan instead of a dialogue-only format example', () => {
  for (const language of ['en', 'zh', 'yue'] as const) {
    const history = [{ role: 'user' as const, content: 'What could we do together?' }];
    const request = buildReplyMessages(history, language, {
      virtualScenesEnabled: true,
      scene: { enabled: true, version: 1, dismissedTitles: [] },
    });
    const final = request.at(-1)!.content;
    assert.match(final, /FIRST object MUST include a valid sceneProposal/);
    const example = JSON.parse(final.split('Valid example:\n')[1].split('\n')[0]);
    const scene = new VirtualScene();
    scene.configure(true);
    assert.equal(scene.propose(example[0].sceneProposal), true);
    assert.ok(example[0].phrase);
    assert.ok(example[0].emotion);
    assert.deepEqual(example[0].gestures, []);
    const disabled = buildReplyMessages(history, language);
    const simple = JSON.parse(disabled.at(-1)!.content.split('Valid example:\n')[1].split('\n')[0]);
    assert.equal(simple[0].sceneProposal, undefined);
  }
});
