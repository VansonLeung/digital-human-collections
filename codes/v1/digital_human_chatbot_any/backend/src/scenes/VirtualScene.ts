import { sceneStepSchema, type SceneStep } from '@digital-human/shared';
import { randomUUID } from 'node:crypto';
import {
  sceneSnapshotSchema,
  scenePlanSchema,
  type ScenePlan,
  type SceneSnapshot,
} from '@digital-human/shared';

/** Scene actions are virtual events, never evidence about the real user's life. */
export class VirtualScene {
  private state: SceneSnapshot = { enabled: false, version: 0, dismissedTitles: [] };

  snapshot(): SceneSnapshot {
    return structuredClone(this.state);
  }
  restore(state: SceneSnapshot) {
    const value = sceneSnapshotSchema.parse(state);
    if (value.active && value.active.stepIndex >= value.active.plan.steps.length)
      throw new Error('Saved scene step is out of range.');
    this.state = structuredClone(value);
  }
  configure(enabled: boolean) {
    if (this.state.enabled === enabled) return false;
    this.state.enabled = enabled;
    this.state.version++;
    return true;
  }
  propose(plan: ScenePlan, replacePending = false) {
    const parsed = scenePlanSchema.safeParse(plan);
    if (!this.state.enabled || (this.state.proposal && !replacePending) || !parsed.success)
      return false;
    const steps = parsed.data.steps;
    const actions = steps.map((step) => `${step.location}\n${step.activity}`.toLocaleLowerCase());
    const narrations = steps.map((step) => step.narration.toLocaleLowerCase());
    if (new Set(actions).size !== actions.length || new Set(narrations).size !== narrations.length)
      return false;
    const title = parsed.data.title.toLocaleLowerCase();
    if (this.state.dismissedTitles.some((value) => value.toLocaleLowerCase() === title))
      return false;
    if (this.state.active?.plan.title.toLocaleLowerCase() === title) return false;
    this.state.proposal = { ...parsed.data, id: randomUUID() };
    this.state.agreement = undefined;
    this.state.version++;
    return true;
  }
  agree(proposalId: string, timing: 'now' | 'later') {
    if (!this.state.enabled || this.state.proposal?.id !== proposalId) return false;
    this.state.agreement = { proposalId, timing };
    this.state.version++;
    return true;
  }
  decide(id: string, version: number, accept: boolean) {
    if (!this.state.enabled || this.state.version !== version || this.state.proposal?.id !== id)
      return undefined;
    const plan = this.state.proposal;
    this.state.proposal = undefined;
    this.state.agreement = undefined;
    if (accept) {
      const previous = this.state.active;
      if (previous) {
        const step = previous.plan.steps[previous.stepIndex];
        this.state.history = [
          ...(this.state.history ?? []),
          { title: previous.plan.title, location: step.location, activity: step.activity },
        ].slice(-6);
      }
      this.state.active = { plan, stepIndex: 0, completedTurns: 0 };
    } else this.state.dismissedTitles = [...this.state.dismissedTitles, plan.title].slice(-5);
    this.state.version++;
    return { accepted: accept, step: accept ? this.currentStep() : undefined };
  }
  currentStep() {
    const active = this.state.active;
    if (!active) return undefined;
    return {
      id: `${active.plan.id}:${(active.stepOffset ?? 0) + active.stepIndex}`,
      step: active.plan.steps[active.stepIndex],
      index: (active.stepOffset ?? 0) + active.stepIndex,
      total: (active.stepOffset ?? 0) + active.plan.steps.length,
    };
  }
  needsContinuation() {
    const active = this.state.active;
    return !!(
      this.state.enabled &&
      active &&
      active.stepIndex === active.plan.steps.length - 1 &&
      active.completedTurns >= 2 &&
      active.completedTurns - (active.continuationCheckedAt ?? 0) >= 2
    );
  }
  checkContinuation() {
    const active = this.state.active;
    if (active) active.continuationCheckedAt = active.completedTurns;
  }
  /** Extend only the current venue. A different place still needs a proposal. */
  continue(sceneId: string, afterStep: number, steps: SceneStep[]) {
    const active = this.state.active;
    if (
      !this.needsContinuation() ||
      !active ||
      active.plan.id !== sceneId ||
      (active.stepOffset ?? 0) + active.stepIndex !== afterStep ||
      steps.length < 1 ||
      steps.length > 4
    )
      return false;
    const current = active.plan.steps[active.stepIndex];
    const recent = new Set(
      [...(active.recentActivities ?? []), ...active.plan.steps.map((step) => step.activity)].map(
        (text) => text.normalize('NFKC').trim().toLowerCase(),
      ),
    );
    const narrations = new Set(active.plan.steps.map((step) => step.narration));
    for (const step of steps) {
      if (
        !sceneStepSchema.safeParse(step).success ||
        step.location !== current.location ||
        recent.has(step.activity.normalize('NFKC').trim().toLowerCase()) ||
        narrations.has(step.narration)
      )
        return false;
      recent.add(step.activity.normalize('NFKC').trim().toLowerCase());
      narrations.add(step.narration);
    }
    active.recentActivities = [
      ...(active.recentActivities ?? []),
      ...active.plan.steps.slice(0, active.stepIndex).map((step) => step.activity),
    ].slice(-24);
    active.stepOffset = (active.stepOffset ?? 0) + active.stepIndex;
    active.plan.steps = [current, ...structuredClone(steps)];
    active.stepIndex = 0;
    active.continuationCheckedAt = undefined;
    this.state.version++;
    return true;
  }

  /** Called only after a successful turn actually completes, including playback. */
  completeTurn(version: number) {
    if (this.state.enabled && this.state.version === version && this.state.active)
      this.state.active.completedTurns++;
  }
  /** Advance before the next assistant turn, after previous audio/text has finished. */
  beginTurn() {
    const active = this.state.active;
    if (
      !this.state.enabled ||
      !active ||
      active.completedTurns < 2 ||
      active.stepIndex >= active.plan.steps.length - 1
    )
      return undefined;
    active.stepIndex++;
    active.completedTurns = 0;
    active.continuationCheckedAt = undefined;
    this.state.version++;
    return this.currentStep();
  }
  reset() {
    this.state = {
      enabled: this.state.enabled,
      version: this.state.version + 1,
      dismissedTitles: [],
    };
  }
}
