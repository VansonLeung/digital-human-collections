import { aboutMeMaxLength, type ConversationPreferences } from '@digital-human/shared';

type Props = ConversationPreferences & {
  disabled: boolean;
  onFocusChange: (value: boolean) => void;
  onScenesChange: (value: boolean) => void;
  onAutoEnterChange: (value: boolean) => void;
  onRecoveryChange: (value: boolean) => void;
  onVariationChange: (value: boolean) => void;
  onAboutMeChange: (value: string) => void;
  onMiraBehaviorChange: (value: string) => void;
  onMiraHopChange: (value: boolean) => void;
};

export function ConversationFocusControls({
  getToKnowEachOther,
  virtualScenesEnabled,
  autoEnterScenes,
  autoRecoverStalls,
  naturalVariation,
  aboutMe,
  miraBehavior,
  miraAngryHopEnabled,
  disabled,
  onFocusChange,
  onScenesChange,
  onAutoEnterChange,
  onRecoveryChange,
  onVariationChange,
  onAboutMeChange,
  onMiraBehaviorChange,
  onMiraHopChange,
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
        Small steps advance after two completed Mira replies. An agreed new outing can replace an
        unfinished plan. Chat continues while suggestions are pending; narration stays in scene
        cards.
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
        Start an outing only after both speakers agree to go now and Mira finishes her reply.
        Invitations and future plans stay pending. Off means you choose when to start.
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
          aria-label="Natural conversation variation"
          checked={naturalVariation}
          disabled={disabled}
          onChange={(event) => onVariationChange(event.target.checked)}
        />
        Natural variation · 自然變化
      </label>
      <p className="settings-hint">
        Vary tone and contribution, usually across 2–4 spoken phrases with occasional shorter
        reactions. Teasing, tsundere reactions and taking charge are optional. Stable facts stay
        consistent.
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
        About Mira · 關於 Mira (private)
        <textarea
          aria-label="About Mira"
          value={miraBehavior}
          disabled={disabled}
          maxLength={aboutMeMaxLength}
          rows={3}
          onChange={(event) => onMiraBehaviorChange(event.target.value)}
          placeholder="Mira 暗暗喜歡我，被開玩笑揭穿時會害羞，偶爾嬲爆跳。"
        />
      </label>
      <p className="settings-hint">
        Only Mira receives this private character profile. The guy learns about her through
        dialogue, not this field. Saved in this browser; editing pauses auto replies.
      </p>
      <label className="conversation-toggle">
        <input
          type="checkbox"
          aria-label="Embarrassed angry-hop reaction"
          checked={miraAngryHopEnabled}
          disabled={disabled}
          onChange={(event) => onMiraHopChange(event.target.checked)}
        />
        Embarrassed angry hop · 被揭穿時嬲爆跳
      </label>
      <p className="settings-hint">
        Flustered denial uses a turn for mild shyness and a hop for strong playful embarrassment.
        Hops occur at most once per reply, with three completed Mira replies between hops. Turning
        remains available while hopping is off or cooling down.
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
          placeholder="Your private background, interests and preferences for the guy to draw on."
          onChange={(event) => onAboutMeChange(event.target.value)}
        />
      </label>
      <p className="settings-hint" id="about-me-hint">
        Only the guy receives this private profile when drafting your messages. Mira learns these
        details only when you share them in conversation. Saved in this browser; automatic dialogue
        does not update it. Editing pauses auto replies.
      </p>
    </>
  );
}
