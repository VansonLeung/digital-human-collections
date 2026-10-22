import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationProgress,
  type ProgressUpdate,
} from '../src/conversation/ConversationProgress.js';
import { Session } from '../src/sessions.js';
import { JsonReplyParser } from '../src/llm/JsonReplyParser.js';
import { buildReplyMessages, buildDraftMessages } from '../src/llm/requestMessages.js';

const update: ProgressUpdate = {
  topic: 'dessert',
  angle: 'walking',
  kind: 'decision',
  summary: 'Agree to walk to dessert',
  quote: 'Let us go.',
  pendingAction: 'Let us go.',
};
const notes = (progress: ConversationProgress) => JSON.parse(progress.context().split('\n')[1]);

test('semantic progress hints catch reworded promises and escalate without requiring identical dialogue', () => {
  const progress = new ConversationProgress();
  progress.collect(update, '', 'Let us go.');
  const rephrased = [
    'Follow me.',
    'I will lead the way.',
    'Keep up with me.',
    'We should get going.',
  ];
  for (const [index, quote] of rephrased.entries()) {
    progress.collect({ ...update, kind: 'repeat', quote }, '', quote);
    assert.equal(
      notes(progress).nextMove,
      ['continue', 'related_angle', 'concrete_next_step', 'fresh_topic'][index],
    );
  }
  assert.match(progress.context(), /never abandon an unresolved manual request/);
  assert.match(progress.context(), /enter a proposed scene without acceptance/);
  progress.collect(
    {
      ...update,
      angle: 'order',
      kind: 'detail',
      summary: 'Consider warm dessert',
      quote: 'A warm dessert sounds nice.',
    },
    '',
    'A warm dessert sounds nice.',
  );
  assert.equal(notes(progress).nextMove, 'continue');
});

test('progress stays bounded, rejects unsupported quotes, preserves questions and clears on scene/session changes', () => {
  const progress = new ConversationProgress();
  progress.collect(
    { ...update, quote: 'Fabricated quote' },
    'What would you order?',
    'I would order mango pudding.',
  );
  assert.equal(notes(progress).recent.length, 0);
  progress.collect(
    {
      ...update,
      kind: 'answer',
      quote: 'Mango pudding.',
      answeredQuestion: 'What would you order?',
    },
    'What would you order?',
    'Mango pudding.',
  );
  assert.deepEqual(notes(progress).openQuestions, []);
  assert.deepEqual(notes(progress).answeredQuestions, ['What would you order?']);
  for (let index = 0; index < 20; index++)
    progress.collect({ ...update, kind: 'repeat' }, '', 'Let us go.');
  assert.equal(notes(progress).recent.length, 8);
  progress.sceneChanged();
  assert.equal(notes(progress).stalledExchanges, 0);
  assert.equal(notes(progress).pendingAction, undefined);
  const session = new Session();
  session.progress.collect(update, '', 'Let us go.');
  assert.match(session.conversationContext(''), /CONVERSATION PROGRESS/);
  assert.deepEqual(session.memory.snapshot(), []);
  session.reset();
  assert.equal(session.progress.context(), '');
});

test('absent progress metadata requests a meaning-based checkpoint but never invents a detected stall', () => {
  const progress = new ConversationProgress();
  for (let index = 0; index < 4; index++)
    progress.collect(undefined, 'Tell me more.', 'Here is a new detail.');
  assert.match(progress.context(), /PROGRESS CHECKPOINT/);
  assert.equal(notes(progress).stalledExchanges, 0);
  assert.doesNotMatch(progress.context(), /STALLED EXCHANGE:/);
});

test('progress is first-object-only, never spoken, and both speakers receive working notes and short speech targets', () => {
  const speech: string[] = [];
  const metadata: any[] = [];
  const parser = new JsonReplyParser(
    () => {},
    (phrase) => speech.push(phrase.text),
    undefined,
    (item) => metadata.push(item),
  );
  const raw = JSON.stringify([
    { phrase: 'Let us go.', emotion: 'happy', gestures: [], conversationProgress: update },
    {
      phrase: 'I would like something warm.',
      emotion: 'neutral',
      gestures: [],
      conversationProgress: { ...update, topic: 'ignored' },
    },
  ]);
  for (const character of raw) parser.write(character);
  parser.finish();
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].conversationProgress.topic, 'dessert');
  assert.deepEqual(speech, ['Let us go.', 'I would like something warm.']);
  const session = new Session();
  session.progress.collect(update, '', 'Let us go.');
  for (let index = 0; index < 2; index++)
    session.progress.collect({ ...update, kind: 'repeat' }, '', 'Let us go.');
  const history = [
    { role: 'user' as const, content: 'Hi.' },
    { role: 'assistant' as const, content: 'Hello.' },
    { role: 'user' as const, content: 'What now?' },
  ];
  for (const messages of [
    buildReplyMessages(history, 'yue', {
      memoryContext: session.conversationContext(''),
      progressGuidance: session.progress.guidance(),
    }),
    buildDraftMessages(history, 'yue', {
      memoryContext: session.conversationContext(''),
      progressGuidance: session.progress.guidance(),
      format: 'phrases',
    }),
  ]) {
    assert.match(messages.at(-1)!.content, /CONVERSATION PROGRESS/);
    assert.match(messages.at(-1)!.content, /10–20 Chinese characters/);
    assert.match(messages.at(-1)!.content, /30–60 Chinese characters/);
    assert.match(messages.at(-1)!.content, /Explain more when a real question/);
    assert.match(messages.at(-1)!.content, /Do not renew, embellish or joke/);
    const body = messages.at(-1)!.content;
    if (body.includes('Valid example:'))
      assert.ok(body.indexOf('CURRENT CONTENT PRIORITY') > body.indexOf('Valid example:'));
  }
});
