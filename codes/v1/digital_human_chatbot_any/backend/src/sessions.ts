import { randomUUID } from 'node:crypto';
import type { EventPayload, ServerEvent, Language } from '@digital-human/shared';
import type { ChatMessage } from './services/llm.js';

export type ActiveTurn = {
  id: string;
  controller: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  mediaIds?: Set<string>;
  playbackStarted?: boolean;
  speechFinished?: boolean;
};

export class Session {
  id = randomUUID();
  seq = 0;
  history: ChatMessage[] = [];
  active?: ActiveTurn;
  touched = Date.now();
  connection?: object;
  transcription?: AbortController;
  language: Language = 'en';

  constructor(private emit: (event: ServerEvent) => void = () => {}) {}

  attach(emit: (event: ServerEvent) => void) {
    this.emit = emit;
    this.touched = Date.now();
  }

  send(payload: EventPayload, turnId: string | null = this.active?.id ?? null) {
    this.touched = Date.now();
    this.emit({ ...payload, sessionId: this.id, turnId, seq: ++this.seq } as ServerEvent);
  }

  valid(turn: ActiveTurn) {
    return this.active === turn && !turn.controller.signal.aborted;
  }

  finish(turn: ActiveTurn) {
    if (this.active !== turn) return;
    clearTimeout(turn.timeout);
    this.active = undefined;
    this.send({ type: 'turn.completed' }, turn.id);
  }

  stop() {
    const turn = this.active;
    if (!turn) return;
    this.active = undefined;
    clearTimeout(turn.timeout);
    turn.controller.abort();
    this.send({ type: 'turn.interrupted' }, turn.id);
    return turn;
  }

  reset() {
    const turn = this.stop();
    this.transcription?.abort();
    this.history = [];
    this.language = 'en';
    this.send({ type: 'session.reset' }, null);
    return turn;
  }
}
