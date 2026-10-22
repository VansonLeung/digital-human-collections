import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { savedConversationSchema } from '@digital-human/shared';
import { readConfig } from '../backend/src/config.js';
import { Session } from '../backend/src/sessions.js';
import { ConversationStore } from '../backend/src/history/ConversationStore.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: npm run import:conversation -- path/to/conversation.json');
const data = JSON.parse(await readFile(file, 'utf8'));
const config = readConfig();
const store = new ConversationStore(path.join(config.mediaDir, 'conversations'));
const now = new Date().toISOString();
const archived = savedConversationSchema.safeParse(data);
let value;
if (archived.success) {
  // Imports always create a copy and cannot overwrite an existing conversation.
  value = { ...archived.data, id: randomUUID(), version: 0, createdAt: now, updatedAt: now };
} else {
  const transcript = z
    .object({
      title: z.string().min(1).max(100).optional(),
      language: z.enum(['en', 'zh', 'yue']).default('yue'),
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            phrases: z.array(z.string().min(1).max(600)).min(1).max(32),
            generated: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(10000),
    })
    .parse(data);
  const session = new Session();
  session.configureScenes(true);
  let user: (typeof transcript.messages)[number] | undefined;
  for (const message of transcript.messages) {
    if (message.role === 'user') {
      if (user) throw new Error('Transcript has consecutive user turns without a reply.');
      user = message;
      continue;
    }
    session.archive.complete({
      id: randomUUID(),
      input: user?.phrases.join(' '),
      userPhrases: user?.phrases,
      // Pasted transcripts do not establish whether a user turn was manually
      // supplied or automatically drafted. Preserve uncertainty unless marked.
      generated: user ? (user.generated ?? true) : undefined,
      phrases: message.phrases,
      text: message.phrases.join(' '),
      personaName: 'Mira',
      settings: {
        personaId: 'constraint-twist',
        language: transcript.language,
        displayMode: 'phrases',
        virtualScenesEnabled: true,
      },
    });
    user = undefined;
  }
  if (user)
    throw new Error('Transcript ends with an unanswered user turn. Save completed exchanges only.');
  const snapshot = session.archive.snapshot();
  if (!snapshot) throw new Error('Transcript has no completed reply.');
  value = {
    ...snapshot,
    settingsCaptured: false,
    title: transcript.title ?? snapshot.title,
    state: { ...snapshot.state, language: transcript.language },
  };
}
const saved = await store.save(value, 0);
console.log(
  JSON.stringify(
    {
      id: saved.id,
      title: saved.title,
      bubbles: saved.messages.length,
      url: `http://${config.APP_HOST}:${config.APP_PORT}/conversations/${saved.id}`,
    },
    null,
    2,
  ),
);
