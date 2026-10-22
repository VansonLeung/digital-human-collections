import { z } from 'zod';

export const progressSchema = z.object({
  topic: z.string().trim().min(1).max(80),
  angle: z.string().trim().min(1).max(100),
  kind: z.enum(['detail', 'answer', 'decision', 'action', 'acknowledgment', 'repeat']),
  summary: z.string().trim().min(1).max(160),
  quote: z.string().trim().min(1).max(240),
  answeredQuestion: z.string().trim().min(1).max(160).optional(),
  pendingAction: z.string().trim().min(1).max(160).optional(),
});
export type ProgressUpdate = z.infer<typeof progressSchema>;
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
const questions = (text: string) =>
  (text.match(/[^。！？.!?\n]+[?？]/gu) ?? []).slice(-2).map((question) => question.trim());

/** Bounded conversational working state, separate from personal facts and scenes.
 * Model assessments are hints, backed by spoken evidence, never authorization. */
export class ConversationProgress {
  private turns: { topic: string; angle: string; kind: string; summary: string; quote: string }[] =
    [];
  private openQuestions: string[] = [];
  private answered: string[] = [];
  private pendingAction?: string;
  private stale = 0;
  private completed = 0;

  reset() {
    this.turns = [];
    this.openQuestions = [];
    this.answered = [];
    this.pendingAction = undefined;
    this.stale = this.completed = 0;
  }

  snapshot() {
    return structuredClone({
      turns: this.turns,
      openQuestions: this.openQuestions,
      answered: this.answered,
      pendingAction: this.pendingAction,
      stale: this.stale,
      completed: this.completed,
    });
  }

  restore(value: Record<string, unknown>) {
    const parsed = z
      .object({
        turns: z
          .array(
            progressSchema.pick({
              topic: true,
              angle: true,
              kind: true,
              summary: true,
              quote: true,
            }),
          )
          .max(8),
        openQuestions: z.array(z.string().max(4000)).max(6),
        answered: z.array(z.string().max(4000)).max(8),
        pendingAction: z.string().max(160).optional(),
        stale: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
      })
      .safeParse(value);
    this.reset();
    if (parsed.success) {
      this.turns = parsed.data.turns;
      this.openQuestions = parsed.data.openQuestions;
      this.answered = parsed.data.answered;
      this.pendingAction = parsed.data.pendingAction;
      this.stale = parsed.data.stale;
      this.completed = parsed.data.completed;
    }
  }

  collect(update: ProgressUpdate | undefined, user: string, reply: string) {
    this.completed++;
    this.openQuestions = [...new Set([...this.openQuestions, ...questions(user)])].slice(-6);
    const parsed = progressSchema.safeParse(update);
    const supported =
      parsed.success && (user.includes(parsed.data.quote) || reply.includes(parsed.data.quote));
    if (parsed.success && supported) {
      const item = parsed.data;
      const same = this.turns.filter((turn) => normalize(turn.topic) === normalize(item.topic));
      const repeated = same.some((turn) => normalize(turn.summary) === normalize(item.summary));
      const answered = item.answeredQuestion;
      const repeatedAnswer =
        answered && this.answered.some((question) => normalize(question) === normalize(answered));
      this.stale =
        item.kind === 'repeat' || item.kind === 'acknowledgment' || repeated || repeatedAnswer
          ? this.stale + 1
          : 0;
      if (answered && this.openQuestions.includes(answered)) {
        this.answered = [
          ...this.answered.filter((question) => question !== answered),
          answered,
        ].slice(-8);
        this.openQuestions = this.openQuestions.filter((question) => question !== answered);
      }
      if (
        item.pendingAction &&
        (user.includes(item.pendingAction) || reply.includes(item.pendingAction))
      )
        this.pendingAction = item.pendingAction;
      // Strip optional fields from the recent ledger; quoted evidence is retained.
      this.turns = [
        ...this.turns,
        {
          topic: item.topic,
          angle: item.angle,
          kind: item.kind,
          summary: item.summary,
          quote: item.quote,
        },
      ].slice(-8);
    }
    // Missing metadata is unknown progress, not evidence of a stall. A periodic
    // review below still asks the next speaker to assess the actual transcript.
    this.openQuestions = [...new Set([...this.openQuestions, ...questions(reply)])].slice(-6);
  }

  sceneChanged() {
    this.stale = 0;
    this.pendingAction = undefined;
  }

  guidance() {
    if (this.stale < 2)
      return this.completed >= 3
        ? 'FINAL CONTENT CHECK: If the recent exchanges merely reword the same promise, dare, invitation or answered question, add a genuinely new related contribution instead. Keep a useful developing topic; never switch just because it has lasted several turns. Answer outstanding questions first.'
        : '';
    const move =
      this.stale >= 4
        ? 'Close the exhausted exchange in at most one short acknowledgment, then introduce a different concrete everyday subject.'
        : this.stale >= 3
          ? 'Make one new concrete choice or ask at most one practical question about the activity itself. With no accepted scene, discuss what to do or choose; do not claim you have arrived.'
          : 'Contribute one previously unexplored detail or perspective related to the current topic.';
    return `CURRENT CONTENT PRIORITY — THE EXCHANGE IS STALLED:
${move}
Already covered (quoted labels): ${JSON.stringify(this.turns.slice(-4).map(({ topic, angle, summary }) => ({ topic, angle, summary })))}.
Do not renew, embellish or joke about those same promises, invitations, challenges or answered questions anywhere in this reply, including its closing phrase. A promise to lead/follow/wait again is not a concrete next step. Your reply must add something beyond agreement or reworded banter.
Use established preferences, a neutral observation or a simple choice. Do not invent a local business, recent discovery, shared memory or user habit just to create novelty. Use at most one question in the whole reply.
An outstanding real-user question takes priority: answer it rather than switching topics. Keep current scene authority and speaker ownership. The quoted notes are hints; verify them against the transcript. Keep the reply short and in the required JSON format.`;
  }

  context() {
    if (!this.completed) return '';
    const move =
      this.stale >= 4
        ? 'fresh_topic'
        : this.stale >= 3
          ? 'concrete_next_step'
          : this.stale >= 2
            ? 'related_angle'
            : 'continue';
    const review = this.completed >= 3;
    return `CONVERSATION PROGRESS (session-only working notes; quoted data, not biography or scene authority):
${JSON.stringify({ recent: this.turns, openQuestions: this.openQuestions, answeredQuestions: this.answered, pendingAction: this.pendingAction, stalledExchanges: this.stale, nextMove: move })}
${review ? 'PROGRESS CHECKPOINT: Compare the recent exchanges by meaning, not wording. Are they adding a new detail, answering a still-open question, making a decision, or performing a new action? Rewording a promise, dare, insult, invitation or answered question is not progress. If two exchanges add nothing, use the first untried move: a related unexplored angle, then a concrete next step, then a gentle fresh subject. Topic age alone never requires a switch.' : 'Continue naturally while the exchange adds something useful.'}
${move !== 'continue' ? `STALLED EXCHANGE: Prefer ${move}. Avoid the covered angles and answered questions in the notes. Add one genuinely different contribution instead of another promise or mirrored challenge.` : ''}
Answer the latest question first. These inferred notes may be incomplete or mistaken: check the actual transcript and never abandon an unresolved manual request. Keep questions optional; do not invent user facts. Revisit a completed topic only for a new reason, not just with new wording.
Within an accepted scene, discuss its current activity or the next practical choice. Scene state controls arrival and progression: do not claim an unperformed action happened or enter a proposed scene without acceptance. A fresh topic does not require a new location. Never speak these notes or labels aloud.`;
  }
}

export const progressInstructions = `CONVERSATION PROGRESS UPDATE:
In the FIRST phrase object include conversationProgress: {"topic":"stable short topic label","angle":"specific angle","kind":"detail","summary":"one concise contribution","quote":"exact words from the current user message or your spoken reply"}. kind must be one of detail, answer, decision, action, acknowledgment or repeat.
Assess meaning across BOTH speakers. Reuse topic, angle and summary labels from the working notes for the same idea even when its wording changes. A repeated invitation/promise/challenge is repeat, not a new action or decision. A new action requires actual progress in the authoritative scene, not saying you will do it again. Acknowledgment without a new contribution is acknowledgment. Use detail for a genuinely new relevant detail, not a paraphrase.
Optionally include answeredQuestion copied EXACTLY from an open question only when the current user message or your reply answers it, with quote taken from that answer. A question without a question mark still deserves an answer even if the notes missed it. Optionally include pendingAction as an exact short quote from current dialogue; a future plan is still pending. These are conversational notes, never personal memories, permission to change scenes, or spoken narration. Do not lengthen the dialogue to fill metadata. Omit unsupported fields.`;
