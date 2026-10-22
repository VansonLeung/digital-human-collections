import { randomUUID } from 'node:crypto';
import {
  conversationSettingsSchema,
  savedConversationSchema,
  type SavedConversation,
  type EventPayload,
  type SavedMessage,
  type SceneStep,
} from '@digital-human/shared';
import type { ChatMessage } from '../llm/requestMessages.js';
import { ConversationStore, conversationSummary } from './ConversationStore.js';

type CompletedTurn = {
  id: string;
  input?: string;
  userPhrases?: string[];
  generated?: boolean;
  phrases: string[];
  text: string;
  personaName: string;
  settings: unknown;
};

/** Full transcript on disk; the LLM still receives only its bounded context. */
export class ConversationArchive {
  store?: ConversationStore;
  private record?: SavedConversation;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private state: () => SavedConversation['state'],
    private emit: (event: EventPayload) => void,
  ) {}

  get id() {
    return this.record?.id;
  }
  restore(value: SavedConversation) {
    this.record = savedConversationSchema.parse(value);
  }
  reset() {
    this.record = undefined;
  }
  snapshot() {
    return this.record ? structuredClone({ ...this.record, state: this.state() }) : undefined;
  }
  context(): ChatMessage[] {
    const messages: (ChatMessage & { turnId?: string })[] = [];
    for (const item of this.record?.messages ?? []) {
      if (item.role === 'scene') continue;
      const previous = messages.at(-1);
      if (previous?.role === item.role && previous.turnId === item.turnId && item.turnId)
        previous.content += ` ${item.text}`;
      else
        messages.push({
          role: item.role,
          content: item.text,
          turnId: item.turnId,
          ...(item.role === 'user' && item.generated ? { generated: true } : {}),
        });
    }
    return messages.slice(-12).map(({ turnId: _turnId, ...message }) => message);
  }
  complete(turn: CompletedTurn) {
    const settings = conversationSettingsSchema.parse(turn.settings);
    if (!this.record) {
      const now = new Date().toISOString();
      this.record = {
        format: 'persona-conversation',
        schemaVersion: 1,
        id: randomUUID(),
        version: 0,
        title: (turn.input ?? turn.text).slice(0, 80).trim() || 'Conversation',
        createdAt: now,
        updatedAt: now,
        messages: [],
        settings,
        settingsCaptured: true,
        state: this.state(),
      };
    }
    const messages: SavedMessage[] = [];
    if (turn.input) {
      const phrases = turn.userPhrases?.join(' ') === turn.input ? turn.userPhrases : [turn.input];
      messages.push(
        ...phrases.map((text, index) => ({
          id: `${turn.id}:user:${index}`,
          turnId: turn.id,
          role: 'user' as const,
          text,
          ...(turn.generated ? { generated: true } : {}),
        })),
      );
    }
    const phrases =
      settings.displayMode === 'phrases' && turn.phrases.length ? turn.phrases : [turn.text];
    messages.push(
      ...phrases.map((text, index) => ({
        id: `${turn.id}:assistant:${index}`,
        turnId: turn.id,
        role: 'assistant' as const,
        text,
        personaName: turn.personaName,
      })),
    );
    this.record.messages.push(...messages);
    this.record.settings = settings;
    this.record.settingsCaptured = true;
  }
  sceneCard(id: string, step: SceneStep) {
    if (!this.record || this.record.messages.some((item) => item.id === id)) return;
    this.record.messages.push({ id, role: 'scene', text: step.narration, sceneStep: step });
  }
  schedule() {
    const id = this.id;
    void this.save().catch((error) => {
      if (id === this.id)
        this.emit({
          type: 'conversation.save_failed',
          message: error instanceof Error ? error.message : 'Conversation could not be saved.',
        });
    });
  }
  async save() {
    const record = this.record;
    const snapshot = this.snapshot();
    const store = this.store;
    if (!record || !snapshot || !store) return undefined;
    const write = async () => {
      const saved = await store.save(snapshot, record.version);
      record.version = saved.version;
      record.updatedAt = saved.updatedAt;
      if (this.record === record)
        this.emit({ type: 'conversation.saved', conversation: conversationSummary(saved) });
      return saved;
    };
    const result = this.pending.then(write, write);
    this.pending = result.catch(() => {});
    return result;
  }
  async flush() {
    await this.pending;
  }
}
