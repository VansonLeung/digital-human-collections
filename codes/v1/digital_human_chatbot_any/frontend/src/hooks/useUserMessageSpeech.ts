import { useEffect, useRef, useState } from 'react';
import type { ReplyDiagnostic } from '@digital-human/shared';
import {
  UserMessageSpeechController,
  type UserSpeechContext,
  type UserSpeechState,
} from '../audio/UserMessageSpeechController';

export function useUserMessageSpeech(options: {
  context: UserSpeechContext;
  draft: string;
  personaId: string;
  connected: boolean;
  muted: boolean;
  onPhrase: (group: string, index: number, text: string) => void;
  onInterrupted: (group: string) => void;
  onCommit: (
    text: string,
    context: UserSpeechContext,
    group: string,
    automatic: boolean,
  ) => boolean;
  onError: (message: string, diagnostic?: ReplyDiagnostic) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<UserSpeechState>({ phase: 'idle', automatic: false });
  const controller = useRef<UserMessageSpeechController | undefined>(undefined);
  controller.current ??= new UserMessageSpeechController({
    changed: setState,
    phraseStarted: (...args) => latest.current.onPhrase(...args),
    interrupted: (...args) => latest.current.onInterrupted(...args),
    commit: (...args) => latest.current.onCommit(...args),
    error: (...args) => latest.current.onError(...args),
  });
  useEffect(() => {
    controller.current!.cancel(true);
  }, [
    options.context.sessionId,
    options.context.revision,
    options.context.language,
    options.context.localizedProfanity,
    options.context.getToKnowEachOther,
    options.context.virtualScenesEnabled,
    options.context.autoEnterScenes,
    options.context.autoRecoverStalls,
    options.context.aboutMe,
    options.draft,
    options.personaId,
    options.connected,
  ]);
  useEffect(() => {
    controller.current!.setMuted(options.muted);
  }, [options.muted]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) controller.current!.cancel();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      controller.current!.dispose();
    };
  }, []);
  const active = !['idle', 'preview'].includes(state.phase);
  return {
    ...state,
    active,
    prepare: (kind: 'automatic' | 'rewrite', text = '', signal?: AbortSignal) =>
      controller.current!.prepare(latest.current.context, kind, text, signal),
    speak: (automatic = false, signal?: AbortSignal) =>
      controller.current!.speak(latest.current.context, automatic, signal),
    edit: (index: number, text: string) => controller.current!.edit(index, text),
    cancel: (clear = false) => controller.current!.cancel(clear),
    unlock: () => controller.current!.unlock(),
    togglePause: () => controller.current!.togglePause(),
  };
}
