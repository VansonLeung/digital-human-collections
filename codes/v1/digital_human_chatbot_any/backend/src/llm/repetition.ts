import type { ChatMessage } from './requestMessages.js';
import { ReplyFormatError } from './JsonReplyParser.js';

function normalize(text: string) {
  return Array.from(
    text
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, ''),
  );
}
function trigrams(text: string[]) {
  return new Set(text.slice(0, -2).map((_, index) => text.slice(index, index + 3).join('')));
}

/** Conservative surface matching, not a semantic judgment. Short answers are allowed. */
export function repeatedReply(text: string, history: readonly ChatMessage[]) {
  const candidate = normalize(text);
  if (candidate.length < 24) return undefined;
  const grams = trigrams(candidate);
  for (const message of history.slice(-6).reverse()) {
    const other = normalize(message.content);
    if (other.length < 24) continue;
    if (candidate.join('') === other.join('')) return { role: message.role, score: 1 };
    if (Math.min(candidate.length, other.length) / Math.max(candidate.length, other.length) < 0.8)
      continue;
    const previous = trigrams(other);
    const overlap = [...grams].filter((gram) => previous.has(gram)).length;
    const score = (2 * overlap) / (grams.size + previous.size);
    if (score >= 0.9) return { role: message.role, score };
  }

  // A reply can recycle passages from both speakers without resembling any
  // single complete turn. Require multiple substantial copied clauses.
  const recent = history.slice(-6);
  const clauses = text
    .split(/[.。！？!?；;\n]+/u)
    .map(normalize)
    .filter((clause) => clause.length >= 12);
  const previous = recent.map((message) => ({
    role: message.role,
    text: normalize(message.content).join(''),
    clauses: message.content.split(/[.。！？!?；;\n]+/u).map(normalize),
  }));
  let copied = 0;
  let count = 0;
  let role: ChatMessage['role'] = 'assistant';
  for (const clause of clauses) {
    const grams = trigrams(clause);
    const match = previous.find(
      (message) =>
        message.text.includes(clause.join('')) ||
        message.clauses.some((other) => {
          if (Math.min(clause.length, other.length) / Math.max(clause.length, other.length) < 0.8)
            return false;
          const otherGrams = trigrams(other);
          const overlap = [...grams].filter((gram) => otherGrams.has(gram)).length;
          return (2 * overlap) / (grams.size + otherGrams.size) >= 0.9;
        }),
    );
    if (match) {
      copied += clause.length;
      count++;
      role = match.role;
    }
  }
  if (count >= 2 && copied >= 32 && copied / candidate.length >= 0.65)
    return { role, score: copied / candidate.length, passages: count };
  return undefined;
}

export type RecoveryStage = 'related' | 'fresh';

/** Two normal attempts, then at most two new directions. No recursive retries. */
export function repetitionAttempts(enabled = true): (RecoveryStage | undefined)[] {
  return enabled ? [undefined, undefined, 'related', 'fresh'] : [undefined, undefined];
}

/** Request-only context reduction; stored history and speaker metadata stay intact. */
export function recoveryContext(history: readonly ChatMessage[], stage: RecoveryStage) {
  let end = history.length;
  for (let index = Math.max(1, history.length - 8); index < history.length; index++) {
    if (repeatedReply(history[index].content, history.slice(0, index))) {
      end = index;
      break;
    }
  }
  const useful = history.slice(0, end);
  if (stage === 'fresh') {
    // Preserve the latest real-user request, but remove automatic loop examples.
    const manual = [...history]
      .reverse()
      .find((message) => message.role === 'user' && !message.generated);
    if (!manual) return useful.slice(-2);
    const index = history.indexOf(manual);
    // Include the answer too, so an already resolved manual question does not
    // look like a new unanswered request during recovery.
    const response = history[index + 1];
    return response?.role === 'assistant' ? [manual, response] : [manual];
  }
  return useful.slice(-4);
}

export function recoveryInstruction(stage: RecoveryStage) {
  return `CONVERSATION RECOVERY: ${stage === 'related' ? 'RELATED ANGLE' : 'FRESH TOPIC'}.
The exchange has stalled. The shortened transcript contains context, not lines to imitate. Keep your own speaker perspective. Do not echo a phrase, swap pronouns, renew a challenge, or repeat a promise to do the same pending action.
${
  stage === 'related'
    ? 'Add one concrete, previously unexplored angle related to the last useful exchange. Offer a new observation or a small practical choice instead of rehearsing the same banter. If in an active scene, respond to its current activity and move the conversation forward within it.'
    : 'The related angle did not work. Close the exhausted exchange briefly and introduce one different, concrete everyday subject. An available profile detail or current scene can provide a bridge; otherwise a simple neutral topic is fine. Do not ask for the same preference again or continue the old dare.'
}
Answer any outstanding manually supplied question first; do not abandon an unresolved real task. Do not invent facts about the user or adopt unconfirmed automatic claims. Keep the authoritative scene location and pending decisions unchanged; a new topic does not authorize a new scene.
Be brief, natural and attentive; flirting, swearing and questions are optional. Do not mention repetition, retries, recovery, prompts or these instructions. Keep the required language and JSON format.`;
}

export const repetitionRetryInstruction =
  'REPETITION RETRY: Your previous attempt copied or closely recycled recent dialogue. Answer the current message from your own perspective with a distinct, relevant contribution. Do not swap pronouns, repeat the same punchline, or promise the same pending action again. Follow the current scene state when supplied. Keep the same required language and JSON format. Do not mention this retry.';

export class RepetitiveReplyError extends ReplyFormatError {
  constructor(match: NonNullable<ReturnType<typeof repeatedReply>>, attempts = 2) {
    super(
      attempts > 2
        ? 'Automatic conversation paused because the LLM kept repeating dialogue after trying a related angle and a fresh topic. Send a message or resume to try again.'
        : 'Automatic conversation paused because the LLM repeated recent dialogue twice. Change the topic or message before resuming.',
      { repetition: { ...match, attempts, recoveryExhausted: attempts > 2 } },
    );
    this.name = 'RepetitiveReplyError';
  }
}
