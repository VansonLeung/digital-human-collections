import { mkdir, readdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  savedConversationSchema,
  type SavedConversation,
  type ConversationSummary,
} from '@digital-human/shared';

export class ConversationConflict extends Error {
  constructor() {
    super(
      'This saved conversation changed in another tab. Reload it before continuing; your current transcript is still available to export.',
    );
  }
}
export function conversationSummary(value: SavedConversation): ConversationSummary {
  const { id, version, title, createdAt, updatedAt, messages } = value;
  return { id, version, title, createdAt, updatedAt, messageCount: messages.length };
}

/** Atomic local files; never delete chats as part of session or audio expiry. */
export class ConversationStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(public readonly directory: string) {}

  async get(id: string): Promise<SavedConversation | undefined> {
    if (!z.uuid().safeParse(id).success) return undefined;
    const file = path.join(this.directory, `${id}.json`);
    try {
      if ((await stat(file)).size > 32 * 1024 * 1024)
        throw new Error('Saved conversation exceeds the size limit.');
      const value = savedConversationSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (value.id !== id) throw new Error('Saved conversation id does not match its file.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async list() {
    await this.pending;
    await mkdir(this.directory, { recursive: true });
    const result: ConversationSummary[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const item = await this.get(name.slice(0, -5));
        if (item) result.push(conversationSummary(item));
      } catch {
        /* One damaged file must not hide the other conversations. */
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  save(value: SavedConversation, expectedVersion: number) {
    const snapshot = savedConversationSchema.parse(structuredClone(value));
    const write = async () => {
      await mkdir(this.directory, { recursive: true });
      const previous = await this.get(snapshot.id);
      if ((previous?.version ?? 0) !== expectedVersion) throw new ConversationConflict();
      const next = {
        ...snapshot,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      const body = JSON.stringify(next, null, 2);
      if (Buffer.byteLength(body) > 32 * 1024 * 1024)
        throw new Error(
          'Saved conversation exceeds the size limit. Export it and start a new chat.',
        );
      const target = path.join(this.directory, `${snapshot.id}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return next;
    };
    const result = this.pending.then(write, write);
    this.pending = result.catch(() => {});
    return result;
  }
  async flush() {
    await this.pending;
  }
}
