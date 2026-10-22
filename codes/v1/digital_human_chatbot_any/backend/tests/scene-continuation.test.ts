import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { SceneSnapshot, SceneStep } from '@digital-human/shared';
import { VirtualScene } from '../src/scenes/VirtualScene.js';
import { prepareScene } from '../src/scenes/prepareScene.js';
import { Session } from '../src/sessions.js';
import { readConfig } from '../src/config.js';
import { createApplication } from '../src/app.js';
import {
  buildReplyMessages,
  buildDraftMessages,
  type ChatMessage,
} from '../src/llm/requestMessages.js';

const report = JSON.parse(
  await readFile(new URL('./fixtures/cantonese-restaurant-arrival.json', import.meta.url), 'utf8'),
);
const arrival: SceneSnapshot = report.scene;
const history: ChatMessage[] = [];
for (const message of report.messages) {
  if (message.role === 'scene') continue;
  const previous = history.at(-1);
  if (previous?.role === message.role) previous.content += ` ${message.text}`;
  else
    history.push({
      role: message.role,
      content: message.text,
      ...(message.generated ? { generated: true } : {}),
    });
}
const step = (index: number): SceneStep => ({
  location: '中環意大利餐廳',
  activity: `品嚐交流 ${index}`,
  narration: `兩人留喺餐廳分享第 ${index} 個新話題。`,
  leader: 'together',
});

test('the reported arrival gets a late current-activity anchor for Mira and both automatic user formats, without changing spoken history', () => {
  const original = structuredClone(history);
  for (const recoveryStage of [undefined, 'related', 'fresh'] as const) {
    const options = {
      scene: arrival,
      virtualScenesEnabled: true,
      naturalVariation: true,
      recoveryStage,
    };
    for (const messages of [
      buildReplyMessages(history.slice(0, -1), 'yue', options),
      buildReplyMessages(history, 'yue', { ...options, proactive: true }),
      buildDraftMessages(history, 'yue', options),
      buildDraftMessages(history, 'yue', { ...options, format: 'phrases' }),
    ]) {
      const request = messages.at(-1)!.content;
      assert.match(messages[0].content, /CURRENT FICTIONAL PHYSICAL STATE/);
      assert.match(messages[0].content, /Activity already underway: "用餐及飲嘢"/);
      assert.match(request, /CURRENT SCENE — TIME AND LOCATION FOR THIS REPLY/);
      assert.match(request, /中環意大利餐廳/);
      assert.match(request, /Speak from this location, doing this activity NOW/);
      assert.ok(
        request.indexOf('CURRENT SCENE — TIME') > request.indexOf('Authoritative scene state'),
      );
      assert.match(request, /does not mean someone must keep giving directions/);
      assert.match(request, /gently acknowledge the current setting/);
    }
  }
  assert.deepEqual(history, original);
  assert.ok(
    !JSON.stringify(
      buildDraftMessages(history, 'yue', { scene: arrival, virtualScenesEnabled: false }),
    ).includes('CURRENT SCENE — TIME'),
  );
});

test('a legacy two-card outing continues beyond six cards with stable IDs and bounded same-venue planning, including save/restore', () => {
  let scene = new VirtualScene();
  scene.restore({ ...arrival, active: { ...arrival.active!, completedTurns: 2 } });
  const ids = new Set([scene.currentStep()!.id]);
  for (let index = 0; index < 7; index++) {
    const before = scene.snapshot().active!;
    assert.ok(scene.needsContinuation());
    assert.equal(
      scene.continue(before.plan.id, (before.stepOffset ?? 0) + before.stepIndex, [step(index)]),
      true,
    );
    assert.ok(
      ids.has(scene.currentStep()!.id),
      'compacting the plan must not rename the existing card',
    );
    const next = scene.beginTurn()!;
    assert.equal(next.index, index + 2);
    assert.ok(!ids.has(next.id));
    ids.add(next.id);
    assert.equal(scene.snapshot().active!.plan.steps.length, 2);
    scene.completeTurn(scene.snapshot().version);
    scene.completeTurn(scene.snapshot().version);
    if (index === 3) {
      const restored = new VirtualScene();
      restored.restore(JSON.parse(JSON.stringify(scene.snapshot())));
      assert.equal(restored.currentStep()!.id, next.id);
      scene = restored;
    }
  }
  assert.equal(ids.size, 8);
  const active = scene.snapshot().active!;
  const afterStep = (active.stepOffset ?? 0) + active.stepIndex;
  assert.equal(
    scene.continue(active.plan.id, afterStep, [{ ...step(10), location: '另一間餐廳' }]),
    false,
  );
  assert.equal(
    scene.continue(active.plan.id, afterStep, [active.plan.steps[active.stepIndex]]),
    false,
  );
  assert.equal(scene.continue(active.plan.id, afterStep - 1, [step(10)]), false);
  assert.equal(scene.continue('stale-plan', afterStep, [step(10)]), false);
});

test('cancelled continuation cannot emit a late card; empty or invalid continuations stay here and retry only after further completed replies', async () => {
  const events: any[] = [];
  const session = new Session((event) => events.push(event));
  session.scene.restore({ ...arrival, active: { ...arrival.active!, completedTurns: 2 } });
  const original = session.scene.snapshot();
  const controller = new AbortController();
  let release!: (steps: SceneStep[]) => void;
  const pending = prepareScene(
    readConfig(),
    session,
    controller.signal,
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  controller.abort();
  release([step(1)]);
  await pending;
  assert.deepEqual(session.scene.snapshot(), original);
  assert.equal(events.length, 0);
  await prepareScene(readConfig(), session, new AbortController().signal, async () => []);
  assert.equal(session.scene.needsContinuation(), false);
  session.scene.completeTurn(session.scene.snapshot().version);
  assert.equal(session.scene.needsContinuation(), false);
  session.scene.completeTurn(session.scene.snapshot().version);
  assert.equal(session.scene.needsContinuation(), true);
});

test('text and spoken automatic replies advance the scene before drafting, and terminal plans gain another same-venue card', async () => {
  const requests: any[] = [];
  const order: string[] = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part.toString();
    const request = JSON.parse(body);
    requests.push(request);
    const continuing = request.messages[0].content.startsWith('Plan small fictional');
    order.push(continuing ? 'continuation' : 'draft');
    const content = continuing
      ? { steps: [step(1), { ...step(2), narration: undefined, narnation: 'Typo from the model' }] }
      : request.messages[0].content.includes('phrases key')
        ? { phrases: ['坐低先。', '你覺得意粉點呀？'] }
        : { draft: '坐低先，你覺得意粉點呀？' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scene-actors-'));
  const config = {
    ...readConfig({
      LLM_MODEL_NAME: 'fake',
      LLM_STREAM: 'false',
      LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    }),
    mediaDir: dir,
  };
  const app = await createApplication(config);
  const server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const kind of ['text', 'spoken', 'continuation'] as const) {
      requests.length = order.length = 0;
      const session = new Session((event) => {
        if (event.type === 'scene.step') order.push('card');
      });
      session.history = structuredClone(history);
      session.scene.restore({
        ...arrival,
        active: {
          ...arrival.active!,
          stepIndex: kind === 'continuation' ? 1 : 0,
          completedTurns: 2,
        },
      });
      app.sessions.set(session.id, session);
      const endpoint = kind === 'text' ? 'suggest-reply' : 'user-message/prepare';
      const response = await fetch(`${base}/api/sessions/${session.id}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: 0,
          language: 'yue',
          virtualScenesEnabled: true,
          kind: 'automatic',
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        order,
        kind === 'continuation' ? ['continuation', 'card', 'draft'] : ['card', 'draft'],
      );
      assert.equal(session.scene.currentStep()!.index, kind === 'continuation' ? 2 : 1);
      assert.match(requests.at(-1).messages.at(-1).content, /Current location: "中環意大利餐廳"/);
      assert.match(requests.at(-1).messages.at(-1).content, /CURRENT SCENE — TIME/);
      assert.equal(session.scene.snapshot().active!.completedTurns, 0);
      if (kind === 'continuation') {
        assert.equal(session.scene.snapshot().active!.plan.steps.length, 2);
        assert.match(requests[0].messages[0].content, /CURRENT FICTIONAL PHYSICAL STATE/);
        assert.match(requests[0].messages[0].content, /do NOT return to arriving/);
      }
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});
