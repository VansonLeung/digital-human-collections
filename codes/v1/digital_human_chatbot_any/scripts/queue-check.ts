import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const rate = 24000;

const wav = Buffer.alloc(44 + rate * 2);

wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);

wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);

wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);

wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);

for (let sample = 0; sample < rate; sample++)
  wav.writeInt16LE(
    Math.round(Math.sin((sample / rate) * 220 * 2 * Math.PI) * 4000),
    44 + sample * 2,
  );

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../frontend', import.meta.url)),
  appType: 'custom',
  server: { host: '127.0.0.1', port: 0 },
});

server.middlewares.use((req, res, next) => {
  if (req.url?.startsWith('/voice.wav')) {
    const send = () => {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(wav);
    };
    if (req.url.includes('delay')) setTimeout(send, 150);
    else send();
    return;
  }
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>Queue checks</body></html>');
    return;
  }
  next();
});

await server.listen();

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0]);
  await page.evaluate('globalThis.__name = (value) => value');
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/audio/SpeechQueuePlayer.ts';
    const { SpeechQueuePlayer } = await import(moduleUrl);
    const player = new SpeechQueuePlayer(
      () => {},
      () => {},
    );
    const starts: { index: number; gesture: string; clock: number }[] = [];
    const failures: string[] = [];
    let completed = 0;
    let resolveEnded!: () => void;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const phrase = (index: number) => ({
      phraseIndex: index,
      text: `Phrase ${index}`,
      performance: {
        emotion: 'happy',
        gestures: [{ name: index ? 'nod' : 'wave', strength: 0.5 }],
      },
      audioUrl: `/voice.wav${index === 0 ? '?delay' : ''}`,
      duration: 1,
      cues: [],
      lipSyncMode: 'amplitude',
    });
    const begin = () =>
      player.begin({
        phraseStarted: (item: any) =>
          starts.push({
            index: item.phraseIndex,
            gesture: item.performance.gestures[0].name,
            clock: player.context.currentTime,
          }),
        phraseTime: () => {},
        ended: () => {
          completed++;
          resolveEnded();
        },
        failed: (error: Error) => failures.push(error.message),
      });
    try {
      begin();
      let ended = new Promise<void>((resolve) => {
        resolveEnded = resolve;
      });
      // Phrase 1 decodes first, but phrase 0 must still be played first.
      await Promise.all([player.enqueue(phrase(1)), player.enqueue(phrase(0))]);
      player.finish(2);
      await wait(300);
      await player.togglePause();
      const pausedAt = player.context.currentTime;
      await wait(200);
      const pauseDrift = player.context.currentTime - pausedAt;
      await player.togglePause();
      await ended;
      const firstStarts = [...starts];

      begin();
      ended = new Promise<void>((resolve) => {
        resolveEnded = resolve;
      });
      await Promise.all([player.enqueue(phrase(0)), player.enqueue(phrase(1))]);
      player.finish(2);
      await ended;
      const replayStarts = starts.slice(2);

      begin();
      await Promise.all([player.enqueue(phrase(0)), player.enqueue(phrase(1))]);
      player.finish(2);
      await wait(200);
      player.stop();
      const startsAtStop = starts.length;
      await wait(1200);
      return {
        firstStarts,
        replayStarts,
        pauseDrift,
        completed,
        startsAtStop,
        finalStarts: starts.length,
        failures,
      };
    } finally {
      player.dispose();
    }
  });
  assert.deepEqual(
    result.firstStarts.map((item) => item.index),
    [0, 1],
  );
  assert.deepEqual(
    result.firstStarts.map((item) => item.gesture),
    ['wave', 'nod'],
  );
  assert.ok(Math.abs(result.firstStarts[1].clock - result.firstStarts[0].clock - 1) < 0.05);
  assert.ok(result.pauseDrift < 0.005);
  assert.deepEqual(
    result.replayStarts.map((item) => item.gesture),
    ['wave', 'nod'],
  );
  assert.equal(result.completed, 2);
  assert.equal(result.finalStarts, result.startsAtStop);
  assert.deepEqual(result.failures, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'out-of-order fetch preserves phrase order',
          'gesture starts at phrase audio time',
          'pause freezes audio clock',
          'replay keeps performance',
          'Stop cancels future phrases',
        ],
        result,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
