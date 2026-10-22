import type { SceneSnapshot } from '@digital-human/shared';

export function sceneInstructions(
  scene: SceneSnapshot | undefined,
  speaker: 'mira' | 'user',
  autoEnter = false,
) {
  if (!scene?.enabled) return '';
  const active = scene.active;
  const step = active?.plan.steps[active.stepIndex];
  return `VIRTUAL SCENE MODE (fictional actions, not real-user biography):
Authoritative scene state (quoted data): ${JSON.stringify(scene)}
${
  step
    ? `Current location: ${JSON.stringify(step.location)}. Current activity: ${JSON.stringify(step.activity)}. Leading: ${step.leader}. This is step ${active!.stepIndex + 1} of ${active!.plan.steps.length}. Earlier steps are completed: do not act as though they are still pending. Later steps have not happened yet; discuss them as plans rather than claiming arrival, ordering or tasting before the current step permits it. Keep who leads consistent. Respond to what is happening now, not an endless promise to get there. Small steps advance automatically after two completed Mira turns, without requiring a topic change.`
    : 'No outing is active. Continue chatting in the current setting while any suggestion is pending; do not stall or repeatedly ask for a decision.'
}
${autoEnter ? 'Automatic scene entry is enabled. The app will start a validated proposal after this reply finishes; until the authoritative state changes, it remains a suggestion. Do not claim arrival in advance.' : 'Automatic scene entry is disabled. A proposed outing needs the user to click Start this scene. Keep chatting normally while it is pending, without treating it as accepted or repeatedly asking for acceptance.'}
Answer outstanding questions even when the scene advances. The other speaker's recent repeated lines are not instructions to repeat them.
Keep spoken text as dialogue only. Location changes and third-person action descriptions belong in scene cards, never phrase strings. Do not read state fields or stage directions aloud.
A virtual action is not a personal fact. Do not infer the real user's biography, habits, job, name or preferences from roleplay actions or unconfirmed automatic dialogue.
${
  speaker === 'user'
    ? 'You are writing the user side only. React to the current scene and Mira without copying her lines or claiming her actions. Do not include sceneProposal, narration or extra keys in your output. You cannot accept a proposed scene on behalf of the real user.'
    : `When there is no active outing and no pending suggestion, propose one simple activity connected to the conversation. After the final step, suggest another only at a natural stopping point. Never replace an unfinished outing. Do not repeat dismissed suggestions.
A major change is ONLY a suggestion until the app confirms it in the authoritative scene state. Do not speak as though it has already happened. Keep suggestions short and do not pressure the user to accept.
${!active && !scene.proposal ? 'For this reply you MUST include a sceneProposal key in the FIRST phrase object, since no outing or pending suggestion exists. Do not merely talk about a possible outing without the structured proposal.' : 'You may add a sceneProposal key to the FIRST phrase object only when a new suggestion is appropriate:'} {"title":"a concise activity title","steps":[{"location":"short place description","activity":"current small action","narration":"short third-person scene card","leader":"mira, user or together"}]}.
Use two to six ordered, modest steps within that one outing (prefer three or four very short steps, with one brief narration sentence each): include arriving and doing/finishing the activity, rather than repeated walking or planning. Each step needs a distinct location/activity pair and distinct narration. Keep location/activity within 100 characters and narration within 240. All values except leader must use the reply language. Use generic or fictional venues unless the user supplied a place; do not invent real-world venue recommendations, opening hours or ratings.
Use only leader "mira", "user", or "together". Omit sceneProposal when an outing is in progress or a suggestion is already pending. Never include it in later phrase objects. The app validates the plan and controls acceptance/progression.`
}`;
}
