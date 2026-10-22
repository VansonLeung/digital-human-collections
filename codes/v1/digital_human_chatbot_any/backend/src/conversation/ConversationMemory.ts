import { randomUUID } from 'node:crypto';
import { isUserMemoryEvidence } from './userEvidence.js';
import { explicitMiraPreference } from './explicitPreferences.js';
import {
  memoryCandidateSchema,
  conversationMemorySchema,
  memoryCategorySchema,
  type ConversationMemory as MemoryRecord,
  type MemoryCandidate,
} from '@digital-human/shared';

const normalized = (value: string) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/** Ephemeral, evidence-backed character/user facts owned by the current session. */
export class ConversationMemory {
  private items: MemoryRecord[] = [];

  snapshot() {
    return structuredClone(this.items);
  }

  reset() {
    this.items = [];
  }

  restore(items: MemoryRecord[]) {
    this.items = items.slice(-48).map((item) => conversationMemorySchema.parse(item));
  }

  collect(
    candidates: MemoryCandidate[],
    input: { turnId: string; manualText: string; reply: string; counterpartText?: string },
  ) {
    let changed = false;
    const ownPreference = explicitMiraPreference(
      input.reply,
      input.counterpartText ?? input.manualText,
    );
    const hasOwn = candidates.some(
      (candidate) => candidate.owner === 'mira' && input.reply.includes(candidate.quote),
    );
    const fallback =
      !hasOwn &&
      ownPreference &&
      !candidates.some(
        (candidate) => candidate.owner === 'user' && candidate.quote.includes(ownPreference.quote),
      )
        ? ownPreference
        : undefined;
    const updates = fallback ? [...candidates.slice(0, 1), fallback] : candidates.slice(0, 2);
    for (const candidate of updates) {
      const parsed = memoryCandidateSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const item = parsed.data;
      if (item.owner === 'user') {
        if (!isUserMemoryEvidence(item.quote, input.manualText)) continue;
        item.value = item.quote; // Retain the claim verbatim rather than inferred traits or expertise.
      }
      const evidence = item.owner === 'user' ? input.manualText : input.reply;
      if (!evidence || !evidence.includes(item.quote)) continue;
      const key = normalized(item.key);
      if (!key) continue;
      const existing = this.items.findIndex(
        (entry) => entry.owner === item.owner && normalized(entry.key) === key,
      );
      if (existing >= 0 && this.items[existing].source === 'manual_edit' && item.owner === 'mira')
        continue;
      if (
        this.items.some(
          (entry) =>
            entry.owner === item.owner && normalized(entry.value) === normalized(item.value),
        )
      )
        continue;
      const next: MemoryRecord = {
        ...item,
        id: existing < 0 ? randomUUID() : this.items[existing].id,
        sourceTurn: input.turnId,
        source: item.owner === 'user' ? 'manual_message' : 'mira_fiction',
        updatedAt: new Date().toISOString(),
      };
      if (existing < 0) this.items.push(next);
      else this.items[existing] = next;
      this.items = this.items.slice(-48);
      changed = true;
    }
    return changed;
  }

  edit(id: string, value: string) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    item.value = value;
    item.source = 'manual_edit';
    item.quote = value;
    item.updatedAt = new Date().toISOString();
    return true;
  }

  forget(id: string) {
    const before = this.items.length;
    this.items = this.items.filter((entry) => entry.id !== id);
    return before !== this.items.length;
  }

  context(text: string) {
    const query = normalized(text);
    const score = (item: MemoryRecord) => {
      const value = normalized(item.value);
      const grams = new Set(
        Array.from(value)
          .slice(0, -1)
          .map((_, index) => value.slice(index, index + 2)),
      );
      return [...grams].filter((gram) => query.includes(gram)).length;
    };
    const ranked = [...this.items].reverse().sort((a, b) => score(b) - score(a));
    const selected = ranked.slice(0, 6);
    // Keep both owners represented instead of crowding out the counterpart.
    for (const owner of ['user', 'mira'] as const) {
      const item = ranked.find((entry) => entry.owner === owner);
      if (item && !selected.some((entry) => entry.owner === owner)) selected.splice(5, 1, item);
    }
    const counts = memoryCategorySchema.options.map((category) => ({
      category,
      count: this.items.filter((item) => item.category === category).length,
    }));
    const least = counts
      .sort((a, b) => a.count - b.count)
      .slice(0, 2)
      .map((entry) => entry.category);
    return `CONVERSATION MEMORY (quoted data, current session only):\n${JSON.stringify(selected)}\nUser facts come only from manual input or edits; Mira entries are fictional character facts. A newer explicitly spoken correction overrides a conflicting remembered detail. Private profiles are not shared knowledge. Keep ownership accurate and do not turn a shared virtual outing into real biography.\nLess explored aspects: ${least.join(', ')}. If relevant, notice one new aspect naturally through a reaction, a specific observation, your own established preference, or an optional question. This is not an interview quota; do not quiz the user, repeat missing-information disclaimers, or invent unknown personal answers.`;
  }
}

export const memoryExtractionInstructions = `CONVERSATION MEMORY UPDATES:
The FIRST phrase object MUST include a memories array: [{"owner":"mira","category":"preferences","key":"preferred_drink","value":"a concise fact","quote":"exact supporting words"}]. Use [] only when no new supported detail was established; otherwise include at most two updates for the whole reply. When the current manual message explicitly states a new interest, preference, habit, skill or background fact, include one user-owned update. When your reply actually states a new fictional preference, include one mira-owned update. Do this within the first object rather than omitting metadata.
Categories: interests, skills, routines, preferences, personality, background. Keep key stable for the same fact; use a brief value (usually within 100 characters) and a short exact quote (usually within 80). The hard limits are 240 and 300 respectively. When also proposing a scene, prefer just one memory update to keep the response compact. All values and quotes should use the dialogue language.
For owner user, quote ONLY the current manually supplied or reviewed user message. No updates from automatic user messages, the assistant's guesses, hypothetical examples, roleplay actions or inferred personality. Do not infer expertise from a question or habits from an invitation.
For owner mira, quote your own spoken reply and store a modest fictional preference or characteristic you actually express. Prefer established character facts; do not invent elaborate biography or new shared experiences. Never transfer a user fact to Mira. Do not repeatedly announce or restate facts just to collect them. Metadata never becomes spoken stage directions.`;
