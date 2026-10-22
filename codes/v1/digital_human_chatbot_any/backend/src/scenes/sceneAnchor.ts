import type { SceneSnapshot } from '@digital-human/shared';

/** Put current physical state after style cues and old conversational context. */
export function sceneAnchor(scene?: SceneSnapshot) {
  const active = scene?.enabled ? scene.active : undefined;
  if (!active) return '';
  const step = active.plan.steps[active.stepIndex];
  return `CURRENT SCENE — TIME AND LOCATION FOR THIS REPLY:
The current scene card has ALREADY taken effect: ${JSON.stringify(step)}.
Speak from this location, doing this activity NOW. If the card describes enjoying food or drinks, those are already available: react to tasting, the surroundings or conversation here rather than going back to finding the venue or ordering again. Earlier dialogue about travelling, waiting, meeting or promises can predate this card. Do not resume those completed arrangements or treat a stale automatic line as a new instruction to rewind the scene.
The leader field identifies who initiates the CURRENT ACTIVITY. It does not mean someone must keep giving directions or leading a journey after arrival.
Anchor your next contribution in the current activity: a concrete observation, relevant preference, practical choice or natural reaction here. If the other speaker is still talking as though arrival is pending, gently acknowledge the current setting and continue here rather than copying the outdated premise.
Do not say you are still on the way to a venue when the card places you inside it. Do not restart meeting, navigation or who-leads banter. A genuine new invitation may propose another outing through the normal scene controls; it does not erase the current location.
Narration remains in scene cards; spoken phrases stay dialogue. Keep any unresolved real question and speaker ownership accurate. Return the required JSON only.`;
}

export function sceneSystemContext(scene?: SceneSnapshot) {
  const active = scene?.enabled ? scene.active : undefined;
  if (!active) return '';
  const step = active.plan.steps[active.stepIndex];
  return `\n\nCURRENT FICTIONAL PHYSICAL STATE (authoritative):\nLocation: ${JSON.stringify(step.location)}. Activity already underway: ${JSON.stringify(step.activity)}. Current event: ${JSON.stringify(step.narration)}.\nUse these current facts even if recent dialogue still says otherwise. Treat old future-arrival, waiting and navigation lines as historical context. Speak from here now; do not replay the journey or an earlier activity phase. The leader belongs to this activity, not automatically a road guide. A different destination needs the normal agreed scene proposal.`;
}
