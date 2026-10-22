import { randomUUID } from 'node:crypto';
import { scenePlanSchema, type ScenePlan, type SceneSnapshot } from '@digital-human/shared';

/** Scene actions are virtual events, never evidence about the real user's life. */
export class VirtualScene {
  private state: SceneSnapshot = { enabled: false, version: 0, dismissedTitles: [] };

  snapshot(): SceneSnapshot {
    return structuredClone(this.state);
  }
  configure(enabled: boolean) {
    if (this.state.enabled === enabled) return false;
    this.state.enabled = enabled;
    this.state.version++;
    return true;
  }
  propose(plan: ScenePlan) {
    const parsed = scenePlanSchema.safeParse(plan);
    if (!this.state.enabled || this.state.proposal || !parsed.success) return false;
    const steps = parsed.data.steps;
    const actions = steps.map((step) => `${step.location}\n${step.activity}`.toLocaleLowerCase());
    const narrations = steps.map((step) => step.narration.toLocaleLowerCase());
    if (new Set(actions).size !== actions.length || new Set(narrations).size !== narrations.length)
      return false;
    const title = parsed.data.title.toLocaleLowerCase();
    if (this.state.dismissedTitles.some((value) => value.toLocaleLowerCase() === title))
      return false;
    if (this.state.active?.plan.title.toLocaleLowerCase() === title) return false;
    // Never replace an outing that's still in progress with a new one.
    if (this.state.active && this.state.active.stepIndex < this.state.active.plan.steps.length - 1)
      return false;
    this.state.proposal = { ...parsed.data, id: randomUUID() };
    this.state.version++;
    return true;
  }
  decide(id: string, version: number, accept: boolean) {
    if (!this.state.enabled || this.state.version !== version || this.state.proposal?.id !== id)
      return undefined;
    const plan = this.state.proposal;
    this.state.proposal = undefined;
    if (accept) this.state.active = { plan, stepIndex: 0, completedTurns: 0 };
    else this.state.dismissedTitles = [...this.state.dismissedTitles, plan.title].slice(-5);
    this.state.version++;
    return { accepted: accept, step: accept ? this.currentStep() : undefined };
  }
  currentStep() {
    const active = this.state.active;
    if (!active) return undefined;
    return {
      id: `${active.plan.id}:${active.stepIndex}`,
      step: active.plan.steps[active.stepIndex],
      index: active.stepIndex,
      total: active.plan.steps.length,
    };
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
