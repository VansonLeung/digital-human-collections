import test from 'node:test';
import assert from 'node:assert/strict';
import { turnGuidance } from '../src/llm/turnGuidance.js';
import {
  buildDraftMessages,
  buildReplyMessages,
  type ChatMessage,
} from '../src/llm/requestMessages.js';

test('style variation never replaces answering the latest question or changes output contracts', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'What do you like about rainy days?' },
    { role: 'assistant', content: 'They are peaceful. What do you like about them?' },
  ];
  const original = structuredClone(history);
  const styles = new Set<string>();
  for (const sample of [0, 0.7, 0.83, 0.92, 0.98]) {
    const random = () => sample;
    const draft = buildDraftMessages(history, 'yue', { random });
    const reply = buildReplyMessages(
      [...history, { role: 'user', content: 'Can you explain more?' }],
      'yue',
      { random },
    );
    for (const messages of [draft, reply]) {
      const content = messages.at(-1)!.content;
      styles.add(content.match(/Optional style: (\w+)\./)![1]);
      assert.match(content, /Conversation focus: answer_latest_question/);
      assert.match(
        content,
        /Continue the current topic while anything important remains unanswered/,
      );
      assert.match(content, /style cue is secondary to relevance, answering the question/);
      assert.match(content, /colloquial Hong Kong Cantonese/);
      assert.equal(content.match(/CURRENT TURN GUIDANCE/g)?.length, 1);
    }
    assert.match(draft.at(-1)!.content, /from the user's perspective to Mira's latest message/);
    assert.ok(draft.at(-1)!.content.endsWith('Do not include any text outside the object.'));
    assert.ok(reply.at(-1)!.content.endsWith('Do not include any text outside the array.'));
  }
  assert.deepEqual([...styles], ['natural', 'warm', 'coy', 'playful', 'straightforward']);
  assert.deepEqual(history, original);
});

test('repeat cues detect recent English and Cantonese questions from the counterpart only', () => {
  for (const question of ['What do you mean?', '你鍾意落雨嘅邊一點？']) {
    const history: ChatMessage[] = [
      { role: 'assistant', content: question },
      { role: 'user', content: 'The quiet atmosphere.' },
      { role: 'assistant', content: question },
    ];
    const draft = turnGuidance(history, 'draft', () => 0);
    assert.match(draft, /Repeated question cue: an exact question recurs/);
    assert.match(draft, /if it was already answered/);
    assert.match(draft, /Still address any unanswered or new part/);
    assert.match(
      turnGuidance(history, 'reply', () => 0),
      /Repeated question cue: no exact repeat detected/,
    );
    // A repeated statement is not a repeated question, and a new question is
    // not classified as a repeat just because the topic has lasted many turns.
    assert.match(
      turnGuidance(
        history.map((message) => ({ ...message, content: 'Same topic.' })),
        'draft',
        () => 0,
      ),
      /no exact repeat detected/,
    );
    assert.match(
      turnGuidance(
        [...history, { role: 'user', content: 'Why is it peaceful?' }],
        'reply',
        () => 0,
      ),
      /no exact repeat detected/,
    );
  }
});

test('proactive guidance checks pending questions instead of treating silence as topic closure', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'Tell me about rain.' },
    { role: 'assistant', content: 'Do you enjoy rainy days?' },
  ];
  const messages = buildReplyMessages(history, 'en', { proactive: true, random: () => 0.83 });
  const content = messages.at(-1)!.content;
  assert.match(content, /Turn kind: proactive/);
  assert.match(content, /Conversation focus: check_pending_questions/);
  assert.match(content, /silence does not mean the topic is finished/);
  assert.match(content, /If Mira is waiting for an answer, do not ask the same question again/);
  assert.deepEqual(messages.slice(1, -1), history);
  assert.match(content, /Optional style: coy/);
  assert.ok(content.endsWith('Do not include any text outside the array.'));
});

test('request guidance uses only the provided recent history and preserves unpunctuated requests', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'How are you?' },
    ...Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `Recent statement ${index}.`,
    })),
    { role: 'assistant', content: 'How are you?' },
  ];
  const content = buildDraftMessages(history, 'en', { random: () => 0 }).at(-1)!.content;
  assert.match(content, /no exact repeat detected/);
  assert.match(
    turnGuidance([{ role: 'user', content: 'Please explain this' }], 'reply', () => 0),
    /latest question or request first/,
  );
  assert.match(
    turnGuidance([], 'draft', () => 0),
    /Optional style: natural/,
  );
});
