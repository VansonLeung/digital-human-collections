import { randomUUID } from 'node:crypto';
import { VirtualScene } from './scenes/VirtualScene.js';
import type { EventPayload, ServerEvent, Language, ReplyDiagnostic } from '@digital-human/shared';
import type { ChatMessage } from './services/llm.js';

export type ActiveTurn = {
  id: string;
  controller: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  mediaIds?: Set<string>;
  playbackStarted?: boolean;
  speechFinished?: boolean;
  succeeded?: boolean;
  sceneVersion?: number;
  origin?: 'user' | 'proactive';
};

export class Session {
  id = randomUUID();
  seq = 0;
  history: ChatMessage[] = [];
  scene = new VirtualScene();
  active?: ActiveTurn;
  touched = Date.now();
  connection?: object;
  transcription?: AbortController;
  language: Language = 'en';
  revision = 0;
  suggestion?: AbortController;
  userSpeech?: AbortController;
  diagnostics: ReplyDiagnostic[] = [];
  proactive = { enabled: false, delaySeconds: 60, eligible: false, lastActivity: Date.now() };

  constructor(private emit: (event: ServerEvent) => void = () => {}) {}

  attach(emit: (event: ServerEvent) => void) {
    this.emit = emit;
    this.touched = Date.now();
  }

  send(payload: EventPayload, turnId: string | null = this.active?.id ?? null) {
    this.touched = Date.now();
    this.emit({
      ...payload,
      sessionId: this.id,
      turnId,
      seq: ++this.seq,
      revision: this.revision,
    } as ServerEvent);
  }

  valid(turn: ActiveTurn) {
    return this.active === turn && !turn.controller.signal.aborted;
  }

  finish(turn: ActiveTurn) {
    if (this.active !== turn) return;
    clearTimeout(turn.timeout);
    this.active = undefined;
    this.proactive.lastActivity = Date.now();
    if (turn.succeeded && turn.sceneVersion !== undefined)
      this.scene.completeTurn(turn.sceneVersion);
    this.send({ type: 'turn.completed' }, turn.id);
  }

  configureScenes(enabled: boolean) {
    if (this.scene.configure(enabled))
      this.send({ type: 'scene.state', scene: this.scene.snapshot() }, null);
  }

  decideScene(input: { proposalId: string; version: number; revision: number; accept: boolean }) {
    if (this.active || this.transcription || input.revision !== this.revision) return false;
    const result = this.scene.decide(input.proposalId, input.version, input.accept);
    if (!result) return false;
    this.suggestion?.abort();
    this.userSpeech?.abort();
    this.revision++;
    this.proactive.lastActivity = Date.now();
    if (result.step) this.send({ type: 'scene.step', ...result.step }, null);
    this.send({ type: 'scene.state', scene: this.scene.snapshot() }, null);
    return true;
  }

  activity() {
    this.proactive.lastActivity = Date.now();
    this.suggestion?.abort();
    if (this.active?.origin === 'proactive') this.stop();
  }

  stop() {
    this.suggestion?.abort();
    this.userSpeech?.abort();
    this.proactive.eligible = false;
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
    this.scene.reset();
    this.revision++;
    this.diagnostics = [];
    this.language = 'en';
    this.send({ type: 'session.reset' }, null);
    this.send({ type: 'scene.state', scene: this.scene.snapshot() }, null);
    return turn;
  }
}
