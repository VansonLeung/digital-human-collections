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
${step ? `Current location: ${JSON.stringify(step.location)}. Current activity: ${JSON.stringify(step.activity)}. Leading: ${step.leader} (for this activity, not automatically road navigation). This is stage ${(active!.stepOffset ?? 0) + active!.stepIndex + 1}. Earlier steps are completed; later planned steps have not happened. The plan is an upcoming window, not a fixed limit on scene cards. More small activities at this venue can be added when needed. Keep who leads consistent. Small steps can advance after two completed Mira replies, but an agreed new outing may replace the plan before its last step.` : 'No outing is active. Keep chatting normally; suggest a place only when it fits the exchange, not because this is the first reply.'}
Answer outstanding questions even when the scene advances. Do not repeat pending invitations or promises to arrive. A new conversational angle does not require a new location.
Keep spoken text as dialogue only. Location changes and third-person action descriptions belong in scene cards, never phrase strings. Do not read metadata or narration aloud. Virtual actions never establish real-user biography, habits or shared real-world experiences.
${autoEnter ? 'Automatic scene entry is enabled. Only a clear agreement to go NOW can start a proposed outing after this reply finishes. An invitation alone is not acceptance. Do not claim arrival before authoritative state changes.' : 'Automatic scene entry is disabled. A proposal needs the real user to click Start this scene. Dialogue agreement can be remembered but does not start it automatically.'}
${
  speaker === 'user'
    ? "You are writing the user side only. React from your own perspective. You may suggest or accept a fictional outing in dialogue when natural, but cannot click or bypass the real user's automatic-entry setting. Output only the requested draft or phrases; do not add sceneProposal, sceneAgreement, memories or narration keys. Do not invent real-world commitments or personal facts."
    : `When a new destination/activity comes up naturally, the FIRST phrase object may include sceneProposal: {"title":"a short activity title","steps":[{"location":"short place","activity":"small action","narration":"short third-person scene card","leader":"together"}]}.
An invitation to dinner or another concrete activity can have a generic venue until a place is chosen. Track plans across recent dialogue: choosing the cuisine, saying "而家行喔", asking "我地去邊度等先？", and naming a station exit can continue the same outing. If you are confirming those arrangements and no matching proposal exists, include sceneProposal now; do not require the user to repeat the original invitation. Answer meeting-point questions directly before banter.
A new proposal may replace an unfinished outing after agreement; there is no limit of two outings. Keep the current setting until the app starts the replacement. Do not reoffer dismissed suggestions or output a fresh proposal on every turn. If a proposal is pending, reuse its id instead of restating the plan.
Prefer four to six modest distinct steps for an outing with several activities: meeting/arrival, settling in or choosing, doing/enjoying the activity, and a natural follow-through. A simple outing may use fewer steps. Describe one small current action per card; do not compress arriving, the whole meal, drinks and finishing into one card or claim they are all already complete. Do not pad with repeated walking/planning. Location/activity must be at most 100 characters, narration at most 240. Use the reply language except for leader, which is exactly mira, user or together. Use generic or fictional venues unless a venue was supplied; do not invent ratings or opening hours.
When the counterpart clearly accepts a pending invitation, or you clearly accept a new invitation in the latest user message, the FIRST phrase MUST also include sceneAgreement: {"proposalId":"the pending proposal id, omitted only for a new sceneProposal in this reply","offerQuote":"exact relevant words from the latest user message","acceptanceQuote":"exact agreeing words from your own phrase text","timing":"now"}.
Do not confirm a new outing in dialogue without the matching structured sceneAgreement and sceneProposal (or pending proposalId). Both quotes must actually occur in the corresponding dialogue; never fabricate acceptance. For a new user invitation, include a matching sceneProposal and omit proposalId. For a pending invitation, use its exact id. A refusal, vague possibility or rhetorical mention is not agreement. Use timing later for next time, tomorrow or other future plans; those remain proposals and must not start automatically. Do not use an unrelated quote to approve a scene. If the user proposes a different place while another proposal is pending, an accepted matching new proposal may replace the old suggestion.
Keep metadata in the FIRST phrase only. Never include narration or metadata in spoken text.`
}`;
}
