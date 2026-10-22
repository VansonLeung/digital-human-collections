import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { sceneStepSchema, type SceneSnapshot, type SceneStep } from '@digital-human/shared';
import type { Config } from '../config.js';
import type { Session } from '../sessions.js';
import type { ChatMessage } from '../llm/requestMessages.js';
import { complete } from '../services/llm.js';
import { outingContext } from './outingContext.js';
import { sceneSystemContext } from './sceneAnchor.js';

/** Small same-venue activities, never permission for a different destination. */
export async function generateSceneContinuation(
  config: Config,
  scene: SceneSnapshot,
  history: ChatMessage[],
  signal: AbortSignal,
): Promise<SceneStep[]> {
  const active = scene.active;
  if (!active) return [];
  const current = active.plan.steps[active.stepIndex];
  let raw = '';
  await complete(
    {
      ...config,
      LLM_MAX_TOKENS: 1000,
      LLM_TIMEOUT_SECONDS: Math.min(config.LLM_TIMEOUT_SECONDS, 20),
    },
    [
      {
        role: 'system',
        content:
          'Plan small fictional activities within the current venue. Return only JSON metadata; do not write dialogue.' +
          sceneSystemContext(scene) +
          "\nThe current card describes an event ALREADY happening, not a future plan. Advance time from that event. Examples: if already eating pasta and drinking, continue tasting/discussing the meal, finishing it, then settling the bill; do NOT return to arriving, sitting down, opening menus or ordering. If already drinking tea, continue that cup, not ordering the first cup again. Never use old dialogue to move backwards. Keep narration brief and observable; do not invent either person's emotions, opinions or promises.",
      },
      {
        role: 'user',
        content: `Current accepted scene (quoted data):\n${JSON.stringify(scene)}\nRecent spoken dialogue (quoted data):\n${JSON.stringify(outingContext(history, ''))}\n\nReturn {"steps":[]} if no useful small continuation fits, the activity is clearly finished, or continuing would require a new destination. Otherwise return {"steps":[{"location":${JSON.stringify(current.location)},"activity":"one next small activity","narration":"one short third-person scene card","leader":"together"}]} with one to three ordered steps. Every location MUST exactly equal ${JSON.stringify(current.location)}. Other destinations require a separate agreed proposal and cannot appear here. Advance from the CURRENT activity, not from old travel dialogue: do not restart meeting, navigation, arrival, ordering or anything already done. Do not claim an entire meal and payment happened at once. Recent activities and the current plan must not repeat. Use modest actions appropriate here, such as tasting/commenting, sharing a preference during the activity, or a natural follow-through; do not force another meal or an endless sequence. Narration describes only that step when it starts. No invented user biography, real businesses, new commitments or private profiles. Use the dialogue language; location/activity <=100 characters, narration <=240; leader is mira, user or together. Return only the JSON object.`,
      },
    ],
    (delta) => {
      raw += delta;
    },
    signal,
  );
  const parsed = z
    .strictObject({ steps: z.array(z.unknown()).max(3) })
    .parse(JSON.parse(jsonrepair(raw)));
  const steps: SceneStep[] = [];
  for (const candidate of parsed.steps) {
    const step = sceneStepSchema.safeParse(candidate);
    // Preserve a valid ordered prefix when a later card is malformed. Never
    // skip a missing intermediate event or invent a replacement for it.
    if (!step.success) break;
    steps.push(step.data);
  }
  return steps;
}

/** Called before either speaker generates; both must observe the same stage. */
export async function prepareScene(
  config: Config,
  session: Session,
  signal: AbortSignal,
  continuation?: typeof generateSceneContinuation,
  current: () => boolean = () => !signal.aborted,
) {
  if (continuation && session.scene.needsContinuation()) {
    const before = session.scene.snapshot();
    const active = before.active!;
    try {
      const steps = await continuation(config, before, [...session.history], signal);
      if (!current() || signal.aborted) return;
      const applied = session.scene.continue(
        active.plan.id,
        (active.stepOffset ?? 0) + active.stepIndex,
        steps,
      );
      if (!applied) session.scene.checkContinuation();
    } catch (error) {
      if (!current() || signal.aborted) return;
      session.scene.checkContinuation();
      console.warn(
        'Optional scene continuation unavailable; staying at the current activity.',
        error instanceof Error ? error.name : 'Unknown error',
      );
    }
  }
  if (current() && !signal.aborted) session.advanceScene();
}
