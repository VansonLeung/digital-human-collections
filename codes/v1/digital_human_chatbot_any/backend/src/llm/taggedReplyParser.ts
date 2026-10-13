import {
  emotionSchema,
  gestureSchema,
  type Emotion,
  type Gesture,
  type SpeechPhrase,
} from '@digital-human/shared';

const controlPrefix = /^<\/?(?:gesture|emotion)\b/i;

const tagPrefixes = ['<gesture', '<emotion', '</gesture', '</emotion'];

/** Consumes provider deltas, including tags split at arbitrary token boundaries. */
export class TaggedReplyParser {
  private buffer = '';
  private phrase = '';
  private emotion: Emotion = 'neutral';
  private gestures: Gesture[] = [];
  private discardingTag = false;
  private clean = '';
  private needsSeparator = false;

  constructor(
    private onText: (text: string) => void,
    private onPhrase: (phrase: SpeechPhrase) => void,
  ) {}

  write(delta: string) {
    this.buffer += delta;
    this.drain(false);
  }

  finish() {
    this.drain(true);
    this.flushPhrase();
    return this.clean.trim();
  }

  private drain(final: boolean) {
    while (this.buffer) {
      if (this.discardingTag) {
        const end = this.buffer.indexOf('>');
        if (end < 0) {
          this.buffer = '';
          return;
        }
        this.buffer = this.buffer.slice(end + 1);
        this.discardingTag = false;
        continue;
      }

      const start = this.buffer.indexOf('<');
      if (start < 0) {
        this.emitText(this.buffer);
        this.buffer = '';
        return;
      }
      if (start > 0) {
        this.emitText(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start);
      }

      const lower = this.buffer.toLowerCase();
      const partial = tagPrefixes.some((prefix) => prefix.startsWith(lower));
      if (partial && !final) return;

      if (controlPrefix.test(this.buffer) || partial) {
        const end = this.buffer.indexOf('>');
        if (end < 0) {
          if (final || this.buffer.length > 512) {
            this.buffer = '';
            this.discardingTag = !final;
          }
          return;
        }
        this.applyTag(this.buffer.slice(0, end + 1));
        this.needsSeparator = !!this.clean && !/\s$/u.test(this.clean);
        this.buffer = this.buffer.slice(end + 1);
        continue;
      }

      // Ignore other complete XML/HTML-style instructions, while preserving '<3'
      // and ordinary mathematical comparisons. Unknown markup never reaches TTS.
      const unknownTag = this.buffer.match(/^<\/?[a-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>/i);
      if (unknownTag) {
        this.buffer = this.buffer.slice(unknownTag[0].length);
        this.needsSeparator = !!this.clean && !/\s$/u.test(this.clean);
        continue;
      }
      if (
        !final &&
        /^<\/?[a-z]/i.test(this.buffer) &&
        !this.buffer.includes('>') &&
        this.buffer.length <= 512
      )
        return;

      // Ordinary '<' (for example a mathematical comparison) is not an instruction.
      this.emitText('<');
      this.buffer = this.buffer.slice(1);
    }
  }

  private applyTag(tag: string) {
    const match = tag.match(/^<(gesture|emotion)\s+([^<>]*?)\s*\/\s*>$/i);
    if (!match) return;

    const attributes: Record<string, string> = {};
    for (const attribute of match[2].matchAll(/([a-z]+)\s*=\s*(["'])(.*?)\2/gi)) {
      attributes[attribute[1].toLowerCase()] = attribute[3];
    }

    if (match[1].toLowerCase() === 'emotion') {
      const name = attributes.name?.trim().toLowerCase();
      const result = emotionSchema.safeParse(
        name === 'normal' ? 'neutral' : name === 'surprise' ? 'surprised' : name,
      );
      if (!result.success) return;
      this.flushPhrase();
      this.emotion = result.data;
      return;
    }

    const result = gestureSchema.safeParse({
      name: attributes.name,
      strength: attributes.strength === undefined ? 0.5 : Number(attributes.strength),
    });
    if (!result.success) return;
    this.flushPhrase();
    if (this.gestures.length < 2) this.gestures.push(result.data);
  }

  private emitText(text: string) {
    if (this.needsSeparator && /[a-z0-9.!?]$/i.test(this.clean) && /^[a-z0-9]/i.test(text))
      text = ` ${text}`;
    this.needsSeparator = false;
    this.clean += text;
    this.onText(text);

    for (const character of text) {
      // Delay an ASCII period until the following character to preserve decimals.
      if (this.phrase.endsWith('.') && /\s/u.test(character)) this.flushPhrase();
      this.phrase += character;
      if (/[。！？!?；;\n]/u.test(character)) this.flushPhrase();
      // Bound a punctuation-free phrase without splitting at every comma.
      if (this.phrase.length >= 300 && /[\s，,]/u.test(character)) this.flushPhrase();
      if (this.phrase.length >= 600) this.flushPhrase();
    }
  }

  private flushPhrase() {
    const text = this.phrase.trim();
    this.phrase = '';
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;

    this.onPhrase({
      text,
      performance: { emotion: this.emotion, gestures: this.gestures },
    });
    this.gestures = [];
  }
}
