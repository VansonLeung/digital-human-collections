import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { cueSchema, type Language } from '@digital-human/shared';
import type { Config } from '../config.js';
import { stageSignal } from './http.js';

const outputSchema = z.object({
  mouthCues: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        value: cueSchema.shape.shape,
      }),
    )
    .max(40000),
});

export async function runProcess(binary: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(path.isAbsolute(binary) ? { cwd: path.dirname(binary) } : {}),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.length > 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      err = (err + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`Rhubarb exited with code ${code}`)),
    );
  });
}

export async function mouthCues(
  config: Config,
  wavPath: string,
  language: Language,
  parent: AbortSignal,
) {
  const output = `${wavPath}.json`;
  await runProcess(
    config.RHUBARB_BIN,
    [
      '-r',
      language === 'en' ? config.RHUBARB_ENGLISH_RECOGNIZER : 'phonetic',
      '-f',
      'json',
      '--threads',
      '2',
      '-o',
      output,
      wavPath,
    ],
    stageSignal(parent, config.LIPSYNC_TIMEOUT_SECONDS),
  );
  const result = outputSchema.parse(JSON.parse(await readFile(output, 'utf8')));
  return result.mouthCues
    .map((c) => ({ start: c.start, end: c.end, shape: c.value }))
    .filter((c) => c.end >= c.start);
}

export async function rhubarbAvailable(config: Config) {
  try {
    await runProcess(config.RHUBARB_BIN, ['--version'], AbortSignal.timeout(3000));
    return true;
  } catch {
    return false;
  }
}
