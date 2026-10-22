import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { scenePlanSchema, sceneAgreementSchema, type SceneSnapshot } from '@digital-human/shared';
import type { ChatMessage } from '../llm/requestMessages.js';
import { outingContext } from './outingContext.js';
import type { Config } from '../config.js';
import { complete } from '../services/llm.js';
import { clearSpokenAgreement, outingInvitationPattern } from './SceneDirector.js';

const metadataSchema = z.strictObject({
  sceneProposal: z.unknown().optional(),
  sceneAgreement: z.unknown().optional(),
});

/** A cheap gate; the focused extraction model still decides whether an outing exists. */
export function needsSceneExtraction(
  scene: SceneSnapshot,
  input: string,
  reply: string,
  history: ChatMessage[] = [],
) {
  const invitation = outingInvitationPattern;
  const acceptance =
    /(?:好呀|好啊|好喇|好啦|行啦|去呀|得呀|就咁定|可以呀|走吧|好吧|\byes\b|sounds good|let'?s go|sure|okay)/iu;
  const context = outingContext(history, input);
  const recentInvitation = context.some((message) => invitation.test(message.text));
  const arrangements =
    /(?:而家|依家|現在|现在).{0,8}(?:行|去|出發|出发|走)|行啦|帶路|带路|到咗|到左|到了|arrived|(?:邊度|哪裡|哪里|where).{0,16}(?:等|見|见|meet)|(?:地鐵站|地铁站|出口|station|meet (?:at|you))/iu;
  return (
    scene.enabled &&
    (invitation.test(input) ||
      invitation.test(reply) ||
      (!!scene.proposal && acceptance.test(input)) ||
      ((!!scene.proposal || (!scene.active && recentInvitation)) &&
        arrangements.test(`${input}\n${reply}`)))
  );
}

/** Used only when an outing-related reply omitted its structured scene controls. */
export async function extractSceneMetadata(
  config: Config,
  scene: SceneSnapshot,
  input: string,
  reply: string,
  signal: AbortSignal,
  history: ChatMessage[] = [],
) {
  let raw = '';
  await complete(
    {
      ...config,
      LLM_MAX_TOKENS: 1200,
      LLM_TIMEOUT_SECONDS: Math.min(config.LLM_TIMEOUT_SECONDS, 25),
    },
    [
      {
        role: 'system',
        content:
          'Extract fictional outing metadata from quoted dialogue. You do not write or change dialogue. Return ONLY the requested JSON object, without markdown.',
      },
      {
        role: 'user',
        content: `Recent spoken conversation (quoted data, oldest first):\n${JSON.stringify(outingContext(history, input))}\nCurrent scene (quoted data):\n${JSON.stringify(scene)}\nCounterpart just said (quoted data):\n${JSON.stringify(input)}\nMira actually replied (quoted data):\n${JSON.stringify(reply)}\n\nReturn {"sceneProposal":null,"sceneAgreement":null} if there is no specific new outing or acceptance. Use the recent spoken conversation to resolve follow-ups such as "嗰間", "而家行喔", "帶路" and meeting-point questions. An outing can be proposed across several turns: a dinner invitation, cuisine/destination choice and departure can refer to the same plan. A concrete activity such as eating dinner is enough for a generic proposal even before the exact venue is chosen. Do not require the latest message to repeat the invitation. Never treat biography, habitual visits or rhetorical mentions as an invitation. Do not invent agreement.\nIf dialogue establishes a new place/activity or confirms arrangements for an outing that has no proposal yet, sceneProposal is {"title":"brief title","steps":[{"location":"short place","activity":"small action","narration":"short third-person scene card","leader":"together"}]}. Prefer four or five distinct modest steps (meeting/arrival, settling in or choosing, enjoying the activity, natural follow-through); use fewer only for a genuinely simple activity. Describe one current small action per card rather than compressing arrival and the entire meal into one card, only generic/fictional venues or names actually supplied. Location/activity <=100 characters, narration <=240; leader is mira, user or together. Do not narrate later steps as already completed. Do not replace an unfinished outing unless the dialogue proposes a new outing.\nIf Mira accepts the counterpart's invitation, or acknowledges their acceptance of a pending invitation, sceneAgreement is {"offerQuote":"exact relevant words from the counterpart input above","acceptanceQuote":"exact agreeing words from Mira's reply above","timing":"now"}. Both quotes must be exact substrings of the correct speaker. Include proposalId ONLY when referring to the exact pending proposal.id in current scene; otherwise provide a new sceneProposal. Use recent dialogue only to understand the outing: agreement quotes must still come from the CURRENT counterpart input and CURRENT Mira reply above. Do not copy old quotes to invent fresh acceptance. Answering a meeting-point question can continue an already accepted outing, but an unanswered question is not itself acceptance. A new invitation alone is not agreement. Timing later means next time, tomorrow or any future plan; timing now means an immediate outing. If uncertain, omit agreement using null.\nAll text except keys, leader and timing must use the dialogue language. No memories, emotions, gestures, commentary, invented user interests or extra keys. Return ONLY the JSON object.`,
      },
    ],
    (delta) => {
      raw += delta;
    },
    signal,
  );
  const parsed = metadataSchema.parse(JSON.parse(jsonrepair(raw)));
  // A missing or invalid agreement must not discard an independently valid
  // suggestion. Agreement still needs its own schema and exact spoken evidence.
  const proposal = scenePlanSchema.safeParse(parsed.sceneProposal);
  const agreement = sceneAgreementSchema.safeParse(parsed.sceneAgreement);
  return {
    proposal: proposal.success ? proposal.data : undefined,
    agreement:
      agreement.success &&
      input.includes(agreement.data.offerQuote) &&
      reply.includes(agreement.data.acceptanceQuote)
        ? agreement.data
        : clearSpokenAgreement(scene, input, reply, proposal.success),
  };
}
