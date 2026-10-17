import { poseNameSchema, poseLabels, type PoseName } from '@digital-human/shared';

export function PoseControls(props: {
  disabled: boolean;
  strength: number;
  holdSeconds: number;
  onStrength: (value: number) => void;
  onHoldSeconds: (value: number) => void;
  onPreview: (name: PoseName) => void;
  onStop: () => void;
}) {
  return (
    <details className="pose-controls">
      <summary>VRM poses · 姿勢</summary>
      <div className="pose-options">
        <label>
          Strength <output>{Math.round(props.strength * 100)}%</output>
          <input
            type="range"
            aria-label="Pose strength"
            min={0.2}
            max={1}
            step={0.05}
            value={props.strength}
            onChange={(event) => props.onStrength(Number(event.target.value))}
          />
        </label>
        <label>
          Hold (seconds)
          <input
            type="number"
            aria-label="Pose hold seconds"
            min={0.5}
            max={10}
            step={0.5}
            value={props.holdSeconds}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 0.5 && value <= 10) props.onHoldSeconds(value);
            }}
          />
        </label>
      </div>
      <div className="pose-buttons">
        {poseNameSchema.options.map((name) => (
          <button
            key={name}
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPreview(name)}
          >
            {poseLabels[name]}
          </button>
        ))}
        <button type="button" disabled={props.disabled} onClick={props.onStop}>
          Return to idle
        </button>
      </div>
      <p>
        Preview a pose any time, including while speaking. Strength affects previews; hold time also
        applies to poses chosen by the LLM. Dramatic poses widen the camera automatically.
      </p>
    </details>
  );
}
