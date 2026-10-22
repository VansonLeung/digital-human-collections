import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedReply } from '../src/llm/repetition.js';
import {
  buildReplyMessages,
  buildDraftMessages,
  type ChatMessage,
} from '../src/llm/requestMessages.js';

test('repeat matching catches copied and almost copied turns across speakers without blocking brief confirmations or distinct answers', () => {
  const line =
    '仆街，你個腦真係幾執著㗎，食個糖水都要驗証。跟住啦，柒頭帶路，唔好走丟。到時食完再同你計，我唔係特登幫你㗎，係我自己想食。';
  for (const role of ['user', 'assistant'] as const) {
    assert.equal(repeatedReply(line, [{ role, content: line }])?.score, 1);
    assert.ok(repeatedReply(line.replace('仆街，', '柒頭，'), [{ role, content: line }]));
  }
  assert.equal(
    repeatedReply('Yes, please.', [{ role: 'user', content: 'Yes, please.' }]),
    undefined,
  );
  assert.equal(
    repeatedReply('The dessert has arrived. I would like to try a little first.', [
      { role: 'assistant', content: line },
    ]),
    undefined,
  );
  const english = 'Let us keep walking and discuss how the same dessert tastes when we get there.';
  assert.equal(
    repeatedReply(english.toUpperCase() + '!!!', [{ role: 'assistant', content: english }])?.score,
    1,
  );
});

test('recycled Cantonese passages from both speakers are caught even when remixed into a different turn', () => {
  const history: ChatMessage[] = [
    {
      role: 'user',
      generated: true,
      content:
        '嘩，柒頭，你個心機真係大過天㗎，行山都要人教呼吸？不過講真，你肯試就係好事。記住我講嘅重心放低，唔好成日諗住甩開我，到時你爬唔攞氣唔好搵我呀。下次行山，我哋就真係試下邊個先「落地」啦。',
    },
    {
      role: 'assistant',
      content:
        '仆街，柒頭，你個嘴真係毒到極，仲夾埋威脅？我爬唔攞氣都係我事，關你咩事呀？不過既然你咁有信心教我，我都會盡力跟住你個節奏啦。到時真係行唔切，你可唔好笑我太廢啊。',
    },
  ];
  const remix =
    '柒頭，你個嘴真係毒到極，仲夾埋威脅？不過講真，你肯試就係好事。記住我講嘅重心放低，唔好成日諗住甩開我，到時你爬唔攞氣唔好搵我呀。下次行山，我哋就真係試下邊個先「落地」啦。';
  assert.ok(repeatedReply(remix, history));
  assert.equal(
    repeatedReply('我知你想輕鬆啲。其實行山唔使鬥快，揀條平路慢慢行都可以。', history),
    undefined,
  );
  assert.equal(
    repeatedReply('我叫小明。你可以叫我小明。', [{ role: 'user', content: '我叫小明。' }]),
    undefined,
  );
});

test('English recycled passages are detected even when taken from different turns', () => {
  const first = 'We should take the quiet path past the trees.';
  const second = 'Then we can order that exact same dessert again.';
  const history: ChatMessage[] = [
    { role: 'assistant', content: `${first} I like the view from here.` },
    { role: 'user', generated: true, content: `I can follow the path. ${second}` },
  ];
  assert.equal(repeatedReply(`${second} ${first}`, history)?.passages, 2);
});

test('recovery shortens request context without changing history, preserves private ownership and replaces topic-preservation pressure', () => {
  const loop =
    'We will keep following this exact same path and discussing the same dessert tomorrow.';
  const history: ChatMessage[] = [
    { role: 'user', content: 'Can you speak Cantonese?' },
    { role: 'assistant', content: 'Yes, I can speak Cantonese.' },
    { role: 'user', generated: true, content: 'We could try a short walk.' },
    { role: 'assistant', content: loop },
    { role: 'user', generated: true, content: loop },
    { role: 'assistant', content: loop },
    { role: 'user', generated: true, content: loop },
  ];
  const original = structuredClone(history);
  for (const stage of ['related', 'fresh'] as const) {
    for (const messages of [
      buildReplyMessages(history, 'yue', { recoveryStage: stage, aboutMe: 'My name is Ming.' }),
      buildDraftMessages(history, 'yue', { recoveryStage: stage, aboutMe: 'My name is Ming.' }),
      buildDraftMessages(history, 'yue', { recoveryStage: stage, format: 'phrases' }),
    ]) {
      const text = JSON.stringify(messages);
      assert.match(text, stage === 'related' ? /RELATED ANGLE/ : /FRESH TOPIC/);
      assert.ok(!text.includes('Conversation focus: answer_latest_question'));
      assert.ok(
        !text.includes('Stay on the current topic; fresh wording does not require a topic change'),
      );
      assert.ok(!text.includes('a little seductive'));
      assert.ok(text.split(loop).length - 1 <= 1);
      assert.match(text, /Do not invent facts about the user/);
      assert.match(text, /JSON/);
      assert.match(text, /Cantonese/);
    }
  }
  const fresh = buildReplyMessages(history, 'yue', {
    recoveryStage: 'fresh',
    aboutMe: 'My name is Ming.',
  });
  assert.doesNotMatch(JSON.stringify(fresh), /My name is Ming/);
  assert.match(
    JSON.stringify(
      buildDraftMessages(history, 'yue', { recoveryStage: 'fresh', aboutMe: 'My name is Ming.' }),
    ),
    /My name is Ming/,
  );
  assert.ok(!JSON.stringify(fresh).includes(loop));
  assert.deepEqual(history, original);
});
