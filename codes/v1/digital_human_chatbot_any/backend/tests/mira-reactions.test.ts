import test from 'node:test';
import assert from 'node:assert/strict';
import { MiraReactions } from '../src/conversation/MiraReactions.js';
import { Session } from '../src/sessions.js';
import { buildReplyMessages, buildDraftMessages } from '../src/llm/requestMessages.js';
import { JsonReplyParser } from '../src/llm/JsonReplyParser.js';
import { PoseController } from '../../frontend/src/performance/PoseController.js';
import { loadSettings, settingsStorageKey } from '../../frontend/src/settings/storage.js';
import { supportsPerformanceProtocol, type PhrasePerformance } from '@digital-human/shared';

const behavior = 'Mira 暗暗喜歡我，被玩笑揭穿時會害羞生氣跳起來。';
const hop: PhrasePerformance = {
  emotion: 'angry',
  gestures: [{ name: 'angry_hop', strength: 0.8 }],
};
const base = { bones: {}, expressions: {} };

test('the UI detects a stale backend even when a new frontend bundle is served from disk', () => {
  assert.equal(supportsPerformanceProtocol(undefined), undefined);
  assert.equal(supportsPerformanceProtocol({}), false);
  assert.equal(supportsPerformanceProtocol({ performanceProtocolVersion: 0 }), false);
  assert.equal(supportsPerformanceProtocol({ performanceProtocolVersion: 1 }), false);
  assert.equal(supportsPerformanceProtocol({ performanceProtocolVersion: 2 }), true);
});

test('Mira direction is separate from user biography, survives prompt modes, and gives the configured reaction explicit priority', () => {
  const history = [{ role: 'user' as const, content: '你就是喜歡我，別裝了。' }];
  for (const mode of [
    {},
    { proactive: true },
    { repetitionRetry: true },
    { recoveryStage: 'related' as const },
  ]) {
    const body = buildReplyMessages(history, 'zh', {
      ...mode,
      naturalVariation: true,
      getToKnowEachOther: true,
      conversationalPhrases: true,
      aboutMe: '我叫陳大文。',
      miraBehavior: behavior,
      miraAngryHopEnabled: true,
    }).at(-1)!.content;
    assert.match(body, /YOUR PRIVATE CHARACTER PROFILE/);
    assert.ok(body.indexOf(behavior) > body.indexOf('Valid example:'));
    assert.match(body, /REACTION FAMILY/);
    assert.match(body, /"name":"flustered_denial","intensity":0.85/);
    assert.match(body, /genuine anger\/distress/);
    assert.ok(!body.includes('我叫陳大文'));
  }
  const cooling = buildReplyMessages(history, 'zh', {
    miraBehavior: behavior,
    angryHopCooldown: 2,
  }).at(-1)!.content;
  assert.match(cooling, /cooling down for 2/);
  const off = buildReplyMessages(history, 'zh', { miraAngryHopEnabled: false }).at(-1)!.content;
  assert.match(off, /Hopping is disabled/);
  assert.ok(
    !buildDraftMessages(history, 'zh', { miraBehavior: behavior })
      .at(-1)!
      .content.includes(behavior),
  );
});

test('reaction family is validated, maps intensity to one action, preserves emotion and suppresses later conflicting poses', () => {
  const family: PhrasePerformance = {
    emotion: 'thoughtful',
    gestures: [],
    reaction: { name: 'flustered_denial', intensity: 0.85 },
  };
  const received: any[] = [];
  const parser = new JsonReplyParser(
    () => {},
    (phrase) => received.push(phrase),
  );
  const raw = JSON.stringify([{ phrase: '別、別亂說啦！', ...family }]);
  for (const character of raw) parser.write(character);
  parser.finish();
  assert.deepEqual(received[0].performance, family);
  const policy = new MiraReactions();
  const plan = policy.plan(true);
  const mapped = plan.apply(received[0].performance, true);
  assert.equal(mapped.decision, 'reaction_mapped');
  assert.equal(mapped.performance.emotion, 'thoughtful');
  assert.deepEqual(mapped.performance.gestures, hop.gestures);
  const conflicting = plan.apply(
    { emotion: 'neutral', gestures: [{ name: 'tsundere_turn', strength: 0.6 }] },
    true,
  );
  assert.equal(conflicting.decision, 'already_selected');
  assert.deepEqual(conflicting.performance.gestures, []);
  const mild = policy
    .plan(true)
    .apply({ ...family, reaction: { name: 'flustered_denial', intensity: 0.3 } }, true);
  assert.equal(mild.performance.gestures[0].name, 'tsundere_turn');
  const disabled = policy.plan(false).apply(family, true);
  assert.equal(disabled.decision, 'hop_disabled');
  assert.equal(disabled.performance.gestures[0].name, 'tsundere_turn');
  policy.complete(plan.hopped);
  const cooling = policy.plan(true).apply(family, true);
  assert.equal(cooling.decision, 'cooldown');
  assert.equal(cooling.performance.gestures[0].name, 'tsundere_turn');
  for (const reaction of [
    { name: 'unknown', intensity: 0.8 },
    { name: 'flustered_denial', intensity: 2 },
  ]) {
    const fallback: any[] = [];
    const invalid = new JsonReplyParser(
      () => {},
      (phrase) => fallback.push(phrase),
    );
    invalid.write(JSON.stringify([{ phrase: 'Still speak this.', ...family, reaction }]));
    invalid.finish();
    assert.deepEqual(fallback[0].performance, { emotion: 'neutral', gestures: [] });
  }
});

test('cooldown counts three completed Mira replies, enforces once per turn, and interrupted plans consume nothing', () => {
  const policy = new MiraReactions();
  const interrupted = policy.plan(true);
  assert.equal(interrupted.apply(hop, true).decision, 'allowed');
  assert.equal(policy.remaining, 0);
  const first = policy.plan(true);
  first.apply(hop, true);
  assert.equal(first.apply(hop, true).decision, 'already_selected');
  policy.complete(first.hopped);
  for (const remaining of [3, 2, 1]) {
    assert.equal(policy.remaining, remaining);
    const attempt = policy.plan(true);
    assert.equal(attempt.apply(hop, true).decision, 'cooldown');
    assert.deepEqual(attempt.apply(hop, true).performance.gestures, [
      { name: 'tsundere_turn', strength: 0.65 },
    ]);
    policy.complete(attempt.hopped);
  }
  assert.equal(policy.plan(true).apply(hop, true).decision, 'allowed');
  policy.reset();
  const textOnly = policy.plan(true);
  textOnly.apply(hop, false);
  policy.complete(textOnly.hopped);
  assert.equal(policy.remaining, 0);
  const session = new Session();
  session.reactions.complete(true);
  session.reset();
  assert.equal(session.reactions.remaining, 0);
});

test('loading settings never copies private profile sentences across owners or overwrites their settings', () => {
  const value = {
    version: 1,
    values: {
      aboutMe: '我叫陳大文。 Mira 是暗暗地喜歡我，但是怕羞，一旦被搓破秘密就會生氣跳起來。',
    },
  };
  const store = {
    getItem: (key: string) => (key === settingsStorageKey ? JSON.stringify(value) : null),
  };
  const result = loadSettings(store);
  assert.equal(result.values.aboutMe, value.values.aboutMe);
  assert.equal(result.values.miraBehavior, '');
  Object.assign(value.values, { miraBehavior: 'A deliberate existing setting.' });
  assert.equal(loadSettings(store).values.aboutMe, value.values.aboutMe);
  assert.equal(loadSettings(store).values.miraBehavior, 'A deliberate existing setting.');
});

test('validated model controls survive parsing and short phrases preserve three hops, pause and finish their tail after audio', () => {
  const controller = new PoseController();
  const events: any[] = [];
  controller.observe = (event) => events.push(event);
  const phrases: any[] = [];
  const parser = new JsonReplyParser(
    () => {},
    (phrase) => phrases.push(phrase),
  );
  parser.write(
    JSON.stringify([
      { phrase: '誰說我喜歡你！', ...hop },
      { phrase: '別亂說啦！', emotion: 'neutral', gestures: [] },
    ]),
  );
  // The wire field is phrase + emotion + gestures, independently of the renderer.
  parser.finish();
  assert.deepEqual(phrases[0].performance, hop);
  controller.beginPhrase(phrases[0].performance.gestures, 0.4);
  let flights = 0;
  let airborne = false;
  const sample = () => {
    const pose = controller.update(base, 0.01, 0);
    const next = (pose.hipsDrop ?? 0) < -0.0001;
    if (next && !airborne) flights++;
    airborne = next;
    return pose;
  };
  for (let phrase = 0; phrase < 3; phrase++) {
    if (phrase) controller.beginPhrase([], 0.4);
    for (let time = 0; time < 0.4; time += 0.01) {
      controller.playbackTime(time);
      sample();
    }
    if (phrase === 1) {
      controller.setPlaybackState('paused');
      const paused = sample();
      for (let index = 0; index < 20; index++) assert.deepEqual(sample(), paused);
      controller.setPlaybackState('playing');
    }
  }
  controller.setPlaybackState('ended');
  for (let index = 0; index < 220; index++) sample();
  assert.equal(flights, 3);
  assert.equal(events.filter((event) => event.status === 'started').length, 1);
  assert.equal(events.filter((event) => event.status === 'completed').length, 1);
  assert.equal(events.filter((event) => event.status === 'cancelled').length, 0);
  assert.deepEqual(controller.update(base, 0.1, 0), base);
});

test('replacement and Stop cancel a hop, while angry emotion without an explicit gesture cannot start one', () => {
  const controller = new PoseController();
  const events: any[] = [];
  controller.observe = (event) => events.push(event);
  controller.beginPhrase(hop.gestures, 0.4);
  controller.playbackTime(0.3);
  controller.update(base, 0.1, 1);
  controller.beginPhrase([{ name: 'tsundere_turn', strength: 0.8 }], 1);
  assert.ok(
    events.some(
      (event) => event.action === 'angry_hop' && event.reason === 'replaced by another action',
    ),
  );
  controller.setPlaybackState('stopped');
  for (let index = 0; index < 10; index++) controller.update(base, 0.1, 0);
  assert.deepEqual(controller.update(base, 0.1, 0), base);
  controller.beginPhrase([], 0.4);
  controller.playbackTime(0.3);
  assert.equal(controller.update(base, 0.1, 1).hipsDrop ?? 0, 0);
});

test('a TTS buffering gap finishes the bounded action instead of stranding it between audio clips', () => {
  const controller = new PoseController();
  const events: any[] = [];
  controller.observe = (event) => events.push(event);
  controller.beginPhrase(hop.gestures, 0.3);
  controller.playbackTime(0.3);
  controller.update(base, 0.1, 1);
  controller.setPlaybackState('buffering');
  for (let index = 0; index < 12; index++) controller.update(base, 0.1, 0);
  controller.setPlaybackState('paused');
  const paused = controller.update(base, 0.1, 0);
  for (let index = 0; index < 12; index++)
    assert.deepEqual(controller.update(base, 0.1, 0), paused);
  controller.setPlaybackState('playing');
  for (let index = 0; index < 30; index++) controller.update(base, 0.1, 0);
  assert.equal(events.filter((event) => event.status === 'completed').length, 1);
  assert.deepEqual(controller.update(base, 0.1, 0), base);
});
