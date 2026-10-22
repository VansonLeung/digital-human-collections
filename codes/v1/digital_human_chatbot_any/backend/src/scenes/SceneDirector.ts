import type { SceneAgreement, ScenePlan, SceneSnapshot } from '@digital-human/shared';
import type { VirtualScene } from './VirtualScene.js';

export const outingInvitationPattern =
  /(?:不如[^。！？!?\n]{0,40}(?:去|散步|行山|行下|行吓|食飯|食糖水|飲杯|睇戲|逛)|我(?:哋|地|們|们)[^。！？!?\n]{0,30}去|一齊(?:去|食|飲|行)|一起(?:去|吃|喝|散步|看電影)|請你(?:食|飲)|请你(?:吃|喝)|去唔去|去不去|轉場|转场|(?:let'?s|let us|shall we|we could|we can|would you like to) (?:go|visit|walk|head|meet)|how about (?:going|visiting))/iu;

/** Only plain, explicit assent to an actual invitation; uncertainty stays pending. */
export function clearSpokenAgreement(
  scene: SceneSnapshot,
  input: string,
  reply: string,
  hasNewPlan: boolean,
): SceneAgreement | undefined {
  const invitation = outingInvitationPattern;
  const assent =
    /^(?:好呀|好啊|好喇|好啦|去呀|得呀|可以呀|冇問題|沒問題|走吧|好吧|yes\b|sure\b|okay\b|sounds good\b|let'?s go\b)/iu;
  if (
    /(?:不如[^。！？!?\n]{0,50}(?:唔好去|不要去|不想去|唔想去)|let'?s not|shall we not)/iu.test(
      input,
    )
  )
    return undefined;
  const accepted = reply.trimStart().match(assent)?.[0];
  const offer = input.match(invitation);
  if (
    !accepted ||
    (!hasNewPlan && !scene.proposal) ||
    (!offer && !(scene.proposal && assent.test(input.trimStart())))
  )
    return undefined;
  // Do not mistake a polite preface followed by withdrawal for agreement.
  if (
    /(?:不過|但是|但係|但|\bbut\b)[^。！？!?\n]{0,80}(?:唔去|不去|唔想去|不想去|can't go|cannot go|don't want to)|你自己去|you go alone/iu.test(
      reply,
    )
  )
    return undefined;
  const later =
    /(?:下次|聽日|明天|改天|之後先|下星期|下周|next time|tomorrow|another day|not now|maybe later)/iu.test(
      `${input}\n${reply}`,
    );
  const index = offer?.index ?? 0;
  return {
    offerQuote: input.slice(index, index + 280),
    acceptanceQuote: accepted,
    timing: later ? 'later' : 'now',
    ...(!hasNewPlan && scene.proposal ? { proposalId: scene.proposal.id } : {}),
  };
}

/** Validate evidence against the actual committed dialogue, not generated prose wrappers. */
export function sceneAgreementTarget(
  scene: VirtualScene,
  agreement: SceneAgreement | undefined,
  input: string,
  reply: string,
  newProposalId?: string,
) {
  if (
    !agreement ||
    !input.includes(agreement.offerQuote) ||
    !reply.includes(agreement.acceptanceQuote)
  )
    return undefined;
  const proposal = scene.snapshot().proposal;
  if (!proposal) return undefined;
  const id = agreement.proposalId ?? newProposalId;
  if (id !== proposal.id) return undefined;
  return { id, timing: agreement.timing };
}

export function proposeScene(scene: VirtualScene, plan?: ScenePlan, replacePending = false) {
  if (!plan || !scene.propose(plan, replacePending)) return undefined;
  return scene.snapshot().proposal!.id;
}
