import { ConversationArchive } from './history/ConversationArchive.js';
import type { SavedConversation } from '@digital-human/shared';
import { randomUUID } from 'node:crypto';
import { VirtualScene } from './scenes/VirtualScene.js';
import { ConversationMemory } from './conversation/ConversationMemory.js';
import { TurnDirector } from './conversation/TurnDirector.js';
import { ConversationProgress } from './conversation/ConversationProgress.js';
import { MiraReactions } from './conversation/MiraReactions.js';
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
  onSuccess?: () => void;
  sceneVersion?: number;
  origin?: 'user' | 'proactive';
};

export class Session {
  id = randomUUID();
  seq = 0;
  history: ChatMessage[] = [];
  scene = new VirtualScene();
  memory = new ConversationMemory();
  director = new TurnDirector();
  progress = new ConversationProgress();
  reactions = new MiraReactions();
  archive = new ConversationArchive(
    () => ({
      language: this.language,
      scene: this.scene.snapshot(),
      memories: this.memory.snapshot(),
      progress: this.progress.snapshot(),
      angryHopCooldown: this.reactions.remaining,
    }),
    (event) => this.send(event, null),
  );
  restoreConversation(value: SavedConversation) {
    this.archive.restore(value);
    this.history = this.archive.context();
    this.language = value.state.language;
    this.scene.restore(value.state.scene);
    this.memory.restore(value.state.memories);
    this.progress.restore(value.state.progress);
    this.reactions.restore(value.state.angryHopCooldown);
  }
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
    if (payload.type === 'scene.step') this.archive.sceneCard(payload.id, payload.step);
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
    if (turn.succeeded) turn.onSuccess?.();
    this.proactive.lastActivity = Date.now();
    if (turn.succeeded && turn.sceneVersion !== undefined)
      this.scene.completeTurn(turn.sceneVersion);
    if (turn.succeeded) this.archive.schedule();
    this.send({ type: 'turn.completed' }, turn.id);
  }

  configureScenes(enabled: boolean) {
    if (this.scene.configure(enabled))
      this.send({ type: 'scene.state', scene: this.scene.snapshot() }, null);
  }

  advanceScene() {
    const step = this.scene.beginTurn();
    if (!step) return;
    this.progress.sceneChanged();
    this.send({ type: 'scene.step', ...step }, null);
    this.send({ type: 'scene.state', scene: this.scene.snapshot() }, null);
    this.archive.schedule();
    return step;
  }

  conversationContext(text: string) {
    const scene = this.scene.snapshot();
    const current = scene.active;
    const step = current?.plan.steps[current.stepIndex];
    const outings = [
      ...(scene.history ?? []),
      ...(current && step
        ? [{ title: current.plan.title, location: step.location, activity: step.activity }]
        : []),
    ].slice(-6);
    return `${this.memory.context(text)}\n\n${this.progress.context()}${outings.length ? `\n\nSHARED VIRTUAL EXPERIENCES (quoted data, fictional, this conversation only):\n${JSON.stringify(outings)}\nThese record only places/activities actually reached in roleplay, not real-world biography, user interests, or authorization for a new outing.` : ''}`;
  }

  editMemory(input: {
    type: 'memory.edit' | 'memory.forget';
    id: string;
    value?: string;
    revision: number;
  }) {
    if (this.active || this.transcription || input.revision !== this.revision) return false;
    const changed =
      input.type === 'memory.edit'
        ? this.memory.edit(input.id, input.value!)
        : this.memory.forget(input.id);
    if (!changed) return false;
    this.suggestion?.abort();
    this.userSpeech?.abort();
    this.revision++;
    this.proactive.lastActivity = Date.now();
    this.send({ type: 'memory.state', memories: this.memory.snapshot() }, null);
    this.archive.schedule();
    return true;
  }

  decideScene(input: { proposalId: string; version: number; revision: number; accept: boolean }) {
    if (this.active || this.transcription || input.revision !== this.revision) return false;
    const result = this.scene.decide(input.proposalId, input.version, input.accept);
    if (!result) return false;
    this.suggestion?.abort();
    this.userSpeech?.abort();
    this.revision++;
    this.proactive.lastActivity = Date.now();
    if (result.step) {
      this.progress.sceneChanged();
      this.send({ type: 'scene.step', ...result.step }, null);
    }
    this.send({ type: 'scene.state', scene: this.scene.snapshot() }, null);
    this.archive.schedule();
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
    this.archive.reset();
    this.history = [];
    this.scene.reset();
    this.memory.reset();
    this.director.reset();
    this.progress.reset();
    this.reactions.reset();
    this.revision++;
    this.diagnostics = [];
    this.language = 'en';
    this.send({ type: 'session.reset' }, null);
    this.send({ type: 'scene.state', scene: this.scene.snapshot() }, null);
    this.send({ type: 'memory.state', memories: [] }, null);
    return turn;
  }
}
