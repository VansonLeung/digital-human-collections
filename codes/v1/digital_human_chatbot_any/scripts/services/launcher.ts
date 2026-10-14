import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'dotenv';
import { appRoot, type Config } from '../../backend/src/config.js';

type ServicePlan = {
  name: 'ASR' | 'TTS';
  url: URL;
  cwd: string;
  entry: string;
  python: string;
  env: NodeJS.ProcessEnv;
};

export type LauncherOptions = {
  servicesRoot?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollMs?: number;
  shutdownMs?: number;
  log?: (message: string) => void;
};

function expandHome(value: string) {
  return value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;
}

/** These are direct Python HTTP services; remote endpoints can only be reused. */
function localAddress(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    return undefined;
  return { host: host === 'localhost' ? '127.0.0.1' : host, port: url.port || '80' };
}

async function probe(url: URL, signal: AbortSignal) {
  try {
    const response = await fetch(new URL('health', url), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const health = (await response.json()) as { status?: unknown };
    return health.status === 'ready'; // busy services are already loaded too
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

function portOccupied(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (occupied: boolean) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(1500, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code !== 'ECONNREFUSED'));
  });
}

async function plans(config: Config, options: LauncherOptions): Promise<ServicePlan[]> {
  const env = options.env ?? process.env;
  const root = options.servicesRoot ?? path.resolve(appRoot, '../services');
  return Promise.all(
    (['ASR', 'TTS'] as const).map(async (name) => {
      const url = new URL(name === 'ASR' ? config.ASR_BASE_URL : config.TTS_BASE_URL);
      if (url.username || url.password || url.search || url.hash)
        throw new Error(
          `${name}_BASE_URL must not contain credentials, query parameters or fragments.`,
        );
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      const cwd = path.join(root, name.toLowerCase());
      let settings: Record<string, string> = {};
      try {
        settings = parse(await readFile(path.join(cwd, '.env')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const python = expandHome(
        env.PYTHON_BIN ||
          env.PYTHON_BASE ||
          settings.PYTHON_BASE ||
          path.join(os.homedir(), '.common-venv/python3.12/bin/python'),
      );
      const address = localAddress(url);
      return {
        name,
        url,
        cwd,
        python,
        entry: `${name.toLowerCase()}_api.py`,
        env: {
          ...env,
          PYTHONUNBUFFERED: '1',
          // The app's URL determines where launched workers must listen. Model and
          // inference settings continue to come from each worker's own .env file.
          ...(address ? { [`${name}_HOST`]: address.host, [`${name}_PORT`]: address.port } : {}),
        },
      };
    }),
  );
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Foreground supervisor owns only new workers, including cleanup after failure. */
export class SpeechServiceLauncher {
  private children = new Set<ChildProcess>();
  private controller = new AbortController();
  private stopping = false;
  private shutdown?: Promise<void>;
  private log: (message: string) => void;

  constructor(
    private config: Config,
    private options: LauncherOptions = {},
    private onFailure: (error: Error) => void = () => {},
  ) {
    this.log = options.log ?? console.log;
  }

  async start(dryRun = false) {
    const servicePlans = await plans(this.config, this.options);
    const timeoutMs =
      this.options.timeoutMs ??
      Number(
        this.options.env?.SERVICE_START_TIMEOUT_SECONDS ??
          process.env.SERVICE_START_TIMEOUT_SECONDS ??
          300,
      ) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('SERVICE_START_TIMEOUT_SECONDS must be a positive number.');
    if (dryRun) {
      for (const plan of servicePlans) {
        this.log(`${plan.name}: ${plan.url.href}`);
        this.log(`  Python: ${plan.python}`);
        this.log(`  Directory: ${plan.cwd}`);
        this.log(`  Entry: ${plan.entry}${localAddress(plan.url) ? '' : ' (remote; reuse only)'}`);
      }
      return;
    }
    try {
      // Preflight both workers before launching either of them.
      const actions = await Promise.all(
        servicePlans.map(async (plan) => {
          if (await probe(plan.url, this.controller.signal)) return { plan, reuse: true };
          const address = localAddress(plan.url);
          if (!address)
            throw new Error(
              `${plan.name} is unavailable at ${plan.url.href}. Start this remote service separately.`,
            );
          if (await portOccupied(address.host, Number(address.port)))
            throw new Error(
              `${plan.name}: port ${address.port} is occupied but /health is not ready. Wait for the existing worker or inspect its logs.`,
            );
          await access(path.join(plan.cwd, plan.entry));
          if (plan.python.includes(path.sep)) {
            try {
              await access(path.resolve(plan.cwd, plan.python), constants.X_OK);
            } catch {
              throw new Error(
                `${plan.name}: Python executable is unavailable at ${plan.python}. Set PYTHON_BIN or the service's PYTHON_BASE.`,
              );
            }
          }
          return { plan, reuse: false };
        }),
      );
      this.controller.signal.throwIfAborted();
      for (const { plan, reuse } of actions) {
        if (reuse) this.log(`${plan.name} is already ready at ${plan.url.href}; reusing it.`);
        else this.launch(plan);
      }
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]);
      await Promise.all(
        actions
          .filter((action) => !action.reuse)
          .map(async ({ plan }) => {
            while (!(await probe(plan.url, signal)))
              await delay(this.options.pollMs ?? 500, signal);
            this.log(`${plan.name} ready at ${plan.url.href}`);
          }),
      );
      this.controller.signal.throwIfAborted();
      this.log('ASR and TTS are ready. Ctrl+C stops workers started by this command.');
    } catch (error) {
      await this.stop();
      if ((error as Error).name === 'TimeoutError')
        throw new Error(
          `Speech services did not become ready within ${timeoutMs / 1000}s. Inspect Python output or increase SERVICE_START_TIMEOUT_SECONDS.`,
        );
      throw error;
    }
  }

  private launch(plan: ServicePlan) {
    this.log(`Starting ${plan.name} at ${plan.url.href} with ${plan.python}`);
    const child = spawn(plan.python, [plan.entry], {
      cwd: plan.cwd,
      env: plan.env,
      stdio: 'inherit',
    });
    this.children.add(child);
    const fail = (message: string) => {
      if (this.stopping) return;
      const error = new Error(message);
      this.controller.abort(error);
      this.onFailure(error);
      void this.stop();
    };
    child.once('error', (error) => fail(`${plan.name} could not start: ${error.message}`));
    child.once('exit', (code, signal) => {
      this.children.delete(child);
      fail(`${plan.name} exited (${signal ?? `code ${code}`}). Inspect Python output above.`);
    });
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.controller.abort(new Error('Service startup cancelled.'));
    this.shutdown = Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
              resolve();
              return;
            }
            const timer = setTimeout(() => child.kill('SIGKILL'), this.options.shutdownMs ?? 5000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill('SIGTERM');
          }),
      ),
    ).then(() => {});
    return this.shutdown;
  }
}
