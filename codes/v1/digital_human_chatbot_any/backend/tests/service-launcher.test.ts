import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, access, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readConfig } from '../src/config.js';
import { SpeechServiceLauncher } from '../../scripts/services/launcher.js';

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function fixture(mode: 'ready' | 'timeout' | 'exit' = 'ready') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-launcher-'));
  const ports = await Promise.all([freePort(), freePort()]);
  for (const name of ['asr', 'tts']) {
    const dir = path.join(root, name);
    await mkdir(dir);
    await writeFile(
      path.join(dir, '.env'),
      `PYTHON_BASE=${process.execPath}\n${name.toUpperCase()}_PORT=1\n`,
    );
    // No MLX dependencies/model downloads: Node executes this test worker with
    // the same entrypoint/path/environment convention used by the Python APIs.
    await writeFile(
      path.join(dir, `${name}_api.py`),
      `
const http=require('node:http'),fs=require('node:fs');
const name=${JSON.stringify(name.toUpperCase())};
let ready=false;
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:ready?'ready':'starting',busy:false}));});
server.listen(Number(process.env[name+'_PORT']),process.env[name+'_HOST']);
if(${JSON.stringify(mode)}!=='timeout')setTimeout(()=>{ready=true;},100);
if(${JSON.stringify(mode)}==='exit' && name==='ASR')setTimeout(()=>process.exit(7),900);
process.on('SIGTERM',()=>{fs.writeFileSync('stopped','yes');server.close(()=>process.exit(0));});
// Publish startup only after this fixture can observe graceful shutdown.
fs.writeFileSync('started.json',JSON.stringify({cwd:process.cwd(),port:process.env[name+'_PORT'],host:process.env[name+'_HOST'],unbuffered:process.env.PYTHONUNBUFFERED}));
`,
    );
  }
  const config = readConfig({
    ASR_BASE_URL: `http://127.0.0.1:${ports[0]}`,
    TTS_BASE_URL: `http://127.0.0.1:${ports[1]}`,
  });
  const log: string[] = [];
  const failures: Error[] = [];
  const launcher = new SpeechServiceLauncher(
    config,
    {
      servicesRoot: root,
      env: { PATH: process.env.PATH },
      pollMs: 20,
      timeoutMs: 3000,
      shutdownMs: 500,
      log: (message) => log.push(message),
    },
    (error) => failures.push(error),
  );
  return {
    root,
    config,
    log,
    failures,
    launcher,
    async close() {
      await launcher.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('starts both workers with their own Python settings, matches app ports, and stops owned processes', async () => {
  const f = await fixture();
  try {
    await f.launcher.start();
    for (const [name, url] of [
      ['asr', f.config.ASR_BASE_URL],
      ['tts', f.config.TTS_BASE_URL],
    ]) {
      const details = JSON.parse(await readFile(path.join(f.root, name, 'started.json'), 'utf8'));
      assert.equal(details.cwd, await realpath(path.join(f.root, name)));
      assert.equal(details.port, new URL(url).port);
      assert.equal(details.host, '127.0.0.1');
      assert.equal(details.unbuffered, '1');
      assert.equal((await (await fetch(`${url}/health`)).json()).status, 'ready');
    }
    assert.ok(f.log.some((message) => message.startsWith('ASR ready')));
    assert.ok(f.log.some((message) => message.startsWith('TTS ready')));
    await f.launcher.stop();
    for (const name of ['asr', 'tts'])
      assert.equal(await readFile(path.join(f.root, name, 'stopped'), 'utf8'), 'yes');
    assert.deepEqual(f.failures, []);
  } finally {
    await f.close();
  }
});

test('reuses ready/busy services and leaves them running after launcher shutdown', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ready', busy: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const f = await fixture();
  const launcher = new SpeechServiceLauncher(
    { ...f.config, ASR_BASE_URL: url, TTS_BASE_URL: url },
    { servicesRoot: f.root, env: { PYTHON_BIN: '/missing/python' }, log: () => {} },
  );
  try {
    await launcher.start();
    await launcher.stop();
    assert.equal((await fetch(`${url}/health`)).status, 200);
    await assert.rejects(access(path.join(f.root, 'asr', 'started.json')));
  } finally {
    await launcher.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('dry run expands home paths and PYTHON_BIN overrides each worker without starting it', async () => {
  const f = await fixture();
  const logs: string[] = [];
  const launcher = new SpeechServiceLauncher(f.config, {
    servicesRoot: f.root,
    env: { PYTHON_BIN: '~/custom/bin/python' },
    log: (message) => logs.push(message),
  });
  try {
    await launcher.start(true);
    assert.equal(
      logs.filter(
        (message) => message === `  Python: ${path.join(os.homedir(), 'custom/bin/python')}`,
      ).length,
      2,
    );
    await assert.rejects(access(path.join(f.root, 'asr', 'started.json')));
    await launcher.stop();
  } finally {
    await f.close();
  }
});

test('preflight rejects occupied unhealthy ports before launching another worker', async () => {
  const f = await fixture();
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) =>
    server.listen(Number(new URL(f.config.ASR_BASE_URL).port), '127.0.0.1', resolve),
  );
  try {
    await assert.rejects(f.launcher.start(), /occupied but \/health is not ready/);
    await assert.rejects(access(path.join(f.root, 'tts', 'started.json')));
    assert.equal((await fetch(`${f.config.ASR_BASE_URL}/health`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('startup timeout cleans up both workers', async () => {
  const f = await fixture('timeout');
  const launcher = new SpeechServiceLauncher(f.config, {
    servicesRoot: f.root,
    env: { PATH: process.env.PATH },
    pollMs: 20,
    timeoutMs: 700,
    shutdownMs: 500,
    log: () => {},
  });
  try {
    await assert.rejects(launcher.start(), /did not become ready/);
    for (const name of ['asr', 'tts'])
      assert.equal(await readFile(path.join(f.root, name, 'stopped'), 'utf8'), 'yes');
  } finally {
    await launcher.stop();
    await f.close();
  }
});

test('an unexpected worker exit stops the companion worker', async () => {
  const f = await fixture('exit');
  try {
    await f.launcher.start();
    for (let attempt = 0; attempt < 100 && !f.failures.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(f.failures[0]?.message ?? '', /ASR exited \(code 7\)/);
    await f.launcher.stop();
    assert.equal(await readFile(path.join(f.root, 'tts', 'stopped'), 'utf8'), 'yes');
  } finally {
    await f.close();
  }
});

test('cancelling startup stops both workers while they are still loading', async () => {
  const f = await fixture('timeout');
  try {
    // Observe the rejection immediately; stopping before readiness is expected.
    const work = assert.rejects(f.launcher.start(), /startup cancelled/);
    for (const name of ['asr', 'tts']) {
      let started = false;
      for (let attempt = 0; attempt < 100 && !started; attempt++) {
        try {
          await access(path.join(f.root, name, 'started.json'));
          started = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(started, `${name} worker should have started`);
    }
    await f.launcher.stop();
    await work;
    for (const name of ['asr', 'tts'])
      assert.equal(await readFile(path.join(f.root, name, 'stopped'), 'utf8'), 'yes');
  } finally {
    await f.close();
  }
});

test('unavailable remote endpoints are never launched locally', async () => {
  const f = await fixture();
  const launcher = new SpeechServiceLauncher(
    { ...f.config, ASR_BASE_URL: f.config.ASR_BASE_URL + '/remote/' },
    { servicesRoot: f.root, log: () => {} },
  );
  try {
    await assert.rejects(launcher.start(), /Start this remote service separately/);
    await assert.rejects(access(path.join(f.root, 'tts', 'started.json')));
  } finally {
    await launcher.stop();
    await f.close();
  }
});
