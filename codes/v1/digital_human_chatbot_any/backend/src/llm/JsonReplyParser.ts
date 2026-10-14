import { jsonrepair } from 'jsonrepair';
import {
  llmPhraseSchema,
  replyLimits,
  replyPhraseTextSchema,
  type SpeechPhrase,
} from '@digital-human/shared';

export class ReplyFormatError extends Error {
  constructor(
    message = 'The reply did not contain a usable JSON phrase. Please try again.',
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplyFormatError';
  }
}

/** Only a fully closed object is eligible for repair. Never complete streamed text. */
function parsePhrase(source: string): SpeechPhrase {
  let value: unknown;
  let repairError: string | undefined;
  let repairedOutput: string | undefined;
  try {
    value = JSON.parse(source);
  } catch {
    try {
      repairedOutput = jsonrepair(source);
      value = JSON.parse(repairedOutput);
    } catch (error) {
      repairError = error instanceof Error ? error.message : 'JSON repair failed';
      // Conservative recovery: an intact, standard JSON phrase field first in
      // the object is usable even if the remaining metadata cannot be repaired.
      const phrase = source.match(/^\{\s*"phrase"\s*:\s*("(?:\\.|[^"\\])*")\s*[,}]/u);
      if (phrase) {
        try {
          value = { phrase: JSON.parse(phrase[1]) };
        } catch {
          /* Invalid string escapes are not recoverable. */
        }
      }
    }
  }

  const parsed = llmPhraseSchema.safeParse(value);
  if (parsed.success) {
    const { phrase, emotion, gestures } = parsed.data;
    return { text: phrase, performance: { emotion, gestures } };
  }

  // Metadata is all-or-nothing: invalid or missing controls cannot animate a rig.
  const text = replyPhraseTextSchema.safeParse(
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).phrase
      : undefined,
  );
  if (!text.success)
    throw new ReplyFormatError(undefined, {
      source,
      repairError,
      repairedOutput,
      validation: parsed.error.issues,
    });
  return { text: text.data, performance: { emotion: 'neutral', gestures: [] } };
}

/** Frames array items across arbitrary provider chunks without exposing JSON to chat. */
export class JsonReplyParser {
  private started = false;
  private closed = false;
  private finished = false;
  private stack: string[] = [];
  private quote = '';
  private escaped = false;
  private object = '';
  private characters = 0;
  private phrases = 0;
  private clean = '';
  private offset = 0;

  snapshot() {
    return {
      started: this.started,
      arrayClosed: this.closed,
      insideString: !!this.quote,
      depth: this.stack.length,
      offset: this.offset,
      acceptedPhrases: this.phrases,
      pendingObject: this.object,
    };
  }

  constructor(
    private onText: (text: string) => void,
    private onPhrase: (phrase: SpeechPhrase) => void,
  ) {}

  write(delta: string) {
    if (this.finished) throw new ReplyFormatError('Reply was already finalized.');
    this.characters += delta.length;
    if (this.characters > replyLimits.characters)
      throw new ReplyFormatError('The JSON reply exceeded the response size limit.');

    for (const character of delta) {
      this.offset++;
      if (this.closed) continue;
      if (!this.started) {
        // Bounded prose/code-fence wrappers are ignored, never spoken.
        if (character !== '[') continue;
        this.started = true;
        this.stack.push('[');
        continue;
      }

      if (this.object) this.object += character;
      if (this.quote) {
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === this.quote) this.quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        if (this.stack.length === 1) throw new ReplyFormatError();
        this.quote = character;
        continue;
      }
      if (character === '{' || character === '[') {
        if (this.stack.length === 1) {
          if (character !== '{') throw new ReplyFormatError();
          this.object = '{';
        }
        this.stack.push(character);
        if (this.stack.length > replyLimits.depth)
          throw new ReplyFormatError('The JSON reply was nested too deeply.');
        continue;
      }
      if (character === '}' || character === ']') {
        if (this.stack.pop() !== (character === '}' ? '{' : '[')) throw new ReplyFormatError();
        if (!this.stack.length) this.closed = true;
        else if (this.stack.length === 1 && this.object) {
          const source = this.object;
          this.object = '';
          this.emit(source);
        }
        continue;
      }
      if (this.stack.length === 1 && character !== ',' && !/\s/u.test(character))
        throw new ReplyFormatError();
    }
  }

  finish() {
    this.finished = true;
    // Already emitted objects remain usable when the array or its tail is cut
    // off. Re-parsing a repaired full array would duplicate or invent speech.
    if (!this.phrases) throw new ReplyFormatError();
    this.object = '';
    return this.clean;
  }

  private emit(source: string) {
    if (this.phrases >= replyLimits.phrases)
      throw new ReplyFormatError('The JSON reply contained too many phrases.');
    const phrase = parsePhrase(source);
    const text = `${this.phrases ? ' ' : ''}${phrase.text}`;
    this.phrases++;
    this.clean += text;
    this.onText(text);
    this.onPhrase(phrase);
  }
}
