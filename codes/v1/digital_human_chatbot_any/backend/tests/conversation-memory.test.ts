import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationMemory } from '../src/conversation/ConversationMemory.js';
import { TurnDirector } from '../src/conversation/TurnDirector.js';
import { Session } from '../src/sessions.js';
import { JsonReplyParser } from '../src/llm/JsonReplyParser.js';
import { buildReplyMessages, buildDraftMessages } from '../src/llm/requestMessages.js';
import type { MemoryCandidate } from '@digital-human/shared';

const userFact: MemoryCandidate = {
  owner: 'user',
  category: 'interests',
  key: 'hiking',
  value: 'Enjoys hiking.',
  quote: 'I enjoy hiking.',
};
const miraFact: MemoryCandidate = {
  owner: 'mira',
  category: 'preferences',
  key: 'drink',
  value: 'Likes tea.',
  quote: 'I prefer tea.',
};

test('session memory requires exact evidence from the right speaker; generated user claims cannot establish facts', () => {
  const memory = new ConversationMemory();
  assert.equal(
    memory.collect([userFact], { turnId: 'auto', manualText: '', reply: 'I enjoy hiking.' }),
    false,
  );
  assert.equal(
    memory.collect([miraFact], { turnId: 'manual', manualText: 'I prefer tea.', reply: 'Hello.' }),
    false,
  );
  assert.equal(
    memory.collect([userFact, miraFact], {
      turnId: 'real',
      manualText: 'I enjoy hiking.',
      reply: 'I prefer tea.',
    }),
    true,
  );
  assert.deepEqual(
    memory.snapshot().map((item) => item.source),
    ['manual_message', 'mira_fiction'],
  );
  assert.equal(
    memory.collect([userFact, miraFact], {
      turnId: 'duplicate',
      manualText: 'I enjoy hiking.',
      reply: 'I prefer tea.',
    }),
    false,
  );
  assert.equal(memory.snapshot().length, 2);
  assert.match(memory.context('hiking'), /I enjoy hiking/);
  assert.match(memory.context('tea'), /Likes tea/);
  const copy = memory.snapshot();
  copy[0].value = 'mutated';
  assert.equal(memory.snapshot()[0].value, 'I enjoy hiking.');
});

test('memory edits supersede extraction, stale/busy edits are rejected, reset clears memory and events never contain dialogue history wrappers', () => {
  const events: any[] = [];
  const session = new Session((event) => events.push(event));
  session.memory.collect([miraFact], { turnId: 'first', manualText: '', reply: 'I prefer tea.' });
  const id = session.memory.snapshot()[0].id;
  assert.equal(
    session.editMemory({ type: 'memory.edit', id, value: 'Likes coffee now.', revision: 1 }),
    false,
  );
  assert.equal(
    session.editMemory({ type: 'memory.edit', id, value: 'Likes coffee now.', revision: 0 }),
    true,
  );
  session.memory.collect([miraFact], { turnId: 'later', manualText: '', reply: 'I prefer tea.' });
  assert.equal(session.memory.snapshot()[0].value, 'Likes coffee now.');
  assert.equal(session.memory.snapshot()[0].source, 'manual_edit');
  assert.equal(session.editMemory({ type: 'memory.forget', id, revision: session.revision }), true);
  assert.deepEqual(session.memory.snapshot(), []);
  session.memory.collect([miraFact], { turnId: 'again', manualText: '', reply: 'I prefer tea.' });
  session.reset();
  assert.deepEqual(session.memory.snapshot(), []);
  assert.deepEqual(new Session().memory.snapshot(), []);
  assert.ok(events.some((event) => event.type === 'memory.state' && event.memories.length === 0));
});

test('memory survives the twelve-message history window but stays bounded and quotes are never sent to TTS', () => {
  const memory = new ConversationMemory();
  for (let index = 0; index < 60; index++)
    memory.collect(
      [
        {
          ...miraFact,
          key: `taste-${index}`,
          value: `Preference number ${index}`,
          quote: `Choice ${index}`,
        },
      ],
      { turnId: `${index}`, manualText: '', reply: `Choice ${index}` },
    );
  assert.equal(memory.snapshot().length, 48);
  const metadata: any[] = [];
  const spoken: string[] = [];
  const parser = new JsonReplyParser(
    () => {},
    (phrase) => spoken.push(phrase.text),
    undefined,
    (item) => metadata.push(item),
  );
  const raw = JSON.stringify([
    { phrase: 'I prefer tea.', emotion: 'happy', gestures: [], memories: [miraFact] },
    { phrase: 'How about you?', emotion: 'thoughtful', gestures: [], memories: [userFact] },
  ]);
  for (const character of raw) parser.write(character);
  parser.finish();
  assert.deepEqual(spoken, ['I prefer tea.', 'How about you?']);
  assert.deepEqual(metadata, [{ memories: [miraFact] }]);
});

test('natural variation changes delivery independently per speaker, avoids repeated tones and permits concise replies without changing facts or JSON contracts', () => {
  const director = new TurnDirector();
  const plans = Array.from({ length: 8 }, () => director.next('mira', () => 0.05));
  for (let index = 2; index < plans.length; index++) {
    assert.notEqual(plans[index].tone, plans[index - 1].tone);
    assert.notEqual(plans[index].tone, plans[index - 2].tone);
    assert.notEqual(plans[index].contribution, plans[index - 1].contribution);
  }
  assert.equal(director.next('user', () => 0.05).tone, plans[0].tone);
  director.reset();
  assert.deepEqual(
    director.next('mira', () => 0.05),
    plans[0],
  );
  const history = [{ role: 'user' as const, content: 'Tell me what you like.' }];
  const opts = {
    naturalVariation: true,
    getToKnowEachOther: true,
    delivery: plans[0],
    memoryContext: 'KNOWN FACT: user prefers quiet evenings.',
  };
  for (const messages of [
    buildReplyMessages(history, 'yue', opts),
    buildDraftMessages(history, 'yue', { ...opts, format: 'phrases' }),
  ]) {
    const content = messages.at(-1)!.content;
    assert.match(content, /NATURAL VARIATION/);
    assert.match(content, /occasional short turn/);
    assert.match(content, /Optional style: plain/);
    assert.match(content, /KNOWN FACT: user prefers quiet evenings/);
    assert.match(content, /CONVERSATION FOCUS: GET TO KNOW/);
    assert.match(content, /not pay|need not pay/);
    assert.ok(!content.includes('make your delivery a little seductive'));
  }
  const reply = buildReplyMessages(history, 'yue', opts);
  assert.match(reply.at(-1)!.content, /Use one phrase object/);
  assert.ok(reply.at(-1)!.content.endsWith('Do not include any text outside the array.'));
});

test('natural variation normally requests separate spoken phrases and spaces out short turns', () => {
  const director = new TurnDirector();
  const lengths = Array.from({ length: 7 }, () => director.next('mira', () => 0.05).length);
  assert.deepEqual(lengths, ['brief', 'normal', 'normal', 'brief', 'normal', 'normal', 'brief']);
  assert.equal(director.next('user', () => 0.05).length, 'brief');

  const sampled = Array.from(
    { length: 100 },
    (_, index) => new TurnDirector().next('mira', () => (index + 0.5) / 100).length,
  );
  assert.equal(sampled.filter((length) => length === 'brief').length, 10);
  assert.equal(sampled.filter((length) => length === 'normal').length, 80);
  assert.equal(sampled.filter((length) => length === 'fuller').length, 10);

  const history = [{ role: 'user' as const, content: 'Tell me what you think.' }];
  for (const [roll, expected] of [
    [0.5, /Use two to four separate phrase objects/],
    [0.95, /Use three to six separate phrase objects/],
  ] as const) {
    const content = buildReplyMessages(history, 'yue', {
      conversationalPhrases: true,
      naturalVariation: true,
      delivery: new TurnDirector().next('mira', () => roll),
    }).at(-1)!.content;
    assert.match(content, expected);
    assert.match(content, /Do not pack the whole reply or multiple sentences into a single phrase/);
    assert.match(content, /user request for a very short answer takes precedence/);
    assert.doesNotMatch(content, /Use one phrase object/);
    const example = JSON.parse(content.split('Valid example:\n')[1].split('\n')[0]);
    assert.ok(example.length > 1, 'the format example must also demonstrate separate phrases');
  }
});

test('explicit Mira preferences survive omitted metadata without inferring user facts or retaining echoed counterpart claims', () => {
  const memory = new ConversationMemory();
  memory.collect([], { turnId: 'own', manualText: '', reply: '我鍾意飲咖啡，特別係熱美式。' });
  assert.equal(memory.snapshot()[0].owner, 'mira');
  assert.equal(memory.snapshot()[0].quote, '我鍾意飲咖啡');
  assert.equal(memory.snapshot()[0].source, 'mira_fiction');
  memory.reset();
  for (const reply of [
    '如果我鍾意飲茶嘅話，就會試吓。',
    '你話我鍾意咖啡？',
    'I like you.',
    'I like tea?',
  ])
    memory.collect([], { turnId: 'skip', manualText: '', reply });
  assert.deepEqual(memory.snapshot(), []);
  memory.collect([], {
    turnId: 'echo',
    manualText: '',
    counterpartText: '我鍾意飲咖啡',
    reply: '我鍾意飲咖啡。',
  });
  assert.deepEqual(memory.snapshot(), []);
});

test('virtual invitations and questions cannot establish interests, and user memory keeps the actual statement instead of a model inference', () => {
  const memory = new ConversationMemory();
  memory.collect(
    [
      {
        owner: 'user',
        category: 'interests',
        key: 'reading',
        value: 'Loves reading',
        quote: '不如依家一齊去附近間書店睇書',
      },
    ],
    {
      turnId: 'invitation',
      manualText: '不如依家一齊去附近間書店睇書，你去唔去？',
      reply: '好呀。',
    },
  );
  assert.deepEqual(memory.snapshot(), []);
  memory.collect(
    [
      {
        owner: 'user',
        category: 'skills',
        key: 'expertise',
        value: 'Is a programming expert',
        quote: '我想學寫程式',
      },
    ],
    { turnId: 'goal', manualText: '我想學寫程式', reply: '可以呀。' },
  );
  assert.equal(memory.snapshot()[0].value, '我想學寫程式');
});
