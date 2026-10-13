import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class MediaStore {
  files = new Map<string, { sessionId: string; file: string; expires: number }>();

  constructor(
    public dir: string,
    private ttl: number,
  ) {}

  async initialize() {
    await mkdir(this.dir, { recursive: true });
    // Media identifiers are in memory; clean orphaned files from previous runs.
    for (const name of await readdir(this.dir))
      if (/^[0-9a-f-]+\.wav(?:\.json)?$/.test(name))
        await rm(path.join(this.dir, name), { force: true });
  }

  async create(sessionId: string, bytes: Buffer) {
    const id = randomUUID();
    const file = path.join(this.dir, `${id}.wav`);
    await writeFile(file, bytes);
    this.files.set(id, { sessionId, file, expires: Date.now() + this.ttl * 1000 });
    return { id, file };
  }

  get(sessionId: string, id: string) {
    const item = this.files.get(id);
    return item && item.sessionId === sessionId && item.expires > Date.now()
      ? item.file
      : undefined;
  }

  async remove(id: string) {
    const item = this.files.get(id);
    if (!item) return;
    this.files.delete(id);
    await Promise.all([rm(item.file, { force: true }), rm(`${item.file}.json`, { force: true })]);
  }

  async cleanup(sessionId?: string) {
    await Promise.all(
      [...this.files]
        .filter(([, v]) => (sessionId ? v.sessionId === sessionId : v.expires <= Date.now()))
        .map(([id]) => this.remove(id)),
    );
  }
}
