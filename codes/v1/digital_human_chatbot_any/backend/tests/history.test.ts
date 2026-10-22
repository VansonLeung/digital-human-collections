import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appRoot } from '../src/config.js';
import { savedConversationSchema, type ScenePlan, type ServerEvent } from '@digital-human/shared';
import { ConversationStore, ConversationConflict } from '../src/history/ConversationStore.js';
import { Session } from '../src/sessions.js';
import { readConfig } from '../src/config.js';
import { createApplication } from '../src/app.js';
import { runTurn, type Services } from '../src/pipeline.js';
import { buildReplyMessages, buildDraftMessages } from '../src/llm/requestMessages.js';

const settings = {
  personaId: 'sample',
  language: 'en' as const,
  displayMode: 'phrases' as const,
  aboutMe: 'USER_PRIVATE_41: I collect maps.',
  miraBehavior: 'MIRA_PRIVATE_63: likes apricot tea.',
  virtualScenesEnabled: true,
};
const plan: ScenePlan = {
  title: 'Bookshop visit',
  steps: [
    {
      location: 'Bookshop',
      activity: 'Browse',
      narration: 'They browse the shelves.',
      leader: 'together',
    },
    {
      location: 'Reading table',
      activity: 'Read',
      narration: 'They read at a quiet table.',
      leader: 'together',
    },
  ],
};
const complete = (session: Session, text = 'Hello.', generated = false) => {
  session.archive.complete({
    id: randomUUID(),
    input: text,
    generated,
    text: 'Nice to meet you.',
    phrases: ['Nice to meet you.'],
    personaName: 'Mira',
    settings,
  });
};

test('conversation files are atomic, survive new store instances, reject stale writes and keep damaged files from hiding valid history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'history-store-'));
  try {
    const store = new ConversationStore(dir);
    const session = new Session();
    complete(session);
    const initial = session.archive.snapshot()!;
    const saved = await store.save(initial, 0);
    assert.equal(saved.version, 1);
    assert.equal((await new ConversationStore(dir).get(saved.id))!.messages.length, 2);
    const competing = await Promise.allSettled([
      store.save({ ...saved, title: 'One writer' }, 1),
      store.save({ ...saved, title: 'Stale writer' }, 1),
    ]);
    assert.equal(competing[0].status, 'fulfilled');
    assert.equal(competing[1].status, 'rejected');
    if (competing[1].status === 'rejected')
      assert.ok(competing[1].reason instanceof ConversationConflict);
    assert.equal((await store.get(saved.id))!.title, 'One writer');
    await writeFile(path.join(dir, `${randomUUID()}.json`), '{broken');
    assert.equal((await store.list()).length, 1);
    assert.equal(await store.get('../private'), undefined);
    assert.equal(await store.get(randomUUID()), undefined);
    assert.ok((await readdir(dir)).every((name) => name.endsWith('.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('full transcripts retain phrase boundaries, generated-user provenance and learned state beyond the model window', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'history-roundtrip-'));
  const events: ServerEvent[] = [];
  const session = new Session((event) => events.push(event));
  const store = new ConversationStore(dir);
  session.archive.store = store;
  try {
    session.configureScenes(true);
    session.memory.collect(
      [
        {
          owner: 'mira',
          category: 'preferences',
          key: 'drink',
          value: 'Likes tea.',
          quote: 'I prefer tea.',
        },
      ],
      { turnId: 'spoken', manualText: '', reply: 'I prefer tea.' },
    );
    session.progress.collect(
      {
        topic: 'reading',
        angle: 'fiction',
        kind: 'detail',
        summary: 'Reading fiction',
        quote: 'I enjoy fiction.',
      },
      'I enjoy fiction.',
      'Tell me more.',
    );
    session.reactions.complete(true);
    for (let index = 0; index < 8; index++) {
      session.archive.complete({
        id: randomUUID(),
        input: `Message ${index}. Another thought.`,
        userPhrases: [`Message ${index}.`, 'Another thought.'],
        generated: index === 0,
        text: `Reply ${index}. A second phrase.`,
        phrases: [`Reply ${index}.`, 'A second phrase.'],
        personaName: 'Mira',
        settings,
      });
    }
    assert.equal(session.scene.propose(plan), true);
    let scene = session.scene.snapshot();
    assert.equal(
      session.decideScene({
        proposalId: scene.proposal!.id,
        version: scene.version,
        revision: session.revision,
        accept: true,
      }),
      true,
    );
    scene = session.scene.snapshot();
    session.scene.completeTurn(scene.version);
    await session.archive.save();
    const id = session.archive.id!;
    const saved = (await store.get(id))!;
    assert.equal(saved.messages.length, 33);
    assert.equal(saved.messages[0].generated, true);
    assert.equal(saved.messages.at(-1)!.role, 'scene');
    assert.equal(saved.state.scene.active!.completedTurns, 1);
    const loaded = new Session();
    loaded.restoreConversation(saved);
    assert.equal(loaded.history.length, 12);
    assert.equal(loaded.archive.snapshot()!.messages.length, 33);
    assert.deepEqual(loaded.memory.snapshot(), session.memory.snapshot());
    assert.deepEqual(loaded.scene.snapshot(), JSON.parse(JSON.stringify(session.scene.snapshot())));
    assert.equal(loaded.progress.context(), session.progress.context());
    assert.equal(loaded.reactions.remaining, 3);
    const context = JSON.stringify(loaded.history);
    assert.ok(!context.includes('USER_PRIVATE_41') && !context.includes('MIRA_PRIVATE_63'));
    assert.ok(!context.includes('They browse the shelves.'));
    const mira = JSON.stringify(
      buildReplyMessages(
        [...loaded.history, { role: 'user', content: 'Hello again.' }],
        'en',
        saved.settings,
      ),
    );
    const user = JSON.stringify(buildDraftMessages(loaded.history, 'en', saved.settings));
    assert.ok(mira.includes('MIRA_PRIVATE_63') && !mira.includes('USER_PRIVATE_41'));
    assert.ok(user.includes('USER_PRIVATE_41') && !user.includes('MIRA_PRIVATE_63'));
    const provenance = new Session();
    provenance.restoreConversation({ ...saved, messages: saved.messages.slice(0, 4) });
    assert.deepEqual(provenance.history[0], {
      role: 'user',
      content: 'Message 0. Another thought.',
      generated: true,
    });
    session.reset();
    assert.equal(session.archive.snapshot(), undefined);
    assert.equal((await store.get(id))!.messages.length, 33);
    assert.ok(events.some((event) => event.type === 'conversation.saved'));
  } finally {
    await session.archive.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

async function applicationFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'history-api-'));
  const config = {
    ...readConfig({ LLM_MODEL_NAME: 'fake', LIPSYNC_PROVIDER: 'amplitude' }),
    mediaDir: dir,
  };
  const app = await createApplication(config);
  const server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (route: string, data = {}) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  return {
    ...app,
    config,
    base,
    post,
    async close() {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('production turns autosave only after completion, restore through HTTP, and never save interrupted speech or expiring audio URLs', async () => {
  const f = await applicationFixture();
  try {
    const created = await (await f.post('/api/sessions')).json();
    const session = f.sessions.get(created.id)!;
    const personaId = f.personas[0].id;
    const command = {
      type: 'turn.send' as const,
      ...settings,
      personaId,
      text: 'I enjoy quiet walks.',
      speech: true,
    };
    const services: Services = {
      answer: async (_c, _h, _l, delta) => {
        const raw = JSON.stringify([
          {
            phrase: 'I prefer tea.',
            emotion: 'happy',
            gestures: [],
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
          { phrase: 'How about you?', emotion: 'thoughtful', gestures: [] },
        ]);
        delta(raw);
        return raw;
      },
      synthesize: async () => ({ bytes: Buffer.from('wav'), duration: 0.2 }),
      mouthCues: async () => [],
    };
    await runTurn(f.config, session, command, f.personas, f.media, services);
    assert.equal(session.archive.snapshot(), undefined);
    assert.equal((await f.conversations.list()).length, 0);
    session.stop();
    await session.archive.flush();
    assert.equal((await f.conversations.list()).length, 0);
    await runTurn(f.config, session, command, f.personas, f.media, services);
    session.finish(session.active!);
    await session.archive.flush();
    const list = await (await fetch(`${f.base}/api/conversations`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].messageCount, 3);
    const response = await fetch(`${f.base}/api/conversations/${list[0].id}`);
    const saved = savedConversationSchema.parse(await response.json());
    assert.match(response.headers.get('content-disposition')!, /attachment/);
    assert.equal(saved.state.memories[0].quote, 'I prefer tea.');
    assert.ok(!JSON.stringify(saved).includes('/media/'));
    assert.equal((await f.post('/api/sessions', { conversationId: '../escape' })).status, 422);
    assert.equal((await f.post('/api/sessions', { conversationId: randomUUID() })).status, 404);
    const resumed = await (await f.post('/api/sessions', { conversationId: saved.id })).json();
    const loaded = f.sessions.get(resumed.id)!;
    assert.notEqual(loaded.id, session.id);
    assert.equal(loaded.archive.id, saved.id);
    assert.equal(resumed.conversation.messages.length, 3);
    assert.deepEqual(loaded.history, [
      { role: 'user', content: command.text },
      { role: 'assistant', content: 'I prefer tea. How about you?' },
    ]);
    assert.equal(loaded.proactive.eligible, false);
    assert.equal(loaded.active, undefined);
    assert.equal((await f.post(`/api/sessions/${loaded.id}/save`)).status, 200);
    const spa = await fetch(`${f.base}/conversations/${saved.id}`);
    assert.equal(spa.status, 200);
    assert.match(spa.headers.get('content-type')!, /text\/html/);
    session.reset();
    assert.equal((await (await fetch(`${f.base}/api/conversations`)).json()).length, 1);
  } finally {
    await f.close();
  }
});

test('the supplied transcript imports as a separate resumable chat without inventing memories or sharing private profiles', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'history-import-'));
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/import-conversation.ts',
        'backend/tests/fixtures/cantonese-central-dinner.json',
      ],
      { cwd: appRoot, env: { ...process.env, APP_DATA_DIR: dir } },
    );
    const imported = JSON.parse(result.stdout);
    const store = new ConversationStore(path.join(dir, 'media/conversations'));
    const saved = (await store.get(imported.id))!;
    assert.equal(saved.messages.length, 68);
    assert.equal(saved.state.language, 'yue');
    assert.deepEqual(saved.state.memories, []);
    assert.equal(saved.state.scene.active, undefined);
    assert.equal(saved.settings.aboutMe, '');
    assert.equal(saved.settings.miraBehavior, '');
    assert.equal(saved.settingsCaptured, false);
    const loaded = new Session();
    loaded.restoreConversation(saved);
    assert.match(loaded.history.at(-1)!.content, /B出口/);
    assert.match(imported.url, new RegExp(`/conversations/${saved.id}$`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
