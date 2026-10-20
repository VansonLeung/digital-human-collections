import { aboutMeMaxLength, type ConversationPreferences } from '@digital-human/shared';

type Props = ConversationPreferences & {
  disabled: boolean;
  onFocusChange: (value: boolean) => void;
  onAboutMeChange: (value: string) => void;
};

export function ConversationFocusControls({
  getToKnowEachOther,
  aboutMe,
  disabled,
  onFocusChange,
  onAboutMeChange,
}: Props) {
  return (
    <>
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
