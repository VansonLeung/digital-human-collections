import { aboutMeMaxLength, type ConversationPreferences } from '@digital-human/shared';

type Props = ConversationPreferences & {
  disabled: boolean;
  onFocusChange: (value: boolean) => void;
  onScenesChange: (value: boolean) => void;
  onAutoEnterChange: (value: boolean) => void;
  onRecoveryChange: (value: boolean) => void;
  onAboutMeChange: (value: string) => void;
};

export function ConversationFocusControls({
  getToKnowEachOther,
  virtualScenesEnabled,
  autoEnterScenes,
  autoRecoverStalls,
  aboutMe,
  disabled,
  onFocusChange,
  onScenesChange,
  onAutoEnterChange,
  onRecoveryChange,
  onAboutMeChange,
}: Props) {
  return (
    <>
      <label className="conversation-toggle">
        <input
          type="checkbox"
          aria-label="Virtual scenes"
          checked={virtualScenesEnabled}
          disabled={disabled}
          onChange={(event) => onScenesChange(event.target.checked)}
        />
        Virtual scenes · 情境推進
      </label>
      <p className="settings-hint">
        Small steps advance after two completed Mira replies. Chat continues while a suggestion is
        pending. Scene cards carry the narration; voices speak only dialogue.
      </p>
      <label className="conversation-toggle">
        <input
          type="checkbox"
          aria-label="Automatically enter suggested scenes"
          checked={autoEnterScenes}
          disabled={disabled || !virtualScenesEnabled}
          onChange={(event) => onAutoEnterChange(event.target.checked)}
        />
        Automatically enter suggested scenes · 自動開始情境
      </label>
      <p className="settings-hint">
        Start a valid proposal after Mira finishes speaking or displaying her phrases. Off means you
        choose when to start.
      </p>
      <label className="conversation-toggle">
        <input
          type="checkbox"
          aria-label="Automatically recover stalled conversations"
          checked={autoRecoverStalls}
          disabled={disabled}
          onChange={(event) => onRecoveryChange(event.target.checked)}
        />
        Automatically recover stalled conversations · 自動打破重複
      </label>
      <p className="settings-hint">
        If the normal retry still repeats dialogue, try a related angle, then a fresh topic. Pause
        if both fail. The automatic turn limit still applies.
      </p>
      <label className="conversation-toggle">
        <input
          type="checkbox"
          aria-label="Get to know each other"
          checked={getToKnowEachOther}
          disabled={disabled}
          onChange={(event) => onFocusChange(event.target.checked)}
        />
        Get to know each other · 了解彼此
      </label>
      <p className="settings-hint">
        Encourage attentive replies and natural curiosity from both speakers. Teasing is optional;
        every reply does not need a question.
      </p>
      <label className="about-me-field">
        About me · 關於我 (optional)
        <textarea
          aria-label="About me"
          aria-describedby="about-me-hint"
          value={aboutMe}
          disabled={disabled}
          maxLength={aboutMeMaxLength}
          rows={3}
          placeholder="Share a few interests, preferences or everyday details you want them to know."
          onChange={(event) => onAboutMeChange(event.target.value)}
        />
      </label>
      <p className="settings-hint" id="about-me-hint">
        The guy represents you and uses details you supply. This profile is saved in this browser
        and included when generating replies, even with the focus mode off. Automatic dialogue does
        not update it. Editing pauses auto replies.
      </p>
    </>
  );
}
