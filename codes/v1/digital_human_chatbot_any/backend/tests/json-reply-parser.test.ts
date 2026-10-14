import test from 'node:test';
import assert from 'node:assert/strict';
import { llmReplySchema, replyLimits, type SpeechPhrase } from '@digital-human/shared';
import { JsonReplyParser, ReplyFormatError } from '../src/llm/JsonReplyParser.js';

function fixture() {
  const phrases: SpeechPhrase[] = [];
  const deltas: string[] = [];
  const parser = new JsonReplyParser(
    (text) => deltas.push(text),
    (phrase) => phrases.push(phrase),
  );
  return { parser, phrases, deltas };
}

test('JSON phrases stream once across every chunk width, including escaped strings and nested controls', () => {
  const wire = [
    {
      phrase: '你好！佢話："{a} [b]"，路徑係 C:\\test。',
      emotion: 'happy',
      gestures: [{ name: 'wave', strength: 0.4 }],
    },
    { phrase: '八爪魚有八條腕。', emotion: 'thoughtful', gestures: [] },
  ];
  const raw = `Here is the reply:\n\`\`\`json\n${JSON.stringify(wire)}\n\`\`\``;
  for (let width = 1; width <= raw.length; width++) {
    const { parser, phrases, deltas } = fixture();
    for (let start = 0; start < raw.length; start += width)
      parser.write(raw.slice(start, start + width));
    assert.equal(parser.finish(), wire.map((item) => item.phrase).join(' '));
    assert.equal(deltas.join(''), wire.map((item) => item.phrase).join(' '));
    assert.deepEqual(
      phrases,
      wire.map(({ phrase, emotion, gestures }) => ({
        text: phrase,
        performance: { emotion, gestures },
      })),
    );
  }
});

test('speech waits for the entire object, including all emotion and gesture metadata', () => {
  const { parser, phrases } = fixture();
  parser.write('[{"phrase":"Hello!","emotion":"sad","gestures":[{"name":"nod","strength":');
  assert.equal(phrases.length, 0);
  parser.write('0.3}]}');
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].performance.emotion, 'sad');
  parser.write(']');
  assert.equal(parser.finish(), 'Hello!');
  assert.equal(phrases.length, 1);
});

test('closed malformed objects are repaired and then validated', () => {
  const { parser, phrases } = fixture();
  parser.write(
    "[{phrase: 'Really?', emotion: 'surprise', gestures: [{name:'nod', strength:0.3,}],}, {phrase:'Okay.',emotion:'normal',gestures:[],}]",
  );
  assert.equal(parser.finish(), 'Really? Okay.');
  assert.deepEqual(
    phrases.map((phrase) => phrase.performance),
    [
      { emotion: 'surprised', gestures: [{ name: 'nod', strength: 0.3 }] },
      { emotion: 'neutral', gestures: [] },
    ],
  );
});

test('invalid metadata recovers only the phrase, with neutral delivery and no gestures', () => {
  for (const metadata of [
    { emotion: 'furious', gestures: [{ name: 'wave', strength: 0.3 }] },
    { emotion: 'happy', gestures: [{ name: 'run_shell', strength: 0.3 }] },
    { emotion: 'happy', gestures: [{ name: 'wave', strength: 3 }] },
    { emotion: 'happy', gestures: [{ name: 'wave', strength: '0.3' }] },
    { emotion: 'happy', gestures: [{ name: 'wave' }] },
    { emotion: 'happy', gestures: [], extra: 'not part of the protocol' },
    {},
  ]) {
    const { parser, phrases } = fixture();
    parser.write(JSON.stringify([{ phrase: 'Usable speech.', ...metadata }]));
    assert.equal(parser.finish(), 'Usable speech.');
    assert.deepEqual(phrases[0].performance, { emotion: 'neutral', gestures: [] });
  }
});

test('an intact phrase is recoverable even when the remaining syntax cannot be repaired', () => {
  const { parser, phrases } = fixture();
  parser.write('[{"phrase":"Keep this sentence.","emotion":???}]');
  assert.equal(parser.finish(), 'Keep this sentence.');
  assert.deepEqual(phrases[0].performance, { emotion: 'neutral', gestures: [] });
});

test('unfinished speech is never completed by repair; prior complete objects remain usable', () => {
  for (const tail of [
    '{"phrase":"Invented ending',
    '{"phrase":"Completed text","emotion":"happy"',
    '',
  ]) {
    const { parser, phrases } = fixture();
    parser.write('[{"phrase":"Keep this.","emotion":"sad","gestures":[]},' + tail);
    assert.equal(parser.finish(), 'Keep this.');
    assert.equal(phrases.length, 1);
  }
  const { parser, phrases } = fixture();
  parser.write('[{"phrase":"No complete object yet","emotion":"happy","gestures":[]');
  assert.throws(() => parser.finish(), ReplyFormatError);
  assert.equal(phrases.length, 0);
});

test('plain prose, empty arrays and invalid phrase values produce an error instead of raw speech', () => {
  for (const raw of [
    'Hello there.',
    '[]',
    '[{"emotion":"happy","gestures":[]}]',
    '[{"phrase":42}]',
    '[{"phrase":"  "}]',
    '[{"phrase":"' + 'x'.repeat(601) + '"}]',
    '[{"phrase":{"phrase":"nested text"}}]',
  ]) {
    const { parser, phrases, deltas } = fixture();
    assert.throws(() => {
      parser.write(raw);
      parser.finish();
    }, ReplyFormatError);
    assert.deepEqual(phrases, []);
    assert.deepEqual(deltas, []);
  }
});

test('size, nesting and phrase-count limits apply even without speech playback', () => {
  assert.throws(
    () => fixture().parser.write('x'.repeat(replyLimits.characters + 1)),
    ReplyFormatError,
  );
  assert.throws(
    () => fixture().parser.write('[{' + '"nested":{'.repeat(replyLimits.depth)),
    ReplyFormatError,
  );
  const raw = JSON.stringify(
    Array.from({ length: 33 }, () => ({ phrase: 'Short.', emotion: 'neutral', gestures: [] })),
  );
  const { parser, phrases } = fixture();
  assert.throws(() => parser.write(raw), ReplyFormatError);
  assert.equal(phrases.length, 32);
  assert.equal(llmReplySchema.safeParse(JSON.parse(raw)).success, false);
});
