import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Known silence / tone / silence exercises actual Web Audio in Chrome without TTS.
const rate = 24000;
const seconds = 2;
const wav = Buffer.alloc(44 + rate * seconds * 2);

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

for (let i = 0; i < rate * seconds; i++) {
  const time = i / rate;
  const value = time >= 0.35 && time < 1.2 ? 0.12 * Math.sin(2 * Math.PI * 220 * time) : 0;
  wav.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
}

const loudWav = Buffer.from(wav);
for (let offset = 44; offset < loudWav.length; offset += 2)
  loudWav.writeInt16LE(Math.round(wav.readInt16LE(offset) * 6.5), offset);

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
      res.end(req.url?.includes('loud') ? loudWav : wav);
    };
    if (req.url.includes('delay')) setTimeout(send, 250);
    else send();
    return;
  }
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>Playback checks</body></html>');
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
  // tsx preserves function names with this helper inside serialized callbacks.
  await page.evaluate('globalThis.__name = (value) => value');
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/audio/playback.ts';
    const { SpeechPlayer } = await import(moduleUrl);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let opening = 0;
    let shape = 'X';
    let ended = 0;
    let started = 0;
    let talking = false;
    const player = new SpeechPlayer(
      (value: string) => {
        shape = value;
        opening = 0;
      },
      (value: number) => {
        opening = value;
      },
      (value: boolean) => {
        talking = value;
      },
    );
    const begin = () => {
      started++;
    };
    const end = () => {
      ended++;
    };
    try {
      await player.play('/voice.wav', [], begin, end, 'amplitude');
      await wait(200);
      const silence = opening;
      const silenceTalking = talking;
      await wait(400);
      const voiced = opening;
      player.setMuted(true);
      await wait(120);
      const muted = opening;
      await player.togglePause();
      await wait(120);
      const paused = opening;
      const pauseTalking = talking;
      await player.togglePause();
      await wait(120);
      const resumed = opening;
      const resumeTalking = talking;
      player.stop();
      await wait(120);
      const stopped = opening;
      const stopEnded = ended;
      const stopTalking = talking;
      await player.play('/voice.wav', [], begin, end, 'amplitude');
      await wait(1750);
      const tailSilence = opening;
      await wait(500);
      const naturalEnded = ended;
      const naturalClosed = opening;
      const naturalTalking = talking;
      await player.play('/voice.wav', [{ start: 0, end: 2, shape: 'D' }], begin, end, 'rhubarb');
      await wait(120);
      const legacyShape = shape;
      player.stop();
      const startsBeforeCancel = started;
      const pending = player.play('/voice.wav?delay', [], begin, end, 'amplitude');
      await wait(80);
      player.stop();
      await pending;
      return {
        silence,
        voiced,
        muted,
        paused,
        resumed,
        stopped,
        stopEnded,
        tailSilence,
        naturalEnded,
        naturalClosed,
        legacyShape,
        canceledStarts: started - startsBeforeCancel,
        silenceTalking,
        pauseTalking,
        resumeTalking,
        stopTalking,
        naturalTalking,
        canceledTalking: talking,
      };
    } finally {
      player.dispose();
    }
  });
  assert.equal(result.silence, 0);
  assert.ok(result.voiced > 0.15);
  assert.ok(result.muted > 0.15);
  assert.equal(result.paused, 0);
  assert.ok(result.resumed > 0.15);
  assert.equal(result.stopped, 0);
  assert.equal(result.stopEnded, 0);
  assert.ok(result.tailSilence < 0.02);
  assert.equal(result.naturalEnded, 1);
  assert.equal(result.naturalClosed, 0);
  assert.equal(result.legacyShape, 'D');
  assert.equal(result.canceledStarts, 0);
  assert.equal(result.silenceTalking, true);
  assert.equal(result.pauseTalking, false);
  assert.equal(result.resumeTalking, true);
  assert.equal(result.stopTalking, false);
  assert.equal(result.naturalTalking, false);
  assert.equal(result.canceledTalking, false);
  const volume = await page.evaluate(async () => {
    const moduleUrl = '/src/audio/playback.ts';
    const { SpeechPlayer } = await import(moduleUrl);
    const player = new SpeechPlayer(
      () => {},
      () => {},
      () => {},
      1.8,
    );
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      await player.play(
        '/voice.wav',
        [],
        () => {},
        () => {},
        'amplitude',
      );
      const probe = player.context.createAnalyser();
      probe.fftSize = 2048;
      player.gain.connect(probe);
      const peak = () => {
        const samples = new Float32Array(probe.fftSize);
        probe.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      };
      await wait(600);
      const boostedPeak = peak();
      player.setMuted(true);
      await wait(120);
      const mutedPeak = peak();
      player.setMuted(false);
      await wait(120);
      const unmutedPeak = peak();
      player.stop();
      await player.play(
        '/voice.wav?loud',
        [],
        () => {},
        () => {},
        'amplitude',
      );
      await wait(600);
      return { boostedPeak, mutedPeak, unmutedPeak, limitedPeak: peak() };
    } finally {
      player.dispose();
    }
  });
  assert.ok(Math.abs(volume.boostedPeak - 0.12 * 1.8) < 0.005);
  assert.equal(volume.mutedPeak, 0);
  assert.ok(Math.abs(volume.unmutedPeak - volume.boostedPeak) < 0.005);
  assert.ok(volume.limitedPeak > 0.95 && volume.limitedPeak < 0.99);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'silence closes mouth',
          'audio opens mouth',
          'mute preserves animation',
          'pause closes and resume restores',
          'Stop closes without completion',
          'natural completion',
          'Rhubarb playback',
          'Stop during audio fetch',
          'male playback boost survives mute and unmute',
          'loud male clips retain peak headroom',
        ],
        measurements: result,
        volume,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
