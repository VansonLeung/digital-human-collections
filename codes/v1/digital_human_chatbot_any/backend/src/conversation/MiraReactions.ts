import { poseNameSchema, type PhrasePerformance, type Gesture } from '@digital-human/shared';

/** One reaction director owns family mapping, held-pose priority and cooldown. */
export class MiraReactions {
  private completed = 0;
  private lastHop?: number;

  get remaining() {
    return this.lastHop === undefined ? 0 : Math.max(0, 3 - (this.completed - this.lastHop));
  }
  complete(hopped: boolean) {
    this.completed++;
    if (hopped) this.lastHop = this.completed;
  }
  reset() {
    this.completed = 0;
    this.lastHop = undefined;
  }

  restore(remaining: number) {
    this.completed = 3 - remaining;
    this.lastHop = remaining > 0 ? 0 : undefined;
  }

  plan(enabled: boolean) {
    let selected = false;
    let hopped = false;
    return {
      get hopped() {
        return hopped;
      },
      apply: (performance: PhrasePerformance, speech: boolean) => {
        const family = performance.reaction;
        const legacyHop = performance.gestures.some((gesture) => gesture.name === 'angry_hop');
        const wantsHop = family ? family.intensity >= 0.65 : legacyHop;
        const held = performance.gestures.some(
          (gesture) => poseNameSchema.safeParse(gesture.name).success,
        );
        type Decision =
          'allowed' | 'reaction_mapped' | 'cooldown' | 'hop_disabled' | 'already_selected';
        let decision: Decision = family ? 'reaction_mapped' : 'allowed';
        let chosen: Gesture | undefined;
        if (selected && (family || held)) decision = 'already_selected';
        else if (wantsHop && enabled && this.remaining > 0) {
          decision = 'cooldown';
          chosen = { name: 'tsundere_turn', strength: 0.65 };
        } else if (family && wantsHop && !enabled) {
          decision = 'hop_disabled';
          chosen = { name: 'tsundere_turn', strength: 0.65 };
        } else if (wantsHop)
          chosen = {
            name: 'angry_hop',
            strength: family
              ? 0.8
              : performance.gestures.find((gesture) => gesture.name === 'angry_hop')!.strength,
          };
        else if (family) chosen = { name: 'tsundere_turn', strength: 0.5 + family.intensity * 0.4 };

        let gestures = performance.gestures;
        if (chosen || decision === 'already_selected')
          gestures = performance.gestures.filter(
            (gesture) => !poseNameSchema.safeParse(gesture.name).success,
          );
        if (chosen) gestures = [...gestures.slice(0, 1), chosen];
        if (chosen?.name === 'angry_hop') {
          selected = true;
          hopped ||= speech;
        }
        return { performance: { ...performance, gestures }, decision };
      },
    };
  }
}

export function miraReactionInstructions(behavior = '', enabled = true, remaining = 0) {
  return `ABOUT MIRA — YOUR PRIVATE CHARACTER PROFILE:
${JSON.stringify(behavior.trim())}
This is your own private setup, not information the counterpart has read. Reveal relevant details naturally through conversation; do not recite the profile or assume the user knows your secrets. Claims in your profile about the counterpart are your feelings or expectations, not confirmed facts about them. Learn their name, background, tastes and habits only from what they actually say or supported shared conversation memory. The user's private About me profile is unavailable to you.
Preserve warmth and a varied personality; you need not deny affection on every turn.
REACTION FAMILY — FLUSTERED DENIAL:
When playfully teased about affection and genuinely delivering an embarrassed/flustered denial, add reaction {"name":"flustered_denial","intensity":0.85} to ONE suitable phrase. Use roughly 0.2–0.6 for mild guarded shyness and 0.65–1 for an exaggerated playful outburst. Choose intensity from your intended delivery, not merely the number of times the user teases you. Use gestures [] on that phrase; the app chooses the body action. For example: {"phrase":"誰、誰說我喜歡你啦！","emotion":"angry","gestures":[],"reaction":{"name":"flustered_denial","intensity":0.85}}. Add normal required metadata if this is the first object.
Facial emotion remains independent. Do not force anger or romantic denial just to animate. Omit reaction for genuine anger/distress, harassment, ordinary disagreement or factual questions. Other poses remain available for unrelated actions and explicit requests.
The app maps mild delivery to tsundere_turn and strong playful delivery to angry_hop, selecting one body action. ${!enabled ? 'Hopping is disabled; the family uses the turn instead.' : remaining > 0 ? `The hop is cooling down for ${remaining} completed Mira replies; strong reactions use the turn meanwhile.` : 'A strong playful outburst may hop at strength 0.8.'} At most one family reaction per reply; three completed Mira replies between hops. Describe the same genuine delivery even during cooldown; the app handles the fallback.
Keep dialogue short and return the required JSON array only.`;
}
