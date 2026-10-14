import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ReplyDiagnostic } from '@digital-human/shared';
import type { Config } from '../config.js';
import type { Session } from '../sessions.js';

/** Local troubleshooting artifacts contain request bodies and model output,
 * never authorization headers or configuration credentials. */
export async function saveReplyDiagnostic(
  config: Config,
  session: Session,
  data: Omit<ReplyDiagnostic, 'id' | 'createdAt' | 'downloadUrl' | 'model'>,
): Promise<ReplyDiagnostic> {
  const id = randomUUID();
  const diagnostic: ReplyDiagnostic = {
    ...data,
    id,
    createdAt: new Date().toISOString(),
    model: config.LLM_MODEL_NAME,
    downloadUrl: `/api/sessions/${session.id}/diagnostics/${id}`,
  };
  session.diagnostics = [...session.diagnostics, diagnostic].slice(-10);
  const dir = path.join(config.mediaDir, 'diagnostics');
  try {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${id}.json`);
    await writeFile(file, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
    // Bound disk retention across sessions and restarts.
    const files = (await readdir(dir)).filter((name) => /^\d+-[0-9a-f-]+\.json$/.test(name)).sort();
    await Promise.all(
      files
        .slice(0, Math.max(0, files.length - 100))
        .map((name) => rm(path.join(dir, name), { force: true })),
    );
    console.error(`LLM reply diagnostic: ${file} (${data.reason})`);
  } catch {
    console.error(
      `LLM reply diagnostic ${id}: disk write failed; raw output is available in the browser.`,
    );
  }
  return diagnostic;
}
