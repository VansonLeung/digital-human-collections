import { userPhraseListSchema, type UserSpeechPlan } from '@digital-human/shared';

export function UserMessageSpeechControls({
  plan,
  active,
  automatic,
  phase,
  configured,
  blocked,
  onEdit,
  onSpeak,
  onDismiss,
}: {
  plan?: UserSpeechPlan;
  active: boolean;
  automatic: boolean;
  phase: string;
  configured: boolean;
  blocked: boolean;
  onEdit: (index: number, text: string) => void;
  onSpeak: () => void;
  onDismiss: () => void;
}) {
  if (automatic || (!plan && !active)) return null;
  return (
    <div className="user-speech-preview" aria-label="Spoken message preview">
      <p>
        {active
          ? phase === 'preparing'
            ? 'Preparing your spoken message…'
            : phase === 'synthesizing'
              ? 'Preparing your male voice…'
              : phase === 'paused'
                ? 'Your voice is paused.'
                : 'Speaking your reply · male voice'
          : 'Review your phrases before speaking and sending.'}
      </p>
      {!configured && (
        <p>Configure a male reference voice in the TTS service to enable playback.</p>
      )}
      <div className="user-speech-fields">
        {plan?.phrases.map((text, index) => (
          <label key={index}>
            Phrase {index + 1}
            <textarea
              aria-label={`Spoken phrase ${index + 1}`}
              value={text}
              disabled={active}
              maxLength={600}
              onChange={(event) => onEdit(index, event.target.value)}
              rows={2}
            />
          </label>
        ))}
      </div>
      {!active && plan && (
        <div>
          <button
            type="button"
            onClick={onSpeak}
            disabled={
              blocked || !configured || !userPhraseListSchema.safeParse(plan.phrases).success
            }
          >
            Speak &amp; send
          </button>
          <button type="button" onClick={onDismiss}>
            Dismiss spoken preview
          </button>
        </div>
      )}
    </div>
  );
}
