import { spawn, type ChildProcess } from 'node:child_process';
import { readConfig, appRoot } from '../backend/src/config.js';
import { SpeechServiceLauncher } from './services/launcher.js';

let dev: ChildProcess | undefined;
let stopping = false;
const services = new SpeechServiceLauncher(readConfig(), {}, (error) => {
  console.error(error.message);
  process.exitCode = 1;
  void stop();
});

async function stop() {
  if (stopping) return;
  stopping = true;
  if (dev?.pid && dev.exitCode === null && dev.signalCode === null) {
    if (process.platform === 'win32') dev.kill('SIGTERM');
    else {
      // npm/concurrently/watchers are all in the process group we created.
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
  }
  await services.stop();
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  await services.start();
  if (!stopping) {
    dev = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
      cwd: appRoot,
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
    });
    dev.once('error', (error) => {
      console.error(`Unable to launch npm: ${error.message}`);
      process.exitCode = 1;
      void stop();
    });
    dev.once('exit', (code) => {
      if (!stopping) process.exitCode = code ?? 1;
      void stop();
    });
  }
} catch (error) {
  if (!stopping) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
  await stop();
}
