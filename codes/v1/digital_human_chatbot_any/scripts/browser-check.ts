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
let maleConfigured = true;
let failMaleSpeech = false;
const suggestedDraft = 'Tell me more about that.';
const proactiveQuestion = 'Would you like to explore something else?';
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
      assert.equal(transcript.at(-1)?.speaker, 'Mira');
      assert.match(finalContent, /Current speaker: the user talking to Mira/);
      assert.match(finalContent, /do not echo, closely paraphrase/);
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
    const reply = isSpoken
      ? JSON.stringify({ phrases: ['First spoken phrase.', 'Second spoken phrase.'] })
      : isDraft
        ? JSON.stringify({ draft: suggestedDraft })
        : isProactive
          ? JSON.stringify([{ phrase: proactiveQuestion, emotion: 'thoughtful', gestures: [] }])
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
      'X-Audio-Duration': String(duration),
      'X-Sample-Rate': '24000',
    });
    res.end(wav);
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

try {
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
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll('.message.assistant .bubble')].filter(
        (node) => node.textContent === value,
      ).length === 2,
    proactiveQuestion,
    { timeout: 5000 },
  );
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
  const focus = page.getByRole('checkbox', { name: 'Get to know each other', exact: true });
  const aboutMe = page.getByRole('textbox', { name: 'About me', exact: true });
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
  assert.match(llmLanguages.at(-1)!, /two to six natural spoken clauses/);

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
    assert.ok(request.messages.at(-1).content.includes(JSON.stringify(profile)));
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

  // Browser preferences persist, but a reload does not recreate a running chat.
  await display.selectOption('phrases');
  await page.getByRole('spinbutton', { name: 'Auto reply delay seconds' }).fill('2.5');
  await phraseDelay.fill('0.5');
  await page.reload();
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
    assert.ok(request.messages.at(-1).content.includes(JSON.stringify(profile)));
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
  assert.equal(await aboutMe.inputValue(), profile);
  await page.getByRole('button', { name: 'Reset settings', exact: true }).click();
  assert.equal(await manualMode.inputValue(), 'text');
  assert.equal(await autoMode.inputValue(), 'text');
  await page.getByText('Conversation settings', { exact: true }).click();
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
      'manual spoken rewrite preview preserves original text and speaks edited phrases',
      'male voice phrase bubbles pause and commit exactly once after playback',
      'Stop retains the draft and prevents submission; missing male voice disables playback',
      'automatic spoken replies share the queue and persist independent mode preferences',
      'automatic replies use animated typing dots without revealing the phrase editor, including after Stop',
      'get-to-know focus and profile reach both speakers in text and spoken modes, persist across reloads and reset independently',
      'editing the profile cancels pending automatic suggestions; generated claims do not update the profile',
      'browser settings persist across reloads and reset independently',
      'VRM pose previews work without a conversation, persist controls and accept LLM pose cues',
      'ordered phrases with gesture metadata',
      'typed reply and hidden-reasoning exclusion',
      'automatic ASR and editable transcript',
      'Stop rejects late output',
      'Reset',
      'Cantonese text gate',
      'automatic Cantonese reply and English override',
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
