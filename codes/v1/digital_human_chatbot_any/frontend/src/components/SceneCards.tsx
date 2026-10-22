import type { SceneSnapshot, SceneStep } from '@digital-human/shared';

export function SceneEventCard({ step }: { step: SceneStep }) {
  return (
    <div className="scene-event-card">
      <span className="scene-card-label">Virtual scene · 情境</span>
      <p>{step.narration}</p>
      <small>
        {step.location} · {step.activity}
      </small>
    </div>
  );
}

export function SceneStatus({ scene }: { scene?: SceneSnapshot }) {
  const active = scene?.active;
  if (!scene?.enabled) return null;
  if (!active)
    return <div className="scene-status">Virtual scenes · waiting for an activity suggestion</div>;
  const step = active.plan.steps[active.stepIndex];
  return (
    <div className="scene-status" aria-label="Current virtual scene">
      {step.location} · {step.activity}
      <span>
        {active.stepIndex + 1}/{active.plan.steps.length}
      </span>
    </div>
  );
}

export function SceneProposalCard({
  scene,
  disabled,
  onDecide,
}: {
  scene?: SceneSnapshot;
  disabled: boolean;
  onDecide: (accept: boolean) => void;
}) {
  if (!scene?.enabled || !scene.proposal) return null;
  const proposal = scene.proposal;
  return (
    <div className="scene-proposal-card">
      <span className="scene-card-label">Suggested virtual scene · 情境建議</span>
      <strong>{proposal.title}</strong>
      <details>
        <summary>View scene steps</summary>
        <ol>
          {proposal.steps.map((step, index) => (
            <li key={index}>{step.narration}</li>
          ))}
        </ol>
      </details>
      <div className="scene-actions">
        <button type="button" disabled={disabled} onClick={() => onDecide(true)}>
          Start this scene
        </button>
        <button type="button" disabled={disabled} onClick={() => onDecide(false)}>
          Keep chatting
        </button>
      </div>
    </div>
  );
}
