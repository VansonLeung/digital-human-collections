import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { readConfig, appRoot } from '../backend/src/config.js';

const config = readConfig();
const children: ChildProcess[] = [];

const python =
  process.env.PYTHON_BIN || path.join(os.homedir(), '.common-venv/python3.12/bin/python');

function launch(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('error', () => {
    console.error(`Unable to launch ${path.basename(command)}. Check PYTHON_BIN and setup.`);
    stop();
  });
  child.on('exit', (code) => {
    if (code && code !== 0) stop();
  });
}

let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}

for (const [name, url, entry] of [
  ['asr', config.ASR_BASE_URL, 'asr_api.py'],
  ['tts', config.TTS_BASE_URL, 'tts_api.py'],
]) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error();
    console.log(`${name.toUpperCase()} is already running; reusing it.`);
  } catch {
    launch(python, [entry], path.resolve(appRoot, '../services', name));
  }
}

launch(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], appRoot);

process.on('SIGINT', stop);

process.on('SIGTERM', stop);
