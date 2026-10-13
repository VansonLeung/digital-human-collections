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
const speechEvents: any[] = [];

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
      }),
    );
    return;
  }
  if (req.url === '/v1/chat/completions') {
    const input = JSON.parse(body);
    const text = input.messages.at(-1).content;
    llmLanguages.push(input.messages[0].content);
    const reply =
      text === '八爪魚嘅特徵' &&
      input.messages[0].content.includes('Reply in natural colloquial Hong Kong Cantonese')
        ? `<emotion name="neutral" /><gesture name="open_hand" strength="0.5" />${cantonese}`
        : '<emotion name="happy" /><gesture name="wave" strength="0.4" />Hello. I am your digital assistant. <gesture name="nod" />How can I help you today?';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (text === 'slow') await new Promise((r) => setTimeout(r, 1200));
    if (!res.destroyed) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden' } }] })}\n\n`,
      );
      for (let offset = 0; offset < reply.length; offset += 19) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(offset, offset + 19) } }] })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
    }
    return;
  }
  if (req.url === '/v1/audio/speech') {
    const text = JSON.parse(body).text;
    assert.ok(!/<\/?(?:gesture|emotion)\b/.test(text));
    ttsTexts.push(text);
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
  permissions: ['microphone'],
});

const page = await context.newPage();

const errors: string[] = [];
page.on('websocket', (socket) =>
  socket.on('framereceived', ({ payload }) => {
    const event = JSON.parse(payload.toString());
    if (event.type === 'speech.ready') speechEvents.push(event);
  }),
);

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
  assert.ok(!(await page.getByText('<gesture', { exact: false }).count()));
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
  await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
  await page.getByText('What’s on', { exact: false }).waitFor();
  assert.equal(await page.locator('.message').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(qa, 'studio-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    personas: [...new Set(['constraint-twist', ...personaChecks])],
    checks: [
      'selected avatars render',
      'VRM and Live2D amplitude speech without Rhubarb',
      'fragmented tags hidden from chat and TTS',
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
