import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const qa = path.join(root, 'runtime/qa');

await mkdir(qa, { recursive: true });

const run = promisify(execFile);

await run('/usr/bin/say', [
  '-o',
  path.join(qa, 'voice.aiff'),
  'Hello. I am your digital assistant. How can I help you today?',
]);

await run('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-i',
  path.join(qa, 'voice.aiff'),
  '-ar',
  '24000',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  path.join(qa, 'voice.wav'),
]);

await run('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-i',
  path.join(qa, 'voice.wav'),
  '-t',
  '0.35',
  '-c:a',
  'pcm_s16le',
  path.join(qa, 'reaction-short.wav'),
]);
const shortWav = await readFile(path.join(qa, 'reaction-short.wav'));
const reactionPhrases = [
  'Who said I like you?',
  'Do not tease me like that!',
  'I am not blushing.',
];
const wav = await readFile(path.join(qa, 'voice.wav'));

const duration = (wav.length - 44) / 48000;

const sample = 'Hello. I am your digital assistant. How can I help you today?';

const cantonese = '八爪魚有八條腕，腕上面有吸盤。';

const llmLanguages: string[] = [];
const ttsTexts: string[] = [];
const ttsEmotions: string[] = [];
const llmHistories: string[][] = [];
const llmRequests: any[] = [];
const speechEvents: any[] = [];
const sentCommands: any[] = [];
const maleSpeechRequests: any[] = [];
let continuationCalls = 0;
let sceneDialogueCalls = 0;
let maleConfigured = true;
let failMaleSpeech = false;
const suggestedDraft = 'Tell me more about that.';
const proactiveQuestion = 'Would you like to explore something else?';
const secondProactiveQuestion = 'How is that idea sitting with you now?';
const repeatedAutomaticLine =
  'We will keep following the same path and discussing this exact same dessert again later.';
const scenePlan = {
  title: 'A quiet dessert outing',
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
let forceRepeatedAutomatic = false;
let recoverAutomaticAt: 'related' | 'fresh' | undefined;
let automaticMiraCalls = 0;
let automaticSpokenCalls = 0;
const brokenReply =
  '[{"emotion":"angry","gestures":[]},{"phrase":"This complete trailing fragment belongs in diagnostics.","emotion":"neutral","gestures":[]}]';
let proactiveCalls = 0;
let draftCalls = 0;

const personaChecks = process.env.BROWSER_PERSONAS?.split(',') ?? [
  'haru',
  'ren',
  'seed-san',
  'constraint-twist',
];

const mock = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'ready',
        busy: false,
        voices: ['ryan', 'vivian'],
        languages: ['english', 'chinese', 'cantonese'],
        voice_profiles: { user_male: { configured: maleConfigured } },
      }),
    );
    return;
  }
  if (req.url === '/v1/chat/completions') {
    const input = JSON.parse(body);
    llmRequests.push(input);
    if (input.messages[0].content.startsWith('Plan small fictional')) {
      const steps =
        process.env.BROWSER_SCENES_ONLY === 'true'
          ? [
              {
                location: 'Dessert shop',
                activity: `A new moment ${++continuationCalls}`,
                narration: `They share another moment at the table, number ${continuationCalls}.`,
                leader: 'together',
              },
            ]
          : [];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps }) } }] }));
      return;
    }
    const finalContent = input.messages.at(-1).content;
    const quotedMessage = finalContent.match(/^Given I say:\n([^\n]+)\n\nRESPONSE REQUIREMENTS:\n/);
    const text = quotedMessage ? JSON.parse(quotedMessage[1]) : finalContent;
    llmLanguages.push(finalContent);
    llmHistories.push(
      input.messages
        .filter((message: any) => message.role === 'assistant')
        .map((message: any) => message.content),
    );
    const isDraft = input.messages[0].content.includes('FROM THE USER');
    const isSpoken = finalContent.includes('SPOKEN USER MESSAGE FORMAT');
    if (isDraft) {
      assert.deepEqual(
        input.messages.map((message: any) => message.role),
        ['system', 'user'],
      );
      const transcript = JSON.parse(finalContent.split('\n')[1]);
      if (!finalContent.includes('CONVERSATION RECOVERY:'))
        assert.equal(transcript.at(-1)?.speaker, 'Mira');
      assert.match(finalContent, /Current speaker: the user talking to Mira/);
      assert.match(finalContent, /do not echo, closely paraphrase|Do not echo a phrase/);
      draftCalls++;
      assert.equal(input.messages.at(-1).role, 'user');
      assert.match(input.messages.at(-1).content, /suggested next message/);
    }
    const isProactive = finalContent.startsWith('TASK:\nThe user is quiet');
    if (isProactive) {
      proactiveCalls++;
      assert.equal(input.messages.at(-2).role, 'assistant');
      assert.equal(input.messages.at(-1).role, 'user');
      assert.match(input.messages.at(-1).content, /user is quiet/);
    }
    let reply = isSpoken
      ? JSON.stringify({ phrases: ['First spoken phrase.', 'Second spoken phrase.'] })
      : isDraft
        ? JSON.stringify({ draft: suggestedDraft })
        : isProactive
          ? JSON.stringify([
              {
                phrase: proactiveCalls === 1 ? proactiveQuestion : secondProactiveQuestion,
                emotion: 'thoughtful',
                gestures: [],
              },
            ])
          : text === 'pose-reply'
            ? JSON.stringify([
                {
                  phrase: 'Here is a dramatic pose.',
                  emotion: 'happy',
                  gestures: [{ name: 'dramatic_lean', strength: 0.9 }],
                },
                {
                  phrase: 'I was only helping because I felt like it!',
                  emotion: 'neutral',
                  gestures: [{ name: 'tsundere_turn', strength: 0.9 }],
                },
              ])
            : text === 'broken-json'
              ? brokenReply
              : text === '八爪魚嘅特徵' &&
                  finalContent.includes('Reply in natural colloquial Hong Kong Cantonese')
                ? JSON.stringify([
                    {
                      phrase: cantonese,
                      emotion: 'neutral',
                      gestures: [{ name: 'open_hand', strength: 0.5 }],
                    },
                  ])
                : JSON.stringify([
                    {
                      phrase: 'Hello.',
                      emotion: 'happy',
                      gestures: [{ name: 'wave', strength: 0.4 }],
                    },
                    { phrase: 'I am your digital assistant.', emotion: 'neutral', gestures: [] },
                    {
                      phrase: 'How can I help you today?',
                      emotion: 'thoughtful',
                      gestures: [{ name: 'nod', strength: 0.5 }],
                    },
                  ]);
    if (isDraft && isSpoken && ++automaticSpokenCalls > 1)
      reply = JSON.stringify({
        phrases: ['The evening has been peaceful.', 'I would like to hear your thoughts.'],
      });
    if (
      !isDraft &&
      !isProactive &&
      finalContent.includes('The latest user message was automatically generated.')
    ) {
      automaticMiraCalls++;
      reply = JSON.stringify([
        {
          phrase: forceRepeatedAutomatic
            ? recoverAutomaticAt &&
              finalContent.includes(
                recoverAutomaticAt === 'related' ? 'RELATED ANGLE' : 'FRESH TOPIC',
              )
              ? 'A quiet evening could use a little music.'
              : repeatedAutomaticLine
            : ['Thanks for sharing.', 'That makes sense.', 'I am listening.'][
                automaticMiraCalls % 3
              ],
          emotion: 'neutral',
          gestures: [],
        },
      ]);
    }
    if (text === 'repeat-seed')
      reply = JSON.stringify([{ phrase: repeatedAutomaticLine, emotion: 'neutral', gestures: [] }]);
    if (text.startsWith('scene-')) {
      const proposal =
        text === 'scene-offer'
          ? process.env.BROWSER_SCENES_ONLY === 'true'
            ? { ...scenePlan, steps: scenePlan.steps.slice(0, 2) }
            : scenePlan
          : text === 'scene-major-change'
            ? { ...scenePlan, title: 'A garden visit' }
            : undefined;
      const phrase =
        text === 'scene-offer'
          ? 'We could visit a quiet dessert shop.'
          : text === 'scene-major-change'
            ? 'Would you like a garden visit after dessert?'
            : text === 'scene-arrive'
              ? 'The menu is here; we have arrived.'
              : process.env.BROWSER_SCENES_ONLY === 'true'
                ? `This dessert has a different flavour, number ${++sceneDialogueCalls}.`
                : 'I can see a quiet table near the window.';
      reply = JSON.stringify([
        {
          phrase,
          emotion: 'happy',
          gestures: [],
          ...(proposal && finalContent.includes('VIRTUAL SCENE MODE')
            ? { sceneProposal: proposal }
            : {}),
        },
      ]);
    }
    if (['scene-accept', 'scene-future', 'scene-agreed-change'].includes(text)) {
      const stateLine = finalContent
        .split('Authoritative scene state (quoted data): ')[1]
        ?.split('\n')[0];
      const state = stateLine ? JSON.parse(stateLine) : undefined;
      const phrase = text === 'scene-future' ? 'Yes, another day.' : 'Yes, let us go now.';
      const proposal =
        text === 'scene-accept'
          ? undefined
          : {
              title: text === 'scene-future' ? 'A future garden visit' : 'A bookstore visit',
              steps: [
                {
                  location: 'Bookstore doorway',
                  activity: 'Arriving',
                  narration: 'They arrive at a quiet bookstore.',
                  leader: 'together',
                },
                {
                  location: 'Bookstore shelves',
                  activity: 'Browsing',
                  narration: 'They browse books together.',
                  leader: 'together',
                },
              ],
            };
      reply = JSON.stringify([
        {
          phrase,
          emotion: 'happy',
          gestures: [],
          ...(proposal ? { sceneProposal: proposal } : {}),
          sceneAgreement: {
            ...(text === 'scene-accept' ? { proposalId: state.proposal.id } : {}),
            offerQuote: text,
            acceptanceQuote: phrase,
            timing: text === 'scene-future' ? 'later' : 'now',
          },
        },
      ]);
    }
    if (text === 'I enjoy quiet walks.')
      reply = JSON.stringify([
        {
          phrase: 'I prefer tea.',
          emotion: 'happy',
          gestures: [],
          memories: [
            {
              owner: 'user',
              category: 'interests',
              key: 'quiet_walks',
              value: 'Enjoys quiet walks.',
              quote: 'I enjoy quiet walks.',
            },
            {
              owner: 'mira',
              category: 'preferences',
              key: 'drink',
              value: 'Prefers tea.',
              quote: 'I prefer tea.',
            },
          ],
        },
      ]);
    if (text === 'angry-reaction')
      reply = JSON.stringify(
        reactionPhrases.map((phrase, index) => ({
          phrase,
          emotion: index === 0 ? 'angry' : 'neutral',
          gestures: [],
          ...(index === 0 ? { reaction: { name: 'flustered_denial', intensity: 0.85 } } : {}),
        })),
      );
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (text === 'slow') await new Promise((r) => setTimeout(r, 1200));
    if (isDraft) await new Promise((resolve) => setTimeout(resolve, isSpoken ? 1200 : 500));
    if (!res.destroyed) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden' } }] })}\n\n`,
      );
      for (let offset = 0; offset < reply.length; offset += 19) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(offset, offset + 19) } }] })}\n\n`,
        );
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }
    return;
  }
  if (req.url === '/v1/audio/speech') {
    const { text, emotion, profile } = JSON.parse(body);
    if (profile === 'user_male') maleSpeechRequests.push({ text, profile });
    if (profile === 'user_male' && failMaleSpeech && text === 'Second spoken phrase.') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Synthetic TTS failure' }));
      return;
    }
    assert.ok(!/<\/?(?:gesture|emotion)\b|"phrase"\s*:|"gestures"\s*:/.test(text));
    ttsTexts.push(text);
    ttsEmotions.push(emotion);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'X-Audio-Duration': String(reactionPhrases.includes(text) ? 0.35 : duration),
      'X-Sample-Rate': '24000',
    });
    res.end(reactionPhrases.includes(text) ? shortWav : wav);
    return;
  }
  if (req.url === '/v1/audio/transcriptions') {
    assert.match(body, /name="align"\r\n\r\nfalse/);
    assert.match(body, /name="language"\r\n\r\nauto/);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'This transcript is editable.',
        language: 'English',
        words: [],
        alignment_performed: false,
        duration_seconds: 1,
        processing_seconds: 0.1,
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));

const provider = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

const reserve = createServer();

await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));

const port = (reserve.address() as { port: number }).port;

await new Promise<void>((r) => reserve.close(() => r()));

const backend = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    APP_PORT: String(port),
    APP_DATA_DIR: path.join(qa, `browser-data-${port}`),
    LLM_BASE_URL: provider + '/v1',
    LLM_API_KEY: 'test-only',
    LLM_MODEL_NAME: 'mock',
    ASR_BASE_URL: provider,
    TTS_BASE_URL: provider,
    LIPSYNC_PROVIDER: 'amplitude',
    RHUBARB_BIN: '/missing/rhubarb',
    CANTONESE_TTS_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const url = `http://127.0.0.1:${port}`;

let ready = false;

for (let i = 0; i < 80; i++) {
  try {
    const response = await fetch(url + '/api/personas');
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

if (!ready) {
  backend.kill();
  mock.close();
  throw new Error('QA backend did not start');
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
});

const page = await context.newPage();

const errors: string[] = [];
page.on('websocket', (socket) => {
  socket.on('framesent', ({ payload }) => sentCommands.push(JSON.parse(payload.toString())));
  socket.on('framereceived', ({ payload }) => {
    const event = JSON.parse(payload.toString());
    if (event.type === 'speech.ready') speechEvents.push(event);
  });
});

page.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('Browser exception:', e.stack);
});

page.on('console', (message) => {
  if (message.type() === 'error') console.log('Browser console:', message.text());
});

page.on('requestfailed', (request) =>
  console.log('Failed browser request:', request.url(), request.failure()?.errorText),
);

async function checkFullBrowser() {
  await page.goto(url);
  await page.getByText('Persona ready', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole('combobox', { name: 'Reply language' }).inputValue(), 'auto');
  await page.screenshot({ path: path.join(qa, 'studio-vrm.png'), fullPage: true });
  await page.getByText('VRM poses · 姿勢', { exact: true }).click();
  const poseStrength = page.getByRole('slider', { name: 'Pose strength' });
  await poseStrength.press('End');
  for (let i = 0; i < 5; i++) await poseStrength.press('ArrowLeft');
  assert.equal(await poseStrength.inputValue(), '0.75');
  await page.getByRole('spinbutton', { name: 'Pose hold seconds' }).fill('4.5');
  await page.getByRole('button', { name: '舉手 · Raise hand', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(
    await page.locator('.message').count(),
    0,
    'Pose preview works before starting a conversation',
  );
  await page.screenshot({ path: path.join(qa, 'studio-pose-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Return to idle', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.getByRole('button', { name: '三七面 · Tsundere turn', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await page.screenshot({ path: path.join(qa, 'studio-tsundere-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Return to idle', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.getByRole('button', { name: '嬲爆跳 · Angry hop', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await page.screenshot({ path: path.join(qa, 'studio-angry-hop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Return to idle', exact: true }).click();
  await page.getByText('VRM poses · 姿勢', { exact: true }).click();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Introduce yourself', exact: false }).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Replay voice' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.message.assistant .bubble').first().innerText(), sample);
  assert.deepEqual(ttsTexts.slice(0, 3), [
    'Hello.',
    'I am your digital assistant.',
    'How can I help you today?',
  ]);
  assert.deepEqual(
    speechEvents.slice(0, 3).map((event) => event.phraseIndex),
    [0, 1, 2],
  );
  assert.deepEqual(
    speechEvents.slice(0, 3).map((event) => event.performance.gestures[0]?.name),
    ['wave', undefined, 'nod'],
  );
  assert.deepEqual(ttsEmotions.slice(0, 3), ['happy', 'neutral', 'thoughtful']);
  assert.deepEqual(
    speechEvents.slice(0, 3).map((event) => event.performance.emotion),
    ttsEmotions.slice(0, 3),
  );
  assert.ok(!(await page.getByText('"phrase":', { exact: false }).count()));
  assert.ok(!(await page.getByText('"gestures":', { exact: false }).count()));
  assert.ok(!(await page.getByText('hidden', { exact: true }).count()));
  await page.screenshot({ path: path.join(qa, 'studio-conversation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Record a question', exact: true }).click();
  await new Promise((r) => setTimeout(r, 700));
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click();
  await page.getByText('Transcript ready. Edit it below before sending.').waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
    'This transcript is editable.',
  );
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('slow');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(
    await page.locator('.message.assistant .bubble').filter({ hasText: sample }).count(),
    1,
  );
  for (const id of personaChecks) {
    console.log('Checking persona:', id);
    await page.getByRole('combobox', { name: 'Choose persona' }).selectOption(id);
    await page.getByText('Persona ready', { exact: true }).waitFor({ timeout: 30000 });
    if (id === 'haru') {
      assert.equal(await page.getByText('VRM poses · 姿勢', { exact: true }).count(), 0);
      await page.screenshot({ path: path.join(qa, 'studio-live2d.png'), fullPage: true });
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello again');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('button', { name: 'Replay voice' }).waitFor({ timeout: 30000 });
    }
  }
  // The remaining pose/settings checks require a VRM, regardless of the order
  // supplied in BROWSER_PERSONAS (which may finish with a Live2D avatar).
  await page.getByRole('combobox', { name: 'Choose persona' }).selectOption('constraint-twist');
  await page.getByText('Persona ready', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('combobox', { name: 'Reply language' }).selectOption('yue');
  assert.equal(await page.getByRole('checkbox', { name: 'Spoken replies' }).isChecked(), false);
  await page.getByRole('combobox', { name: 'Reply language' }).selectOption('auto');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('八爪魚嘅特徵');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText(cantonese, { exact: true }).first().waitFor();
  await page.getByRole('combobox', { name: 'Reply language' }).selectOption('en');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('八爪魚嘅特徵');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('combobox', { name: 'Reply language' }).selectOption('auto');
  assert.ok(llmLanguages.at(-2)?.includes('Reply in natural colloquial Hong Kong Cantonese'));
  assert.ok(llmLanguages.at(-1)?.includes('Reply in English'));
  assert.ok(llmHistories.some((history) => history.includes(sample)));
  await page.locator('.speech-toggle').click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('pose-reply');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Replay voice', exact: true }).waitFor({ timeout: 15000 });
  assert.equal(speechEvents.at(-2).performance.gestures[0].name, 'dramatic_lean');
  assert.equal(speechEvents.at(-1).performance.gestures[0].name, 'tsundere_turn');
  assert.equal(
    (await page.getByText('Here is a dramatic pose.', { exact: false }).count()) > 0,
    true,
  );
  await page.locator('.speech-toggle').click();
  assert.ok(
    llmHistories
      .flat()
      .every((text) => !text.includes('"phrase":') && !text.includes('"gestures":')),
  );
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const suggest = page.getByRole('button', { name: 'Suggest reply', exact: true });
  await page.waitForFunction(
    () => !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
  );
  const messageCount = await page.locator('.message').count();
  await suggest.click();
  await page.waitForFunction(
    (value) =>
      (document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value === value,
    suggestedDraft,
  );
  assert.equal(await page.locator('.message').count(), messageCount);
  await composer.fill('My existing draft');
  await suggest.click();
  await page.getByRole('button', { name: 'Use suggested reply' }).waitFor();
  assert.equal(await composer.inputValue(), 'My existing draft');
  await page.getByRole('button', { name: 'Use suggested reply' }).click();
  assert.equal(await composer.inputValue(), suggestedDraft);
  await composer.fill('');
  await suggest.click();
  await composer.fill('Keep my typing');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await composer.inputValue(), 'Keep my typing');

  assert.equal(await page.getByRole('checkbox', { name: 'Proactive chat' }).isChecked(), false);
  await composer.fill('Start a new topic');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(
    () => !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
  );
  await page.getByRole('spinbutton', { name: 'Proactive delay seconds' }).fill('1');
  await page.getByRole('checkbox', { name: 'Proactive chat' }).check();
  await page.getByText(proactiveQuestion, { exact: true }).first().waitFor({ timeout: 5000 });
  assert.equal(proactiveCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    proactiveCalls,
    1,
    'proactive messages must not form an automatic conversation loop',
  );
  await composer.fill('Another topic');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(
    () => !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
  );
  await composer.fill('Unsent draft blocks automatic speech');
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(proactiveCalls, 1);
  await composer.fill('');
  await page
    .locator('.message.assistant .bubble')
    .filter({ hasText: secondProactiveQuestion })
    .waitFor({ timeout: 5000 });
  assert.equal(proactiveCalls, 2);
  await composer.fill('slow');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(
    proactiveCalls,
    2,
    'Stop must suppress automatic follow-ups until the next user send',
  );
  await page.getByRole('checkbox', { name: 'Proactive chat' }).uncheck();

  await composer.fill('broken-json');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Inspect raw LLM response', { exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'Raw LLM response' }).inputValue(),
    brokenReply,
  );
  const capturedRequest = JSON.parse(
    await page.getByRole('textbox', { name: 'LLM request body' }).inputValue(),
  );
  assert.deepEqual(capturedRequest, llmRequests.at(-1));
  assert.equal(capturedRequest.model, 'mock');
  assert.equal(capturedRequest.messages[0].role, 'system');
  assert.match(capturedRequest.messages[0].content, /Every new reply must be a JSON array/);
  assert.equal(capturedRequest.messages.at(-1).role, 'user');
  assert.ok(
    capturedRequest.messages
      .at(-1)
      .content.startsWith('Given I say:\n"broken-json"\n\nRESPONSE REQUIREMENTS:\n'),
  );
  assert.match(capturedRequest.messages.at(-1).content, /Give your response in JSON array format/);
  assert.equal(capturedRequest.stream, true);
  await page.getByRole('button', { name: 'Copy request body', exact: true }).click();
  const copiedRequest = await page.evaluate(() => navigator.clipboard.readText());
  assert.deepEqual(JSON.parse(copiedRequest), capturedRequest);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download diagnostics' }).click();
  const download = await downloadEvent;
  const diagnosticFile = path.join(qa, 'llm-diagnostic-example.json');
  await download.saveAs(diagnosticFile);
  const diagnostic = JSON.parse(await readFile(diagnosticFile, 'utf8'));
  assert.equal(diagnostic.rawOutput, brokenReply);
  assert.deepEqual(diagnostic.requestBody, capturedRequest);
  assert.equal(diagnostic.finishReason, 'stop');
  assert.equal(diagnostic.outputComplete, true);
  assert.ok(diagnostic.parser.validation);
  assert.ok(!JSON.stringify(diagnostic).includes('test-only'));
  await page.screenshot({ path: path.join(qa, 'studio-diagnostics.png'), fullPage: true });

  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await page.getByText('What’s on', { exact: false }).waitFor();
  assert.equal(await page.locator('.message').count(), 0);

  await page.getByText('Conversation settings', { exact: true }).click();
  const swearing = page.getByRole('checkbox', { name: 'Localized swearing', exact: true });
  assert.equal(await swearing.isChecked(), false);
  const scenes = page.getByRole('checkbox', { name: 'Virtual scenes', exact: true });
  assert.equal(await scenes.isChecked(), false);
  const autoScenes = page.getByRole('checkbox', {
    name: 'Automatically enter suggested scenes',
    exact: true,
  });
  const recovery = page.getByRole('checkbox', {
    name: 'Automatically recover stalled conversations',
    exact: true,
  });
  assert.equal(await autoScenes.isChecked(), false);
  assert.equal(await recovery.isChecked(), true);
  const variation = page.getByRole('checkbox', {
    name: 'Natural conversation variation',
    exact: true,
  });
  assert.equal(await variation.isChecked(), true);
  const focus = page.getByRole('checkbox', { name: 'Get to know each other', exact: true });
  const aboutMe = page.getByRole('textbox', { name: 'About me', exact: true });
  const characterSetting = page.getByRole('textbox', { name: 'About Mira', exact: true });
  await characterSetting.fill('Mira likes me secretly and reacts with playful embarrassed anger.');
  assert.equal(
    await page
      .getByRole('checkbox', { name: 'Embarrassed angry-hop reaction', exact: true })
      .isChecked(),
    true,
  );
  const profile = 'I enjoy quiet walks.\nI prefer tea after work.';
  const editedProfile = `${profile}\nI like rainy evenings.`;
  assert.equal(await focus.isChecked(), false);
  assert.equal(await aboutMe.inputValue(), '');
  const display = page.getByRole('combobox', { name: 'Mira message display' });
  const phraseDelay = page.getByRole('spinbutton', { name: 'Text-only phrase delay seconds' });
  await display.selectOption('phrases');
  await phraseDelay.fill('1');
  await composer.fill('Paced phrases');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Hello.', { exact: true }).first().waitFor();
  assert.equal(await page.locator('.message.assistant .bubble').count(), 1);
  assert.equal(await page.getByText(sample, { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(
    await page.locator('.message.assistant .bubble').count(),
    1,
    'Stop cancels queued text bubbles',
  );
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await phraseDelay.fill('0.2');
  await page.evaluate(() => {
    const times: number[] = [];
    (window as any).phraseRevealTimes = times;
    const observer = new MutationObserver(() => {
      const count = document.querySelectorAll('.message.assistant .bubble').length;
      while (times.length < count) times.push(performance.now());
      if (count === 3) observer.disconnect();
    });
    observer.observe(document.querySelector('.messages')!, { childList: true, subtree: true });
  });
  await composer.fill('Show all phrase bubbles');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.message.assistant .bubble').length === 3,
  );
  assert.deepEqual(await page.locator('.message.assistant .bubble').allTextContents(), [
    'Hello.',
    'I am your digital assistant.',
    'How can I help you today?',
  ]);
  const revealTimes: number[] = await page.evaluate(() => (window as any).phraseRevealTimes);
  for (let i = 1; i < revealTimes.length; i++) {
    const elapsed = revealTimes[i] - revealTimes[i - 1];
    assert.ok(
      elapsed >= 140 && elapsed < 650,
      `Changed phrase delay should apply within the live session; observed ${elapsed}ms`,
    );
  }
  assert.match(llmLanguages.at(-1)!, /NATURAL VARIATION/);

  // Speech reveals at the actual audio start, rather than JSON receipt.
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await page.locator('.speech-toggle').click();
  assert.equal(await page.getByRole('checkbox', { name: 'Spoken replies' }).isChecked(), true);
  await composer.fill('Spoken phrase bubbles');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Hello.', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Pause speech', exact: true }).click();
  await page.getByRole('button', { name: 'Resume speech', exact: true }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(
    await page.locator('.message.assistant .bubble').count(),
    1,
    'Paused audio must not reveal later phrases',
  );
  await page.getByRole('button', { name: 'Resume speech', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.message.assistant .bubble').length === 3,
    null,
    { timeout: 20000 },
  );
  await page.getByRole('button', { name: 'Replay voice', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Replay voice', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    await page.locator('.message.assistant .bubble').count(),
    3,
    'Replay does not duplicate phrase bubbles',
  );
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();

  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await page.locator('.speech-toggle').click();
  assert.equal(await page.getByRole('checkbox', { name: 'Spoken replies' }).isChecked(), false);
  await display.selectOption('full');
  await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Auto reply turn limit' }).fill('2');
  const auto = page.getByRole('checkbox', { name: 'Auto-LLM-suggest-and-reply' });
  await swearing.check();
  await focus.check();
  await aboutMe.fill(profile);
  const beforeSwearingConversation = llmRequests.length;
  await page.getByRole('checkbox', { name: 'Proactive chat' }).check();
  await auto.check();
  const proactiveBeforeAuto = proactiveCalls;
  const draftsBeforeAuto = draftCalls;
  await composer.fill('Start an automatic conversation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('status', { name: 'Your automatic reply is typing', exact: true }).waitFor();
  assert.equal(await page.locator('.auto-reply-typing .thinking i').count(), 3);
  assert.equal(
    await page.getByRole('textbox', { name: 'Spoken phrase 1', exact: true }).count(),
    0,
  );
  await page.getByText('2/2 sent · limit reached', { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(draftCalls - draftsBeforeAuto, 2);
  const swearingConversation = llmRequests.slice(beforeSwearingConversation);
  assert.ok(
    swearingConversation.some((request) => request.messages[0].content.includes('FROM THE USER')),
  );
  assert.ok(swearingConversation.some((request) => request.messages[0].content.includes('Mira')));
  for (const request of swearingConversation) {
    assert.match(request.messages.at(-1).content, /LOCALIZED PROFANITY MODE: ON/);
    assert.match(request.messages.at(-1).content, /CONVERSATION FOCUS: GET TO KNOW EACH OTHER/);
    assert.equal(
      request.messages.at(-1).content.includes(JSON.stringify(profile)),
      request.messages[0].content.includes('FROM THE USER'),
    );
    assert.ok(!request.messages.at(-1).content.includes('a little seductive'));
  }
  assert.ok(
    swearingConversation.some((request) =>
      JSON.stringify(request.messages).includes('personal details are unconfirmed'),
    ),
  );
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').at(-1).automatic,
    true,
  );
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').at(-1).getToKnowEachOther,
    true,
  );
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').at(-1).aboutMe,
    profile,
  );
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').at(-1).localizedProfanity,
    true,
  );
  assert.equal(await page.locator('.message.user .bubble').count(), 3);
  assert.equal(
    (await page.locator('.message.user .bubble').allTextContents()).filter(
      (text) => text === suggestedDraft,
    ).length,
    2,
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(draftCalls - draftsBeforeAuto, 2, 'Automatic conversation obeys its turn limit');
  assert.equal(
    proactiveCalls,
    proactiveBeforeAuto,
    'Proactive follow-ups are suspended during auto reply mode',
  );
  await page.getByRole('button', { name: 'Resume auto replies', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.auto-reply-options')?.textContent?.includes('drafting'),
  );
  await aboutMe.fill(editedProfile);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    await page.locator('.message.user .bubble').count(),
    3,
    'Profile editing cancels an in-flight automatic suggestion',
  );
  assert.match(await page.locator('.auto-reply-options').innerText(), /paused/);
  await page.getByRole('button', { name: 'Resume auto replies', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.auto-reply-options')?.textContent?.includes('drafting'),
  );
  await composer.fill('My typing takes over');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    await page.locator('.message.user .bubble').count(),
    3,
    'Typing aborts an automatic draft before it is sent',
  );
  assert.equal(await composer.inputValue(), 'My typing takes over');
  assert.match(await page.locator('.auto-reply-options').innerText(), /paused/);
  await composer.fill('');

  // Browser preferences persist on a fresh root page. Saved-URL reloads are checked separately.
  await display.selectOption('phrases');
  await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).fill('2.5');
  await phraseDelay.fill('0.5');
  await page.goto(url);
  await page.getByText('VRM poses · 姿勢', { exact: true }).click();
  assert.equal(await poseStrength.inputValue(), '0.75');
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Pose hold seconds' }).inputValue(),
    '4.5',
  );
  await page.getByText('Conversation settings', { exact: true }).click();
  assert.equal(await swearing.isChecked(), true);
  assert.equal(await focus.isChecked(), true);
  assert.equal(await aboutMe.inputValue(), editedProfile);
  assert.match(await characterSetting.inputValue(), /likes me secretly/);
  assert.equal(await auto.isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Proactive chat' }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Spoken replies' }).isChecked(), false);
  assert.equal(await display.inputValue(), 'phrases');
  assert.equal(await phraseDelay.inputValue(), '0.5');
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).inputValue(),
    '2.5',
  );
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Auto reply turn limit' }).inputValue(),
    '2',
  );
  const draftsAfterReload = draftCalls;
  await new Promise((resolve) => setTimeout(resolve, 2800));
  assert.equal(
    draftCalls,
    draftsAfterReload,
    'Restoring settings does not automatically start a conversation',
  );
  await page.getByRole('button', { name: 'Reset settings', exact: true }).click();
  assert.equal(await poseStrength.inputValue(), '0.9');
  assert.equal(await page.getByRole('spinbutton', { name: 'Pose hold seconds' }).inputValue(), '3');
  await page.getByText('VRM poses · 姿勢', { exact: true }).click();
  assert.equal(await auto.isChecked(), false);
  assert.equal(await swearing.isChecked(), false);
  assert.equal(await focus.isChecked(), false);
  assert.equal(await aboutMe.inputValue(), '');
  assert.equal(await display.inputValue(), 'full');
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Auto reply turn limit' }).inputValue(),
    '5',
  );

  // Both user-side generators share a queue; only a completed queue sends a turn.
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Introduce yourself', exact: false }).waitFor();
  await page.locator('.speech-toggle').click();
  const manualMode = page.getByRole('combobox', { name: 'Manual message mode' });
  const autoMode = page.getByRole('combobox', { name: 'Auto reply mode' });
  await manualMode.selectOption('spoken');
  await focus.check();
  await aboutMe.fill(profile);
  const originalMessage = 'I am tired, but I would like to keep chatting.';
  await composer.fill(originalMessage);
  await page.getByRole('button', { name: 'Prepare spoken message', exact: true }).click();
  await page.getByRole('textbox', { name: 'Spoken phrase 1', exact: true }).waitFor();
  assert.equal(await composer.inputValue(), originalMessage);
  assert.equal(await page.locator('.message.user').count(), 0);
  assert.ok(
    !JSON.stringify(llmRequests.at(-1).messages).includes(
      'CONVERSATION FOCUS: GET TO KNOW EACH OTHER',
    ),
  );
  assert.ok(!JSON.stringify(llmRequests.at(-1).messages).includes('I enjoy quiet walks.'));
  await page
    .getByRole('textbox', { name: 'Spoken phrase 1', exact: true })
    .fill('Edited first phrase.');
  await page.screenshot({ path: path.join(qa, 'studio-user-speech-preview.png'), fullPage: true });
  const beforeManual = sentCommands.filter((command) => command.type === 'turn.send').length;
  const llmBeforeManualSpeech = llmRequests.length;
  await page.getByRole('button', { name: 'Speak & send', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.message.user').length === 1);
  assert.equal(sentCommands.filter((command) => command.type === 'turn.send').length, beforeManual);
  await page.getByRole('button', { name: 'Pause speech', exact: true }).click();
  await page.getByRole('button', { name: 'Resume speech', exact: true }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await page.locator('.message.user').count(), 1);
  assert.equal(llmRequests.length, llmBeforeManualSpeech, 'Mira must wait for the male voice');
  await page.getByRole('button', { name: 'Resume speech', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.message.assistant').length === 1,
    null,
    { timeout: 25000 },
  );
  await page.getByRole('button', { name: 'Prepare spoken message', exact: true }).waitFor();
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').length,
    beforeManual + 1,
  );
  assert.equal(await page.locator('.message.user').count(), 2, 'No extra combined user bubble');
  assert.deepEqual(
    maleSpeechRequests.slice(-2).map((request) => request.text),
    ['Edited first phrase.', 'Second spoken phrase.'],
  );
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').at(-1).text,
    'Edited first phrase. Second spoken phrase.',
  );
  assert.equal(await composer.inputValue(), '');

  await composer.fill(originalMessage);
  await page.getByRole('button', { name: 'Prepare spoken message', exact: true }).click();
  await page.getByRole('textbox', { name: 'Spoken phrase 1', exact: true }).waitFor();
  const beforeStop = sentCommands.filter((command) => command.type === 'turn.send').length;
  await page.getByRole('button', { name: 'Speak & send', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.message.user').length === 3);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(sentCommands.filter((command) => command.type === 'turn.send').length, beforeStop);
  assert.equal(await composer.inputValue(), originalMessage);
  assert.ok((await page.locator('.message.user').last().innerText()).includes('Not sent'));
  assert.equal(
    await page.getByRole('textbox', { name: 'Spoken phrase 1', exact: true }).isEnabled(),
    true,
  );

  failMaleSpeech = true;
  await page.getByRole('button', { name: 'Speak & send', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(sentCommands.filter((command) => command.type === 'turn.send').length, beforeStop);
  assert.equal(await composer.inputValue(), originalMessage);
  assert.equal(
    await page.getByRole('textbox', { name: 'Spoken phrase 1', exact: true }).isEnabled(),
    true,
  );
  failMaleSpeech = false;
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();

  maleConfigured = false;
  await page.getByTitle('Refresh service readiness').click();
  await page.waitForFunction(() =>
    document
      .querySelector('.user-speech-preview')
      ?.textContent?.includes('Configure a male reference voice'),
  );
  assert.equal(
    await page.getByRole('button', { name: 'Speak & send', exact: true }).isDisabled(),
    true,
  );
  maleConfigured = true;
  await page.getByTitle('Refresh service readiness').click();
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await manualMode.selectOption('text');
  await autoMode.selectOption('spoken');
  await swearing.check();
  const beforeSpokenSwearing = llmRequests.length;
  await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Auto reply turn limit' }).fill('1');
  await auto.check();
  const beforeAutoSpoken = sentCommands.filter((command) => command.type === 'turn.send').length;
  await composer.fill('Start a spoken automatic conversation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .getByRole('status', { name: 'Your automatic reply is typing', exact: true })
    .waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.auto-reply-typing .thinking i').count(), 3);
  assert.equal(await page.locator('.user-speech-preview').count(), 0);
  assert.equal(
    await page.getByRole('textbox', { name: 'Spoken phrase 1', exact: true }).count(),
    0,
  );
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').length,
    beforeAutoSpoken + 1,
  );
  await page.screenshot({ path: path.join(qa, 'studio-auto-reply-typing.png'), fullPage: true });
  await page.waitForFunction(
    () => document.querySelectorAll('.message.user:not(.auto-reply-typing)').length === 2,
  );
  assert.equal(
    await page.getByRole('status', { name: 'Your automatic reply is typing', exact: true }).count(),
    0,
  );
  assert.equal(await page.locator('.user-speech-preview').count(), 0);
  await page.getByText('1/1 sent · limit reached', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').length,
    beforeAutoSpoken + 2,
  );
  assert.equal(await page.locator('.message.user').count(), 3);
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').at(-1).text,
    'First spoken phrase. Second spoken phrase.',
  );
  const spokenSwearing = llmRequests.slice(beforeSpokenSwearing);
  assert.ok(
    spokenSwearing.some(
      (request) =>
        request.messages[0].content.includes('FROM THE USER') &&
        request.messages.at(-1).content.includes('SPOKEN USER MESSAGE FORMAT'),
    ),
  );
  for (const request of spokenSwearing) {
    assert.match(request.messages.at(-1).content, /LOCALIZED PROFANITY MODE: ON/);
    assert.match(request.messages.at(-1).content, /CONVERSATION FOCUS: GET TO KNOW EACH OTHER/);
    assert.equal(
      request.messages.at(-1).content.includes(JSON.stringify(profile)),
      request.messages[0].content.includes('FROM THE USER'),
    );
  }
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').at(-1).automatic,
    true,
  );
  assert.equal(
    await aboutMe.inputValue(),
    profile,
    'Generated conversations never overwrite the profile',
  );
  const beforeCancelledAutoSpeech = sentCommands.filter(
    (command) => command.type === 'turn.send',
  ).length;
  await page.getByRole('button', { name: 'Resume auto replies', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.message.user:not(.auto-reply-typing)').length === 4,
  );
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    sentCommands.filter((command) => command.type === 'turn.send').length,
    beforeCancelledAutoSpeech,
  );
  assert.equal(
    await page.locator('.user-speech-preview').count(),
    0,
    'Stopping an automatic reply must not open a review editor',
  );
  assert.equal(
    await page.getByRole('status', { name: 'Your automatic reply is typing', exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Resume auto replies', exact: true }).isEnabled(),
    true,
  );
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await manualMode.selectOption('spoken');
  await page.reload();
  assert.equal(await manualMode.inputValue(), 'spoken');
  await page.getByText('Conversation settings', { exact: true }).click();
  assert.equal(await autoMode.inputValue(), 'spoken');
  assert.equal(await focus.isChecked(), true);
  assert.equal(await characterSetting.inputValue(), '');
  assert.equal(await aboutMe.inputValue(), profile);
  await page.getByRole('button', { name: 'Reset settings', exact: true }).click();
  assert.equal(await manualMode.inputValue(), 'text');
  assert.equal(await autoMode.inputValue(), 'text');
  // Virtual scenes are opt-in, major moves require a decision, and scene cards never become speech.
  assert.equal(await scenes.isChecked(), false);
  await scenes.check();
  await page.getByText('Persona ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Introduce yourself', exact: true }).waitFor();
  const ttsBeforeScene = ttsTexts.length;
  await composer.fill('scene-offer');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('A quiet dessert outing', { exact: true }).waitFor();
  assert.equal(await page.locator('.scene-event-card').count(), 0);
  await page.getByRole('button', { name: 'Start this scene', exact: true }).click();
  await page.locator('.scene-event-card').waitFor();
  assert.deepEqual(ttsTexts.slice(ttsBeforeScene), ['We could visit a quiet dessert shop.']);
  assert.ok(!ttsTexts.some((text) => scenePlan.steps.some((step) => step.narration === text)));
  assert.match(await page.getByLabel('Current virtual scene').innerText(), /On the way/);
  await page.locator('.speech-toggle').click();
  const sendScene = async (text: string) => {
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(
      () =>
        !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
    );
  };
  await sendScene('scene-first-turn');
  await sendScene('scene-second-turn');
  assert.equal(await page.locator('.scene-event-card').count(), 1);
  await sendScene('scene-arrive');
  assert.equal(await page.locator('.scene-event-card').count(), 2);
  assert.match(await page.getByLabel('Current virtual scene').innerText(), /Dessert shop/);
  assert.match(llmRequests.at(-1).messages.at(-1).content, /Leading: together/);
  assert.match(llmRequests.at(-1).messages.at(-1).content, /Earlier steps are completed/);
  await sendScene('scene-menu');
  await sendScene('scene-dessert');
  assert.equal(await page.locator('.scene-event-card').count(), 3);
  await sendScene('scene-major-change');
  await page.getByText('A garden visit', { exact: true }).waitFor();
  assert.match(await page.getByLabel('Current virtual scene').innerText(), /Dessert shop/);
  // Pending proposals do not stop the automatic dialogue or silently enter a scene.
  await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Auto reply turn limit' }).fill('1');
  const automaticWhilePending = automaticMiraCalls;
  await auto.check();
  await page.waitForFunction(() =>
    document.querySelector('.auto-reply-options')?.textContent?.includes('limit reached'),
  );
  assert.ok(automaticMiraCalls > automaticWhilePending);
  assert.equal(await page.locator('.scene-proposal-card').count(), 1);
  assert.equal(await page.locator('.scene-event-card').count(), 3);
  assert.match(await page.getByLabel('Current virtual scene').innerText(), /Dessert shop/);
  await auto.uncheck();
  await page.getByRole('button', { name: 'Keep chatting', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.scene-proposal-card'));
  await sendScene('scene-major-change');
  assert.equal(
    await page.locator('.scene-proposal-card').count(),
    0,
    'Dismissed scene proposals do not keep returning',
  );
  await page.screenshot({ path: path.join(qa, 'studio-virtual-scenes.png'), fullPage: true });
  // Auto-entry waits for the spoken proposal to finish, then emits one scene card.
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await autoScenes.check();
  await page.locator('.speech-toggle').click();
  await composer.fill('scene-offer');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('A quiet dessert outing', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Send message', exact: true })
    .waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
  );
  assert.equal(
    await page.locator('.scene-event-card').count(),
    0,
    'An invitation alone cannot auto-enter',
  );
  const beforeAutoEntry = sentCommands.length;
  await composer.fill('scene-accept');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .locator('.message.assistant .bubble')
    .filter({ hasText: 'Yes, let us go now.' })
    .waitFor();
  assert.equal(await page.locator('.scene-event-card').count(), 0);
  await page.locator('.scene-event-card').waitFor({ timeout: 15000 });
  const entryCommands = sentCommands.slice(beforeAutoEntry);
  const playbackEnd = entryCommands.findIndex((item) => item.type === 'playback.ended');
  const entry = entryCommands.findIndex((item) => item.type === 'scene.decide');
  assert.ok(playbackEnd >= 0 && entry > playbackEnd);
  assert.equal(entryCommands.filter((item) => item.type === 'scene.decide').length, 1);
  assert.equal(await page.locator('.scene-proposal-card').count(), 0);
  await page.locator('.speech-toggle').click();
  await sendScene('scene-future');
  assert.equal(await page.locator('.scene-event-card').count(), 1);
  await page.getByText('Agreed for later · 留待之後', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Keep chatting', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.scene-proposal-card'));
  await sendScene('scene-agreed-change');
  await page.waitForFunction(() => document.querySelectorAll('.scene-event-card').length === 2);
  assert.match(await page.getByLabel('Current virtual scene').innerText(), /Bookstore doorway/);
  // Session memory is inspectable and editable, is included in both generation paths, and clears on reset.
  await sendScene('I enjoy quiet walks.');
  await page.getByText('Conversation memory · 本次對話記憶 (2)', { exact: true }).click();
  const miraMemory = page.getByRole('textbox', { name: 'Memory: drink', exact: true });
  assert.equal(await miraMemory.inputValue(), 'Prefers tea.');
  await miraMemory.fill('Prefers coffee.');
  await page
    .locator('.memory-row')
    .filter({ hasText: 'Mira · fictional character' })
    .getByRole('button', { name: 'Save memory', exact: true })
    .click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.memory-row small')].some((node) =>
      node.textContent?.includes('edited by you'),
    ),
  );
  const memoryRequestStart = llmRequests.length;
  await page.getByRole('button', { name: 'Suggest reply', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () =>
      (document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement)?.value ===
      'Tell me more about that.',
  );
  const memoryDraft = llmRequests
    .slice(memoryRequestStart)
    .find((request) => request.messages[0].content.includes('FROM THE USER'));
  assert.match(memoryDraft.messages.at(-1).content, /Prefers coffee/);
  assert.match(memoryDraft.messages.at(-1).content, /I enjoy quiet walks/);
  assert.match(memoryDraft.messages.at(-1).content, /NATURAL VARIATION/);
  await composer.fill('scene-memory-context');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(
    () => !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
  );
  assert.match(llmRequests.at(-1).messages.at(-1).content, /Prefers coffee/);
  assert.match(llmRequests.at(-1).messages.at(-1).content, /NATURAL VARIATION/);
  await page
    .locator('.memory-row')
    .filter({ hasText: 'Mira · fictional character' })
    .getByRole('button', { name: 'Forget memory', exact: true })
    .click();
  await page.waitForFunction(() => document.querySelectorAll('.memory-row').length === 1);
  await page.screenshot({ path: path.join(qa, 'studio-session-memory.png'), fullPage: true });
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.memory-row').length === 0);
  await scenes.uncheck();
  await sendScene('scene-mode-off');
  assert.equal(await page.getByLabel('Current virtual scene').count(), 0);
  assert.ok(!llmRequests.at(-1).messages.at(-1).content.includes('VIRTUAL SCENE MODE'));

  // Successful bounded recovery stays in one Mira turn and does not pause automation.
  await sendScene('repeat-seed');
  forceRepeatedAutomatic = true;
  recoverAutomaticAt = 'fresh';
  const recoveryStart = automaticMiraCalls;
  await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Auto reply turn limit' }).fill('1');
  await auto.check();
  await page
    .locator('.message.assistant .bubble')
    .filter({ hasText: 'A quiet evening could use a little music.' })
    .waitFor({ timeout: 12000 });
  assert.equal(automaticMiraCalls - recoveryStart, 4);
  await page.waitForFunction(() =>
    document.querySelector('.auto-reply-options')?.textContent?.includes('limit reached'),
  );
  assert.equal(await page.getByRole('alert').count(), 0);
  await auto.uncheck();
  recoverAutomaticAt = undefined;
  forceRepeatedAutomatic = false;
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  // Exhausted recovery pauses after four attempts without rendering rejected copies.
  await sendScene('repeat-seed');
  await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Auto reply turn limit' }).fill('1');
  await auto.check();
  forceRepeatedAutomatic = true;
  const automaticBeforeRepeat = automaticMiraCalls;
  await page
    .getByRole('alert')
    .filter({ hasText: 'related angle and a fresh topic' })
    .waitFor({ timeout: 12000 });
  assert.equal(automaticMiraCalls - automaticBeforeRepeat, 4);
  assert.equal(
    (await page.locator('.message.assistant .bubble').allTextContents()).filter(
      (text) => text === repeatedAutomaticLine,
    ).length,
    1,
  );
  assert.match(await page.locator('.auto-reply-options').innerText(), /paused/);
  forceRepeatedAutomatic = false;
  await auto.uncheck();
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  assert.equal(await page.locator('.scene-event-card').count(), 0);
  await scenes.check();
  await variation.uncheck();
  await page.reload();
  await page.getByText('Conversation settings', { exact: true }).click();
  assert.equal(await variation.isChecked(), false);
  assert.equal(await scenes.isChecked(), true);
  assert.equal(await autoScenes.isChecked(), true);
  assert.equal(await recovery.isChecked(), true);
  await page.getByRole('button', { name: 'Reset settings', exact: true }).click();
  assert.equal(await scenes.isChecked(), false);
  assert.equal(await variation.isChecked(), true);
  await page.getByText('Conversation settings', { exact: true }).click();
  await checkReactions();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({ path: path.join(qa, 'studio-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    personas: [...new Set(['constraint-twist', ...personaChecks])],
    checks: [
      'selected avatars render',
      'VRM and Live2D amplitude speech without Rhubarb',
      'fragmented JSON hidden from chat and TTS',
      'JSON phrase emotion reaches TTS and avatar playback',
      'subsequent requests send plain assistant history',
      'editable reply drafts preserve existing text and cancel on typing',
      'opt-in proactive follow-up respects delay, drafts, Stop and one-shot limit',
      'raw response and exact LLM request body can be inspected and downloaded without credentials',
      'phrase bubbles follow audio starts and pause; text pacing supports Stop; replay does not duplicate bubbles',
      'automatic draft-and-send loop obeys limits and yields to typing',
      'session memory quotes, editing, forgetting and reset; memory reaches both speakers',
      'natural variation reaches both text and spoken generators; angry hop has a preview',
      'scene invitations wait for mutual agreement, future plans remain pending, new outings can replace unfinished plans',
      'automatic repetition recovery tries a related angle then a fresh topic and pauses only on exhaustion',
      'chat continues while scene proposals are pending; opt-in automatic scene entry waits for playback',
      'manual spoken rewrite preview preserves original text and speaks edited phrases',
      'male voice phrase bubbles pause and commit exactly once after playback',
      'Stop retains the draft and prevents submission; missing male voice disables playback',
      'automatic spoken replies share the queue and persist independent mode preferences',
      'automatic replies use animated typing dots without revealing the phrase editor, including after Stop',
      'get-to-know focus reaches both speakers while private profiles remain isolated; settings persist across reloads and reset independently',
      'editing the profile cancels pending automatic suggestions; generated claims do not update the profile',
      'browser settings persist across reloads and reset independently',
      'VRM pose previews work without a conversation, persist controls and accept LLM pose cues',
      'reaction settings persist, short audio preserves the whole angry hop, inspector reports completion and cooldown',
      'ordered phrases with gesture metadata',
      'typed reply and hidden-reasoning exclusion',
      'automatic ASR and editable transcript',
      'Stop rejects late output',
      'Reset',
      'Cantonese text gate',
      'automatic Cantonese reply and English override',
      'scene entry follows manual or saved automatic selection; completed dialogue advances cards with narration excluded from TTS',
      'automatic duplicate dialogue uses bounded recovery before pausing, without rendering rejected attempts',
      'scene toggle persists and resets; disabled scene mode omits scene prompts',
      'mobile layout',
    ],
    provider: 'local mock HTTP services; system-generated voice fixture',
    browser: 'installed Chrome',
    screenshots: [
      'studio-vrm.png',
      'studio-conversation.png',
      'studio-live2d.png',
      'studio-mobile.png',
    ],
  };
  await writeFile(path.join(qa, 'browser-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

async function checkReactions() {
  await page.goto(url);
  await page.getByText('Persona ready', { exact: true }).waitFor();
  const settings = page.locator('.conversation-settings');
  if (!(await settings.evaluate((node) => (node as HTMLDetailsElement).open)))
    await settings.locator(':scope > summary').click();
  const character = page.getByRole('textbox', { name: 'About Mira', exact: true });
  await character.fill(
    'MIRA_PRIVATE_9D: Mira likes me secretly and reacts with playful embarrassed anger.',
  );
  await page
    .getByRole('textbox', { name: 'About me', exact: true })
    .fill('USER_PRIVATE_5A: I collect vintage cameras.');
  await page.getByRole('checkbox', { name: 'Embarrassed angry-hop reaction', exact: true }).check();
  await page.reload();
  await page.getByText('Persona ready', { exact: true }).waitFor();
  await settings.locator(':scope > summary').click();
  assert.match(await character.inputValue(), /likes me secretly/);
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('angry-reaction');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Performance inspector · 動作檢查', { exact: true }).click();
  const inspector = page.locator('.performance-inspector');
  await inspector.getByText('angry_hop: completed', { exact: true }).waitFor({ timeout: 12000 });
  assert.match(await inspector.innerText(), /angry_hop \(0.8\)/);
  assert.match(await inspector.innerText(), /reaction_mapped · finished/);
  const miraRequest = JSON.stringify(llmRequests.at(-1));
  assert.match(miraRequest, /MIRA_PRIVATE_9D/);
  assert.doesNotMatch(miraRequest, /USER_PRIVATE_5A/);
  await page.getByRole('button', { name: 'Suggest reply', exact: true }).click();
  await page.waitForFunction(
    (text) =>
      (document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement)?.value === text,
    suggestedDraft,
  );
  const userRequest = JSON.stringify(llmRequests.at(-1));
  assert.match(userRequest, /USER_PRIVATE_5A/);
  assert.doesNotMatch(userRequest, /MIRA_PRIVATE_9D/);
  await page.screenshot({
    path: path.join(qa, 'studio-performance-inspector.png'),
    fullPage: true,
  });
  await composer.fill('angry-reaction');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await inspector.getByText('cooldown · finished', { exact: true }).waitFor({ timeout: 12000 });
  await inspector.locator('summary').click();
  await settings.locator(':scope > summary').click();
  assert.deepEqual(errors, []);
}

async function checkHistory() {
  await page.goto(url);
  await page.getByText('Persona ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  if (await page.getByRole('checkbox', { name: 'Spoken replies' }).isChecked())
    await page.locator('.speech-toggle').click();
  const settings = page.locator('.conversation-settings');
  await settings.locator(':scope > summary').click();
  await page.getByRole('checkbox', { name: 'Virtual scenes', exact: true }).check();
  await page
    .getByRole('textbox', { name: 'About me', exact: true })
    .fill('USER_SAVED_PRIVATE_42: I collect cameras.');
  await page
    .getByRole('textbox', { name: 'About Mira', exact: true })
    .fill('MIRA_SAVED_PRIVATE_53: Likes tea.');
  await page.getByRole('combobox', { name: 'Mira message display' }).selectOption('phrases');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const sendMessage = async (text: string) => {
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('.presence')?.textContent?.includes('Persona ready'),
    );
  };
  await sendMessage('I enjoy quiet walks.');
  await page.waitForURL(/\/conversations\/[0-9a-f-]+$/);
  const firstUrl = page.url();
  const firstId = firstUrl.split('/').at(-1)!;
  const historyPanel = page.locator('.conversation-history');
  await historyPanel.locator(':scope > summary').click();
  await historyPanel.getByRole('link', { name: 'I enjoy quiet walks.', exact: true }).waitFor();
  assert.equal(
    await historyPanel.getByRole('textbox', { name: 'Conversation URL' }).inputValue(),
    firstUrl,
  );
  const archive = await fetch(`${url}/api/conversations/${firstId}`).then((response) =>
    response.json(),
  );
  assert.ok(
    archive.state.memories.some(
      (memory: any) => memory.owner === 'mira' && memory.quote === 'I prefer tea.',
    ),
  );
  const countBeforeReload = await page.locator('.message').count();
  const callsBeforeReload = llmRequests.length;
  await page.reload();
  await composer.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !(document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement)?.disabled,
  );
  assert.equal(await page.locator('.message').count(), countBeforeReload);
  assert.equal(
    llmRequests.length,
    callsBeforeReload,
    'Loading never triggers an LLM reply or speech',
  );
  await sendMessage('scene-offer');
  await page.getByRole('button', { name: 'Start this scene', exact: true }).click();
  await page.locator('.scene-event-card').waitFor();
  await page.waitForFunction(async (id) => {
    const saved = await fetch(`/api/conversations/${id}`).then((response) => response.json());
    return !!saved.state.scene.active;
  }, firstId);
  const beforeResume = await page.locator('.message').count();
  await page.reload();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await page.locator('.scene-event-card').waitFor();
  assert.equal(await page.locator('.message').count(), beforeResume);
  assert.match(await page.getByLabel('Current virtual scene').innerText(), /On the way.*Walking/s);
  await historyPanel.locator(':scope > summary').click();
  await historyPanel.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.waitForURL(url + '/');
  await sendMessage('A different conversation');
  await page.waitForURL(/\/conversations\/[0-9a-f-]+$/);
  const secondUrl = page.url();
  assert.notEqual(secondUrl, firstUrl);
  await page.goBack();
  await page.waitForURL(firstUrl);
  await page.locator('.scene-event-card').waitFor();
  await page.goForward();
  await page.waitForURL(secondUrl);
  await page
    .locator('.message.user .bubble')
    .filter({ hasText: /^A different conversation$/ })
    .waitFor();
  await page.waitForFunction(
    () => !(document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement)?.disabled,
  );
  await sendMessage('Hello again');
  const lastRequest = llmRequests.at(-1);
  assert.ok(
    lastRequest.messages.some(
      (message: any) => message.role === 'user' && message.content === 'A different conversation',
    ),
  );
  assert.ok(
    lastRequest.messages.some(
      (message: any) => message.role === 'assistant' && message.content.includes('Hello.'),
    ),
  );
  assert.ok(!JSON.stringify(lastRequest).includes('USER_SAVED_PRIVATE_42'));
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await page.waitForURL(url + '/');
  await page.reload();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).waitFor();
  assert.equal(await page.locator('.message').count(), 0);
  assert.equal(
    (await fetch(`${url}/api/conversations`).then((response) => response.json())).length,
    2,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(qa, 'studio-saved-history.png'), fullPage: true });
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'autosave and history list',
        'stable URLs and reload without generation',
        'memories and scenes restored',
        'new chat and browser Back/Forward',
        'resumed plain-text LLM history and private profiles',
      ],
    }),
  );
}

async function checkSceneContinuation() {
  await page.goto(url);
  await page.getByText('Persona ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  if (await page.getByRole('checkbox', { name: 'Spoken replies' }).isChecked())
    await page.locator('.speech-toggle').click();
  await page.locator('.conversation-settings > summary').click();
  await page.getByRole('checkbox', { name: 'Virtual scenes', exact: true }).check();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const suggest = page.getByRole('button', { name: 'Suggest reply', exact: true });
  const send = async (text: string) => {
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(
      () =>
        !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
    );
  };
  await send('scene-offer');
  await page.getByRole('button', { name: 'Start this scene', exact: true }).click();
  await page.locator('.scene-event-card').waitFor();
  let turns = 0;
  for (let card = 2; card <= 4; card++) {
    await send(`scene-next-${++turns}`);
    await send(`scene-next-${++turns}`);
    assert.equal(await page.locator('.scene-event-card').count(), card - 1);
    await suggest.click();
    await page.waitForFunction(
      () =>
        !(document.querySelector('[aria-label="Suggest reply"]') as HTMLButtonElement)?.disabled,
    );
    assert.equal(await page.locator('.scene-event-card').count(), card);
    const state = await page.getByLabel('Current virtual scene').innerText();
    assert.match(state, new RegExp(`Stage ${card} · ongoing`));
    assert.match(state, /Dessert shop/);
    const request = llmRequests.at(-1);
    assert.match(request.messages[0].content, /CURRENT FICTIONAL PHYSICAL STATE/);
    assert.match(request.messages[0].content, /Dessert shop/);
    if (card > 2) assert.match(request.messages[0].content, new RegExp(`A new moment ${card - 2}`));
  }
  assert.equal(continuationCalls, 2);
  await page.waitForURL(/\/conversations\/[0-9a-f-]+$/);
  const id = page.url().split('/').at(-1)!;
  for (let attempt = 0; attempt < 30; attempt++) {
    const saved = await fetch(`${url}/api/conversations/${id}`).then((r) => r.json());
    if (saved.messages.filter((m: any) => m.role === 'scene').length === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const calls = llmRequests.length;
  await page.reload();
  await page.getByLabel('Current virtual scene').waitFor();
  assert.equal(await page.locator('.scene-event-card').count(), 4);
  assert.match(await page.getByLabel('Current virtual scene').innerText(), /Stage 4 · ongoing/);
  assert.equal(llmRequests.length, calls, 'reloading restores the scene without generating');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(qa, 'studio-scene-continuation.png'), fullPage: true });
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'legacy two-card plan continues through four cards',
        'automatic draft uses the new scene before Mira replies',
        'rolling stage IDs and completed cards survive URL reload',
      ],
    }),
  );
}

try {
  if (process.env.BROWSER_SCENES_ONLY === 'true') {
    await checkSceneContinuation();
  } else if (process.env.BROWSER_HISTORY_ONLY === 'true') {
    await checkHistory();
  } else if (process.env.BROWSER_REACTIONS_ONLY === 'true') {
    await page.goto(`http://127.0.0.1:${port}`);
    await checkReactions();
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          'reaction settings persist',
          'three short audio phrases preserve the full hop',
          'inspector completion and cooldown',
        ],
      }),
    );
  } else await checkFullBrowser();
} catch (error) {
  await page.screenshot({ path: path.join(qa, 'failure.png'), fullPage: true });
  console.log('Browser errors:', errors);
  console.log('Visible notice:', await page.locator('.avatar-loading').allTextContents());
  throw error;
} finally {
  await browser.close();
  backend.kill('SIGTERM');
  mock.closeAllConnections();
  await new Promise<void>((r) => mock.close(() => r()));
}
