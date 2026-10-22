export type DeliveryPlan = {
  tone: 'plain' | 'warm' | 'amused' | 'reflective' | 'playful' | 'candid';
  length: 'brief' | 'normal' | 'fuller';
  contribution: 'reaction' | 'observation' | 'perspective' | 'suggestion';
};
const tones: DeliveryPlan['tone'][] = [
  'plain',
  'warm',
  'amused',
  'reflective',
  'playful',
  'candid',
];
const contributions: DeliveryPlan['contribution'][] = [
  'reaction',
  'observation',
  'perspective',
  'suggestion',
];
const index = (sample: number, length: number) =>
  Math.min(length - 1, Math.floor(Math.max(0, Number.isFinite(sample) ? sample : 0) * length));

/** A small delivery cue, not a random personality, topic, or emotional verdict. */
export class TurnDirector {
  private recent = new Map<string, DeliveryPlan[]>();
  next(speaker: 'mira' | 'user', random: () => number = Math.random): DeliveryPlan {
    const prior = this.recent.get(speaker) ?? [];
    const available = tones.filter((tone) => !prior.slice(-2).some((plan) => plan.tone === tone));
    const possible = contributions.filter((value) => value !== prior.at(-1)?.contribution);
    const roll = random();
    const plan: DeliveryPlan = {
      tone: available[index(random(), available.length)],
      length:
        roll < 0.1 && !prior.slice(-2).some((plan) => plan.length === 'brief')
          ? 'brief'
          : roll < 0.9
            ? 'normal'
            : 'fuller',
      contribution: possible[index(random(), possible.length)],
    };
    this.recent.set(speaker, [...prior, plan].slice(-2));
    return plan;
  }
  reset() {
    this.recent.clear();
  }
}

export function deliveryInstructions(plan?: DeliveryPlan) {
  if (!plan) return '';
  return `NATURAL VARIATION — THIS TURN ONLY:
Delivery: ${plan.tone}. Optional contribution: ${plan.contribution}. These are small delivery possibilities, not a reason to change topic or ignore a question. Use them only when the tone fits; serious requests stay considerate and direct.
${plan.length === 'brief' ? 'This is an occasional short turn. Use one natural spoken phrase for a quick reaction or direct answer; answer adequately if the request needs more detail. No filler or forced question.' : plan.length === 'normal' ? 'Use two to four natural spoken phrases, each expressing one clause or thought. Keep them concise while giving a relevant answer or contribution; a question is optional.' : 'Use three to six natural spoken phrases to develop a useful answer or contribution. Avoid padding and recycled banter.'}
Phrase count is separate from sentence count: a sentence can contain several spoken clauses. In phrase-array output, put each natural clause or short utterance in its own array item rather than combining the whole reply into one item. Do not add content merely to meet a length cue; direct requests for brevity take precedence.
Mira need not deny affection, act embarrassed, or perform tsundere behavior on this turn. The user-side speaker need not pay, solve a problem, make plans, or take charge. Both may simply react, enjoy something, disagree or express uncertainty. Keep stable identity, facts and commitments; do not invent user biography. Never mention these delivery labels.`;
}
