import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Mic,
  Square,
  Volume2,
  VolumeX,
  Maximize2,
  RotateCcw,
  Pause,
  Play,
  ChevronDown,
  Sparkles,
  RefreshCw,
  X,
  Check,
  MessageCircle,
} from 'lucide-react';
import {
  eventSchema,
  type Command,
  type Health,
  type ReplyLanguage,
  type Persona,
  type ServerEvent,
  type ReplyDiagnostic,
} from '@digital-human/shared';
import type { AvatarRenderer } from './avatars/types';
import { SpeechQueuePlayer } from './audio/SpeechQueuePlayer';
import { useReplySuggestion } from './hooks/useReplySuggestion';
import { useProactiveChat } from './hooks/useProactiveChat';
import { ReplyDiagnostics } from './components/ReplyDiagnostics';
import { PoseControls } from './components/PoseControls';
import { useSettings } from './hooks/useSettings';
import { useAutoReply } from './hooks/useAutoReply';
import { usePhraseDisplay } from './hooks/usePhraseDisplay';
import { useUserMessageSpeech } from './hooks/useUserMessageSpeech';
import { ConversationFocusControls } from './components/ConversationFocusControls';
import { UserMessageSpeechControls } from './components/UserMessageSpeechControls';
import { TypingIndicator } from './components/TypingIndicator';

type Message = {
  id: string;
  turnId?: string;
  role: 'user' | 'assistant';
  text: string;
  interrupted?: boolean;
  personaName?: string;
  pending?: boolean;
  notSent?: boolean;
};

type Speech = Extract<ServerEvent, { type: 'speech.ready' }>;

const languages: Record<ReplyLanguage, string> = {
  auto: 'Auto · 跟隨輸入',
  en: 'English',
  zh: '普通話',
  yue: '廣東話',
};

export function App() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const preferences = useSettings();
  const {
    personaId,
    language,
    localizedProfanity,
    getToKnowEachOther,
    aboutMe,
    speech,
    muted,
    proactiveEnabled,
    idleSeconds,
    autoReplyEnabled,
    autoReplyMode,
    manualMessageMode,
    autoReplyDelaySeconds,
    autoReplyMaxTurns,
    displayMode,
    textPhraseDelaySeconds,
    poseStrength,
    poseHoldSeconds,
  } = preferences.settings;
  const setPersonaId = (value: string) => preferences.update('personaId', value);
  const setLanguage = (value: ReplyLanguage) => preferences.update('language', value);
  const setSpeech = (value: boolean) => preferences.update('speech', value);
  const setMuted = (value: boolean) => preferences.update('muted', value);
  const setProactiveEnabled = (value: boolean) => preferences.update('proactiveEnabled', value);
  const setIdleSeconds = (value: number) => preferences.update('idleSeconds', value);

  const [health, setHealth] = useState<Health>();
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState('Ready when you are');

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [avatarReady, setAvatarReady] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [paused, setPaused] = useState(false);
  const [caption, setCaption] = useState('');

  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [review, setReview] = useState(false);
  const [lastSpeech, setLastSpeech] = useState<Speech[]>();
  const [retry, setRetry] = useState(false);
  const [credits, setCredits] = useState(false);
  const [diagnostic, setDiagnostic] = useState<ReplyDiagnostic>();
  const [revision, setRevision] = useState(0);
  const [completedRevision, setCompletedRevision] = useState<number | null>(null);
  const turnSucceeded = useRef(false);
  const turnDisplay = useRef<{ id: string; mode: 'full' | 'phrases'; speech: boolean } | undefined>(
    undefined,
  );
  const proactiveTurn = useRef(false);
  const defaultDelayApplied = useRef(false);

  const canvas = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const renderer = useRef<AvatarRenderer | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const receiveEvent = useRef<(event: ServerEvent) => void>(() => {});
  const session = useRef('');
  const currentTurn = useRef<string | null>(null);
  const acceptTurn = useRef(false);
  const pendingSpokenSubmission = useRef<
    { group: string; original: string; text: string } | undefined
  >(undefined);
  const seq = useRef(0);

  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const mic = useRef<MediaStream | undefined>(undefined);
  const recordingTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const transcription = useRef<AbortController | undefined>(undefined);

  const speechPhrases = useRef<Speech[]>([]);
  const queueTurn = useRef<string | null>(null);

  const player = useRef<SpeechQueuePlayer | undefined>(undefined);
  player.current ??= new SpeechQueuePlayer(
    (shape) => renderer.current?.setMouth(shape),
    (value) => renderer.current?.setMouthOpening(value),
    (speaking) => renderer.current?.setSpeaking(speaking),
  );

  const persona = personas.find((p) => p.id === personaId);
  const selectedPersona = useRef<Persona | undefined>(undefined);
  selectedPersona.current = persona;

  const suggestion = useReplySuggestion({
    draft,
    language,
    localizedProfanity,
    getToKnowEachOther,
    aboutMe,
    revision,
    blocked: !connected || busy || recording || transcribing,
    onDraft: setDraft,
    onError: (message, details) => {
      setError(message);
      setDiagnostic(details);
    },
  });
  const userSpeech = useUserMessageSpeech({
    context: {
      sessionId: session.current,
      revision,
      language,
      localizedProfanity,
      getToKnowEachOther,
      aboutMe,
    },
    draft,
    personaId,
    connected,
    muted,
    onPhrase: (group, index, text) => {
      renderer.current?.setSpeaking(false);
      setCaption('');
      setMessages((items) =>
        items.some((item) => item.id === `${group}:${index}`)
          ? items
          : [
              ...items,
              { id: `${group}:${index}`, turnId: group, role: 'user', text, pending: true },
            ],
      );
    },
    onInterrupted: (group) =>
      setMessages((items) =>
        items.map((item) =>
          item.turnId === group && item.pending ? { ...item, pending: false, notSent: true } : item,
        ),
      ),
    onCommit: (text, context, group, automatic) => {
      if (context.sessionId !== session.current || context.revision !== revision) return false;
      return send(text, automatic, {
        group,
        revision: context.revision,
        language: context.language,
      });
    },
    onError: (message, details) => {
      setError(message);
      setDiagnostic(details);
    },
  });
  const maleVoiceConfigured = health?.tts.voiceProfiles?.user_male?.configured === true;
  const phraseDisplay = usePhraseDisplay((phrase) => {
    const id = `${phrase.turnId}:phrase:${phrase.phraseIndex}`;
    setMessages((items) => {
      if (items.some((item) => item.id === id)) return items;
      const placeholder = items.find((item) => item.id === phrase.turnId);
      const personaName = placeholder?.personaName ?? selectedPersona.current?.name;
      return [
        ...items.filter((item) => !(item.id === phrase.turnId && !item.text)),
        { id, turnId: phrase.turnId, role: 'assistant', text: phrase.text, personaName },
      ];
    });
    setCaption(phrase.text);
  });
  const autoReply = useAutoReply({
    enabled: autoReplyEnabled,
    delaySeconds: autoReplyDelaySeconds,
    maxTurns: autoReplyMaxTurns,
    completedRevision,
    blocked:
      !connected ||
      busy ||
      phraseDisplay.revealing ||
      paused ||
      recording ||
      transcribing ||
      (suggestion.loading && !suggestion.autoLoading) ||
      !!suggestion.preview ||
      !!draft.trim() ||
      (userSpeech.active && !userSpeech.automatic) ||
      (!!userSpeech.plan && !userSpeech.automatic) ||
      !!error,
    generateAndSend: async (signal) => {
      if (autoReplyMode === 'spoken') {
        if (!maleVoiceConfigured) {
          setError(
            'Configure the male reference voice in the TTS service, then refresh service readiness.',
          );
          return false;
        }
        const plan = await userSpeech.prepare('automatic', '', signal);
        if (signal.aborted || !plan) return false;
        return userSpeech.speak(true, signal);
      }
      const text = await suggestion.generate(session.current, { signal, automatic: true });
      if (signal.aborted || !text) return false;
      return send(text, true);
    },
  });
  const proactive = useProactiveChat({
    enabled: proactiveEnabled && !autoReplyEnabled,
    delaySeconds: idleSeconds,
    blocked:
      userSpeech.active ||
      (!!userSpeech.plan && !userSpeech.automatic) ||
      !connected ||
      busy ||
      phraseDisplay.revealing ||
      recording ||
      transcribing ||
      paused ||
      suggestion.loading ||
      !!suggestion.preview ||
      !!draft.trim() ||
      !!error ||
      !messages.some((message) => message.role === 'assistant' && !!message.text),
    onFollowUp: sendProactive,
    onActivity: () => {
      if (proactiveTurn.current && (state !== 'Speaking' || document.hidden)) stop();
    },
  });

  const autoReplyTyping =
    suggestion.autoLoading ||
    (autoReply.pending &&
      userSpeech.automatic &&
      ['preparing', 'synthesizing'].includes(userSpeech.phase));

  useEffect(() => {
    if (health?.proactiveIdleSeconds && !defaultDelayApplied.current) {
      defaultDelayApplied.current = true;
      if (preferences.saved.idleSeconds === undefined) setIdleSeconds(health.proactiveIdleSeconds);
    }
  }, [health?.proactiveIdleSeconds]);

  useEffect(() => {
    if (connected)
      command({
        type: 'proactive.configure',
        enabled: proactiveEnabled && !autoReplyEnabled,
        delaySeconds: idleSeconds,
      });
  }, [connected, proactiveEnabled, autoReplyEnabled, idleSeconds]);

  useEffect(() => {
    player.current!.setMuted(muted);
  }, [muted]);
  useEffect(() => {
    if (avatarReady) renderer.current?.setPoseHoldSeconds?.(poseHoldSeconds);
  }, [avatarReady, poseHoldSeconds]);
  useEffect(() => {
    if (personas.length && !personas.some((item) => item.id === personaId))
      setPersonaId(personas[0].id);
  }, [personas, personaId]);

  const refreshHealth = () =>
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError('Cannot reach the application backend.'));

  useEffect(() => {
    void refreshHealth();
    void fetch('/api/personas')
      .then((r) => r.json())
      .then(setPersonas)
      .catch(() => setError('Cannot load personas.'));
    const interval = setInterval(refreshHealth, 20000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!canvas.current || !persona) return;
    let disposed = false;
    let instance: AvatarRenderer | undefined;
    setAvatarReady(false);
    setAvatarError('');
    player.current!.stop();
    void (async () => {
      try {
        const { renderer: kind, modelUrl } = persona;
        const Renderer =
          kind === 'vrm'
            ? (await import('./avatars/VrmRenderer')).VrmRenderer
            : (await import('./avatars/Live2DRenderer')).Live2DRenderer;
        if (disposed) return;
        instance = new Renderer(canvas.current!);
        renderer.current = instance;
        await instance.load(modelUrl);
        if (!disposed) setAvatarReady(true);
      } catch (error) {
        if (!disposed) {
          console.error('Avatar could not load', error);
          setAvatarError('This persona could not load. Run setup or choose another persona.');
        }
      }
    })();
    return () => {
      disposed = true;
      instance?.dispose();
      if (renderer.current === instance) renderer.current = undefined;
    };
  }, [persona]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, state, autoReplyTyping]);

  useEffect(
    () => () => {
      socket.current?.close();
      player.current?.dispose();
      mic.current?.getTracks().forEach((t) => t.stop());
      clearInterval(recordingTimer.current);
      transcription.current?.abort();
    },
    [],
  );

  function command(value: Command) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value));
  }

  function beginPlayback(turnId: string, replay: boolean) {
    setPaused(false);
    if (replay) {
      setBusy(true);
      setState('Preparing voice');
    }
    player.current!.begin({
      phraseStarted: (phrase) => {
        renderer.current?.beginPhrase(phrase.performance, phrase.duration);
        setCaption(phrase.text);
        setState('Speaking');
        if (!replay && turnDisplay.current?.id === turnId && turnDisplay.current.mode === 'phrases')
          phraseDisplay.phrase({ turnId, phraseIndex: phrase.phraseIndex, text: phrase.text });
        if (!replay && currentTurn.current === turnId)
          command({ type: 'playback.started', turnId });
      },
      phraseTime: (seconds) => renderer.current?.setPlaybackTime(seconds),
      ended: () => {
        setPaused(false);
        if (replay) {
          setBusy(false);
          setState('Ready');
        } else if (currentTurn.current === turnId) command({ type: 'playback.ended', turnId });
      },
      failed: (error) => {
        autoReply.pause();
        phraseDisplay.stop();
        setError(error.message || 'Playback failed.');
        setLastSpeech(undefined);
        if (replay) {
          setBusy(false);
          setState('Ready');
        } else if (currentTurn.current === turnId) command({ type: 'playback.failed', turnId });
      },
    });
  }

  function playReply(phrases: Speech[]) {
    if (!phrases.length) return;
    beginPlayback(phrases[0].turnId!, true);
    for (const phrase of phrases) void player.current!.enqueue(phrase);
    player.current!.finish(phrases.length);
  }

  function receive(event: ServerEvent) {
    if (event.seq <= seq.current) return;
    seq.current = event.seq;
    setRevision(event.revision);
    if (event.type === 'session.ready') {
      setConnected(true);
      setState('Ready');
      return;
    }
    if (event.type === 'session.reset') {
      pendingSpokenSubmission.current = undefined;
      userSpeech.cancel(true);
      currentTurn.current = null;
      setBusy(false);
      setMessages([]);
      setCaption('');
      setLastSpeech(undefined);
      setDiagnostic(undefined);
      proactive.suppress();
      suggestion.cancel();
      phraseDisplay.stop();
      autoReply.pause();
      setCompletedRevision(null);
      setState('Ready');
      return;
    }
    if (event.type === 'turn.started') {
      if (!acceptTurn.current) return;
      if (event.origin === 'user' && pendingSpokenSubmission.current?.text === event.text)
        pendingSpokenSubmission.current = undefined;
      currentTurn.current = event.turnId;
      turnSucceeded.current = false;
      turnDisplay.current = { id: event.turnId!, mode: event.displayMode, speech: event.speech };
      if (event.displayMode === 'phrases')
        phraseDisplay.begin(event.turnId!, event.speech, textPhraseDelaySeconds);
      proactiveTurn.current = event.origin === 'proactive';
      acceptTurn.current = false;
      setBusy(true);
      setMessages((m) => [
        ...m,
        {
          id: event.turnId!,
          turnId: event.turnId!,
          role: 'assistant',
          text: '',
          personaName: selectedPersona.current?.name,
        },
      ]);
      return;
    }
    if (event.type === 'proactive.skipped') {
      if (proactiveTurn.current) {
        proactiveTurn.current = false;
        acceptTurn.current = false;
        setBusy(false);
        setState('Ready');
      }
      return;
    }
    if (event.type === 'error' && !event.turnId) {
      recoverSpokenSubmission();
      setError(event.message);
      autoReply.pause();
      setDiagnostic(event.diagnostic);
      if (!currentTurn.current) {
        proactiveTurn.current = false;
        acceptTurn.current = false;
        setBusy(false);
        setState('Ready');
      }
      return;
    }
    if (!event.turnId || event.turnId !== currentTurn.current) return;
    switch (event.type) {
      case 'state.changed':
        setState(event.state);
        break;
      case 'answer.delta':
        if (turnDisplay.current?.mode === 'phrases') break;
        setMessages((m) =>
          m.map((v) => (v.id === event.turnId ? { ...v, text: v.text + event.text } : v)),
        );
        break;
      case 'answer.final':
        turnSucceeded.current = true;
        if (turnDisplay.current?.mode === 'phrases') {
          phraseDisplay.finish(event.turnId);
          break;
        }
        setMessages((m) => m.map((v) => (v.id === event.turnId ? { ...v, text: event.text } : v)));
        if (queueTurn.current !== event.turnId) setCaption(event.text);
        break;
      case 'answer.phrase':
        if (turnDisplay.current?.mode === 'phrases' && !turnDisplay.current.speech)
          phraseDisplay.phrase({
            turnId: event.turnId,
            phraseIndex: event.phraseIndex,
            text: event.text,
          });
        break;
      case 'speech.ready': {
        if (queueTurn.current !== event.turnId) {
          queueTurn.current = event.turnId;
          speechPhrases.current = [];
          beginPlayback(event.turnId!, false);
        }
        speechPhrases.current.push(event);
        void player.current!.enqueue(event);
        break;
      }
      case 'speech.queue.finished':
        setLastSpeech([...speechPhrases.current]);
        player.current!.finish(event.phraseCount);
        break;
      case 'error':
        autoReply.pause();
        phraseDisplay.stop();
        turnSucceeded.current = false;
        player.current!.stop();
        setLastSpeech(undefined);
        setError(event.message);
        setDiagnostic(event.diagnostic);
        setMessages((items) =>
          items.map((item) =>
            item.id === event.turnId && !item.text
              ? { ...item, text: 'Reply unavailable. See error details below.' }
              : item,
          ),
        );
        proactive.suppress();
        setRetry(event.retryable);
        break;
      case 'turn.interrupted':
        autoReply.pause();
        phraseDisplay.stop();
        player.current!.stop();
        setMessages((m) =>
          m.map((v) => (v.turnId === event.turnId ? { ...v, interrupted: true } : v)),
        );
        currentTurn.current = null;
        proactiveTurn.current = false;
        setBusy(false);
        setState('Ready');
        break;
      case 'turn.completed':
        if (turnSucceeded.current) setCompletedRevision(event.revision);
        currentTurn.current = null;
        proactiveTurn.current = false;
        setBusy(false);
        setState('Ready');
        void refreshHealth();
        break;
    }
  }

  // Keep event handling current when preferences change within a live session.
  receiveEvent.current = receive;

  async function start() {
    setError('');
    setDiagnostic(undefined);
    setState('Connecting');
    try {
      await Promise.all([player.current!.unlock(), userSpeech.unlock()]);
      const response = await fetch('/api/sessions', { method: 'POST' });
      if (!response.ok) throw new Error('Unable to create a session.');
      const data = await response.json();
      session.current = data.id;
      seq.current = 0;
      socket.current?.close();
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sessions/${data.id}/events`,
      );
      socket.current = ws;
      ws.onmessage = (message) => {
        const parsed = eventSchema.safeParse(JSON.parse(message.data));
        if (parsed.success) receiveEvent.current(parsed.data);
      };
      ws.onclose = () => {
        if (socket.current !== ws) return;
        player.current!.stop();
        phraseDisplay.stop();
        autoReply.pause();
        userSpeech.cancel(true);
        recoverSpokenSubmission();
        setCompletedRevision(null);
        currentTurn.current = null;
        setConnected(false);
        setBusy(false);
        setState('Disconnected');
      };
      ws.onerror = () => setError('Connection failed. Check that the backend is running.');
    } catch (e) {
      setState('Ready when you are');
      setError((e as Error).message);
    }
  }

  function send(
    text = draft,
    automated = false,
    spoken?: { group: string; revision: number; language: ReplyLanguage },
  ) {
    if (!connected || busy || phraseDisplay.revealing || recording || transcribing || !text.trim())
      return false;
    if (!spoken && userSpeech.active) return false;
    pendingSpokenSubmission.current = spoken
      ? { group: spoken.group, original: draft || text, text: text.trim() }
      : undefined;
    if (!automated) autoReply.restart();
    phraseDisplay.stop();
    setError('');
    setDiagnostic(undefined);
    suggestion.cancel();
    proactive.arm();
    proactiveTurn.current = false;
    setRetry(false);
    setReview(false);
    setDraft('');
    setBusy(true);
    setState('Thinking');
    setCaption('');
    setLastSpeech(undefined);
    if (spoken)
      setMessages((items) =>
        items.map((item) =>
          item.turnId === spoken.group ? { ...item, pending: false, notSent: false } : item,
        ),
      );
    else setMessages((m) => [...m, { id: crypto.randomUUID(), role: 'user', text: text.trim() }]);
    acceptTurn.current = true;
    void player.current!.unlock();
    command({
      type: 'turn.send',
      automatic: automated,
      displayMode,
      text: text.trim(),
      personaId,
      language: spoken?.language ?? language,
      speech: speech && avatarReady,
      localizedProfanity,
      getToKnowEachOther,
      aboutMe,
      ...(spoken ? { expectedRevision: spoken.revision } : {}),
    });
    return true;
  }

  function sendProactive() {
    if (!connected || busy || draft.trim() || recording || transcribing) return;
    proactiveTurn.current = true;
    acceptTurn.current = true;
    setBusy(true);
    setState('Thinking');
    setLastSpeech(undefined);
    setDiagnostic(undefined);
    command({
      type: 'turn.proactive',
      displayMode,
      revision,
      personaId,
      language,
      speech: speech && avatarReady,
      localizedProfanity,
      getToKnowEachOther,
      aboutMe,
    });
  }

  function recoverSpokenSubmission() {
    const pending = pendingSpokenSubmission.current;
    pendingSpokenSubmission.current = undefined;
    if (!pending) return;
    setMessages((items) =>
      items.map((item) =>
        item.turnId === pending.group ? { ...item, pending: false, notSent: true } : item,
      ),
    );
    setDraft((current) => current || pending.original);
  }

  function stop() {
    autoReply.pause();
    userSpeech.cancel();
    phraseDisplay.stop();
    proactive.suppress();
    suggestion.cancel();
    proactiveTurn.current = false;
    player.current!.stop();
    renderer.current?.stopPose?.();
    queueTurn.current = null;
    speechPhrases.current = [];
    setLastSpeech(undefined);
    setPaused(false);
    acceptTurn.current = false;
    const id =
      currentTurn.current ?? (phraseDisplay.revealing ? turnDisplay.current?.id : undefined);
    command({ type: 'turn.stop', ...(id ? { turnId: id } : {}) });
    if (id) setMessages((m) => m.map((v) => (v.turnId === id ? { ...v, interrupted: true } : v)));
    currentTurn.current = null;
    setBusy(false);
    setState('Ready');
    transcription.current?.abort();
    setTranscribing(false);
  }

  function reset() {
    stop();
    userSpeech.cancel(true);
    command({ type: 'session.reset' });
    setMessages([]);
    setCaption('');
    setDraft('');
    setError('');
    setDiagnostic(undefined);
    setReview(false);
    setLastSpeech(undefined);
    setCompletedRevision(null);
  }

  async function record() {
    autoReply.pause();
    userSpeech.cancel(true);
    if (proactiveTurn.current) stop();
    suggestion.cancel();
    proactive.touch();
    if (recording) {
      recorder.current?.stop();
      return;
    }
    setError('');
    setReview(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.current = stream;
      const mime = ['audio/webm;codecs=opus', 'audio/mp4'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const instance = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.current = instance;
      const chunks: BlobPart[] = [];
      instance.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      instance.onstop = async () => {
        clearInterval(recordingTimer.current);
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setTranscribing(true);
        setState('Transcribing');
        const controller = new AbortController();
        transcription.current = controller;
        try {
          const form = new FormData();
          form.append('file', new Blob(chunks, { type: instance.mimeType }), 'question.audio');
          form.append('language', language);
          const response = await fetch(`/api/sessions/${session.current}/transcribe`, {
            method: 'POST',
            body: form,
            signal: controller.signal,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Transcription failed.');
          if (controller.signal.aborted) return;
          if (result.text?.trim()) {
            setDraft(result.text);
            setReview(true);
          } else setError('No speech was recognized. Try again or type your message.');
        } catch (e) {
          if (!controller.signal.aborted) setError((e as Error).message);
        } finally {
          if (transcription.current === controller) {
            setTranscribing(false);
            setState('Ready');
            transcription.current = undefined;
          }
        }
      };
      instance.start();
      setRecording(true);
      setSeconds(0);
      recordingTimer.current = setInterval(
        () =>
          setSeconds((n) => {
            if (n >= 58) instance.stop();
            return n + 1;
          }),
        1000,
      );
    } catch {
      mic.current?.getTracks().forEach((t) => t.stop());
      setError('Microphone unavailable or permission denied. You can still type a message.');
    }
  }

  function selectLanguage(value: ReplyLanguage) {
    setLanguage(value);
    if (value === 'yue' && !health?.cantoneseSpeech) {
      setSpeech(false);
      setError('Cantonese text and transcription are available. Speech awaits voice validation.');
    } else setError('');
  }

  async function prepareManualSpeech() {
    if (
      !connected ||
      busy ||
      phraseDisplay.revealing ||
      recording ||
      transcribing ||
      userSpeech.active ||
      !draft.trim()
    )
      return;
    autoReply.pause();
    suggestion.cancel();
    proactive.touch();
    setError('');
    setDiagnostic(undefined);
    await userSpeech.unlock();
    await userSpeech.prepare('rewrite', draft);
  }

  function submitManual() {
    if (manualMessageMode === 'spoken') void prepareManualSpeech();
    else send();
  }

  function updateConversationPreference(key: 'getToKnowEachOther', value: boolean): void;
  function updateConversationPreference(key: 'aboutMe', value: string): void;
  function updateConversationPreference(
    key: 'getToKnowEachOther' | 'aboutMe',
    value: boolean | string,
  ) {
    autoReply.pause();
    suggestion.cancel();
    userSpeech.cancel(true);
    if (key === 'getToKnowEachOther' && typeof value === 'boolean') preferences.update(key, value);
    if (key === 'aboutMe' && typeof value === 'string') preferences.update(key, value);
  }

  const disabled =
    busy || phraseDisplay.revealing || recording || transcribing || userSpeech.active;
  return (
    <div className="studio">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Persona home">
          <span className="brand-mark">
            <Sparkles size={20} />
          </span>
          persona<span className="brand-dot">.</span>
        </a>
        <span className="topbar-label">A conversation, brought to life</span>
        <div className="local-badge">
          <span />
          LOCAL STUDIO
        </div>
      </header>
      <main className="workspace">
        <section className="avatar-panel" ref={panel} aria-label="Digital presenter">
          <div className="avatar-header">
            <div className="presence">
              <span className={busy ? 'pulse' : ''} />
              {busy ? state : avatarReady ? 'Persona ready' : 'Preparing persona'}
            </div>
            <span className="renderer-label">
              {persona?.renderer === 'live2d' ? 'LIVE2D' : '3D AVATAR'}
            </span>
          </div>
          <div className="scene-decoration">
            <span />
            <span />
            <span />
          </div>
          <div className="avatar-canvas" ref={canvas} />
          {!avatarReady && (
            <div className="avatar-loading">
              {avatarError ? (
                <>
                  <MessageCircle />
                  <p>{avatarError}</p>
                </>
              ) : (
                <>
                  <span className="loader" />
                  <p>Bringing your persona to life…</p>
                </>
              )}
            </div>
          )}
          <div className="persona-name">
            <span>YOUR CONVERSATION PARTNER</span>
            <h1>
              {persona?.name || 'Mira'}
              <span> / </span>
              <small>{persona?.renderer === 'live2d' ? 'illustrated' : 'in 3D'}</small>
            </h1>
            <p>{persona?.description}</p>
          </div>
          {caption && (
            <div className="caption" aria-live="polite">
              {caption}
            </div>
          )}
          <div className="avatar-controls">
            <div className="control-pill">
              <button
                aria-label={muted ? 'Unmute voice' : 'Mute voice'}
                data-auto-reply-control
                onClick={() => {
                  player.current!.setMuted(!muted);
                  setMuted(!muted);
                }}
              >
                {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
              <span />
              <button
                aria-label={
                  (userSpeech.active ? userSpeech.phase === 'paused' : paused)
                    ? 'Resume speech'
                    : 'Pause speech'
                }
                data-auto-reply-control
                disabled={
                  state !== 'Speaking' &&
                  !['speaking', 'paused', 'synthesizing'].includes(userSpeech.phase)
                }
                onClick={() =>
                  userSpeech.active
                    ? void userSpeech.togglePause()
                    : void player
                        .current!.togglePause()
                        .then(() => setPaused(player.current!.paused))
                }
              >
                {(userSpeech.active ? userSpeech.phase === 'paused' : paused) ? (
                  <Play size={18} />
                ) : (
                  <Pause size={18} />
                )}
              </button>
              <button
                aria-label="Stop response"
                disabled={
                  !busy &&
                  !phraseDisplay.revealing &&
                  !suggestion.loading &&
                  !autoReplyEnabled &&
                  !userSpeech.active
                }
                onClick={stop}
              >
                <Square size={15} />
              </button>
            </div>
            <button
              className="fullscreen"
              aria-label="Fullscreen presenter"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void panel.current?.requestFullscreen();
              }}
            >
              <Maximize2 size={18} />
            </button>
          </div>
          <button className="credit-link" onClick={() => setCredits(!credits)}>
            AI presenter · model credits
          </button>
          {credits && (
            <div className="credits">
              <button aria-label="Close credits" onClick={() => setCredits(false)}>
                <X size={16} />
              </button>
              <p>{persona?.credit}</p>
              <a href={persona?.licenseUrl} target="_blank" rel="noreferrer">
                Model license ↗
              </a>
              <p>
                Conversation names describe this demo; original model authors retain their rights.
              </p>
            </div>
          )}
        </section>
        <section className="chat-panel" aria-label="Conversation">
          <div className="chat-header">
            <div className="assistant-icon">
              <Sparkles size={21} />
            </div>
            <div>
              <h2>Let’s talk</h2>
              <p>
                <span className={connected ? 'online' : ''} />
                {connected
                  ? userSpeech.active
                    ? userSpeech.phase === 'preparing'
                      ? 'Preparing your spoken message'
                      : userSpeech.phase === 'paused'
                        ? 'Your voice paused'
                        : 'Speaking your reply'
                    : state
                  : 'Your personal AI companion'}
              </p>
            </div>
            <button
              className="icon-button reset"
              aria-label="Clear conversation"
              disabled={!connected || recording}
              onClick={reset}
            >
              <RotateCcw size={18} />
            </button>
          </div>
          <div className="messages" role="log" aria-live="polite">
            {!messages.length && (
              <div className="welcome">
                <span className="eyebrow">A LITTLE CURIOSITY GOES A LONG WAY</span>
                <h3>
                  What’s on
                  <br />
                  your mind?
                </h3>
                <p>
                  Ask a question, explore an idea, or just say hello.
                  <br />
                  I’m here to make the conversation feel natural.
                </p>
                {!connected ? (
                  <button
                    className="start-button"
                    onClick={() => void start()}
                    disabled={state === 'Connecting'}
                  >
                    {state === 'Connecting' ? 'Connecting…' : 'Start conversation'}
                    <ArrowUp size={17} />
                  </button>
                ) : (
                  <div className="suggestions">
                    {[
                      'Tell me something surprising',
                      'Help me think through an idea',
                      'Introduce yourself',
                      '你識唔識講廣東話呀？',
                      '你會講國語嗎？',
                    ].map((text) => (
                      <button key={text} disabled={disabled} onClick={() => send(text)}>
                        {text}
                        <ArrowUp size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {messages.map((message) => (
              <div key={message.id} className={`message ${message.role}`}>
                <span className="message-label">
                  {message.role === 'user'
                    ? 'YOU'
                    : (message.personaName || persona?.name)?.toUpperCase()}
                </span>
                <div className="bubble">
                  {message.text || (
                    <TypingIndicator
                      label={`${message.personaName || persona?.name || 'Mira'} is typing`}
                    />
                  )}
                  {message.interrupted && <span className="interrupted">Interrupted</span>}
                  {message.notSent && <span className="interrupted">Not sent</span>}
                </div>
              </div>
            ))}
            {autoReplyTyping && (
              <div className="message user auto-reply-typing">
                <span className="message-label">YOU</span>
                <div className="bubble">
                  <TypingIndicator label="Your automatic reply is typing" />
                </div>
              </div>
            )}
            <div ref={end} />
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {diagnostic && <ReplyDiagnostics diagnostic={diagnostic} />}
          <UserMessageSpeechControls
            plan={userSpeech.plan}
            active={userSpeech.active}
            automatic={userSpeech.automatic}
            phase={userSpeech.phase}
            configured={maleVoiceConfigured}
            blocked={busy || phraseDisplay.revealing || recording || transcribing}
            onEdit={userSpeech.edit}
            onSpeak={() => {
              autoReply.pause();
              setError('');
              void userSpeech.speak();
            }}
            onDismiss={() => userSpeech.cancel(true)}
          />
          {suggestion.preview && (
            <div className="suggestion-preview">
              <p>{suggestion.preview}</p>
              <button type="button" onClick={suggestion.accept}>
                Use suggested reply
              </button>
              <button type="button" onClick={suggestion.cancel}>
                Dismiss suggestion
              </button>
            </div>
          )}
          {review && (
            <div className="review">
              <Check size={14} />
              Transcript ready. Edit it below before sending.
            </div>
          )}
          {(lastSpeech || retry) && !busy && !userSpeech.active && (
            <div className="replay-row">
              {lastSpeech && (
                <button onClick={() => void playReply(lastSpeech)}>
                  <Play size={13} />
                  Replay voice
                </button>
              )}
              {retry && (
                <button
                  onClick={() => {
                    const previous = [...messages].reverse().find((m) => m.role === 'user');
                    if (previous) send(previous.text);
                  }}
                >
                  <RefreshCw size={13} />
                  Try again
                </button>
              )}
            </div>
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitManual();
            }}
          >
            <textarea
              aria-label="Message"
              value={draft}
              onChange={(e) => {
                if (proactiveTurn.current) stop();
                suggestion.cancel();
                proactive.touch();
                setDraft(e.target.value);
              }}
              placeholder={
                recording
                  ? `Listening… ${seconds}s`
                  : transcribing
                    ? 'Transcribing your question…'
                    : 'Type a message…'
              }
              maxLength={4000}
              rows={1}
              disabled={
                !connected ||
                (busy && !proactiveTurn.current) ||
                recording ||
                transcribing ||
                (userSpeech.active && userSpeech.phase !== 'preparing')
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitManual();
                }
              }}
            />
            <button
              type="button"
              className="suggest-reply"
              aria-label="Suggest reply"
              title="Draft a reply for you to review and send"
              disabled={
                !connected ||
                disabled ||
                suggestion.loading ||
                !messages.some((message) => message.role === 'assistant' && !!message.text)
              }
              onClick={() => {
                setError('');
                setRetry(false);
                setDiagnostic(undefined);
                proactive.touch();
                void suggestion.generate(session.current);
              }}
            >
              {suggestion.loading ? <span className="loader" /> : <Sparkles size={18} />}
            </button>
            <button
              type="button"
              className={`mic-button ${recording ? 'recording' : ''}`}
              aria-label={recording ? 'Finish recording' : 'Record a question'}
              disabled={!connected || busy || transcribing}
              onClick={() => void record()}
            >
              {recording ? <Square size={18} /> : <Mic size={20} />}
            </button>
            <button
              className="send-button"
              type="submit"
              aria-label={
                manualMessageMode === 'spoken' ? 'Prepare spoken message' : 'Send message'
              }
              disabled={!connected || disabled || !draft.trim()}
            >
              <ArrowUp size={21} />
            </button>
          </form>
          <div className="chat-options">
            <label className="language">
              <select
                aria-label="Manual message mode"
                value={manualMessageMode}
                disabled={disabled}
                onChange={(event) => {
                  userSpeech.cancel(true);
                  preferences.update('manualMessageMode', event.target.value as 'text' | 'spoken');
                }}
              >
                <option value="text">Send as typed</option>
                <option value="spoken">Rewrite &amp; speak · male voice</option>
              </select>
              <ChevronDown size={13} />
            </label>
            <label className="language">
              <span>◉</span>
              <select
                aria-label="Reply language"
                value={language}
                disabled={disabled}
                onChange={(e) => selectLanguage(e.target.value as ReplyLanguage)}
              >
                {Object.entries(languages).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </label>
            <label className="speech-toggle">
              <input
                type="checkbox"
                checked={speech}
                disabled={disabled || (language === 'yue' && !health?.cantoneseSpeech)}
                onChange={(e) => setSpeech(e.target.checked)}
              />
              <span />
              Spoken replies
            </label>
          </div>
          <div className="proactive-options">
            <label>
              <input
                type="checkbox"
                aria-label="Proactive chat"
                checked={proactiveEnabled}
                onChange={(event) => setProactiveEnabled(event.target.checked)}
              />{' '}
              Proactive chat
            </label>
            <label>
              After{' '}
              <input
                type="number"
                aria-label="Proactive delay seconds"
                min={1}
                max={3600}
                value={idleSeconds}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 3600) setIdleSeconds(value);
                }}
              />{' '}
              seconds
            </label>
          </div>
          <div className="auto-reply-options">
            <label>
              <input
                type="checkbox"
                aria-label="Auto-LLM-suggest-and-reply"
                checked={autoReplyEnabled}
                onChange={(event) => {
                  preferences.update('autoReplyEnabled', event.target.checked);
                  if (event.target.checked) autoReply.resume();
                  else autoReply.pause();
                }}
              />
              Auto-LLM-suggest-and-reply
            </label>
            {autoReplyEnabled && (
              <span>
                {autoReply.sent}/{autoReplyMaxTurns} sent ·{' '}
                {autoReply.paused
                  ? 'paused'
                  : autoReply.sent >= autoReplyMaxTurns
                    ? 'limit reached'
                    : autoReply.pending
                      ? userSpeech.active
                        ? 'preparing or speaking your reply'
                        : 'drafting'
                      : busy || phraseDisplay.revealing
                        ? 'waiting for Mira'
                        : 'waiting'}
              </span>
            )}
            {autoReplyEnabled && (autoReply.paused || autoReply.sent >= autoReplyMaxTurns) && (
              <button
                type="button"
                disabled={disabled || !!draft.trim() || !!error || completedRevision === null}
                onClick={autoReply.resume}
              >
                Resume auto replies
              </button>
            )}
          </div>
          <div className="conversation-preferences">
            <details className="conversation-settings">
              <summary>Conversation settings</summary>
              <div className="settings-fields">
                <ConversationFocusControls
                  getToKnowEachOther={getToKnowEachOther}
                  aboutMe={aboutMe}
                  disabled={disabled}
                  onFocusChange={(value) =>
                    updateConversationPreference('getToKnowEachOther', value)
                  }
                  onAboutMeChange={(value) => updateConversationPreference('aboutMe', value)}
                />
                <label className="conversation-toggle">
                  Localized swearing · 地道粗口
                  <input
                    type="checkbox"
                    aria-label="Localized swearing"
                    checked={localizedProfanity}
                    disabled={disabled}
                    onChange={(event) => {
                      autoReply.pause();
                      suggestion.cancel();
                      userSpeech.cancel(true);
                      preferences.update('localizedProfanity', event.target.checked);
                    }}
                  />
                </label>
                <p className="settings-hint">
                  Encourages Mira and suggested or automatic user replies to swear naturally in
                  their reply language, including Hong Kong Cantonese slang. Manual rewrites
                  preserve your original tone.
                </p>
                <label>
                  Automatic reply mode
                  <select
                    aria-label="Auto reply mode"
                    value={autoReplyMode}
                    disabled={disabled}
                    onChange={(event) => {
                      autoReply.pause();
                      userSpeech.cancel(true);
                      preferences.update('autoReplyMode', event.target.value as 'text' | 'spoken');
                      void userSpeech.unlock();
                    }}
                  >
                    <option value="text">Text reply</option>
                    <option value="spoken">Phrase bubbles &amp; male voice</option>
                  </select>
                </label>
                {(autoReplyMode === 'spoken' || manualMessageMode === 'spoken') &&
                  !maleVoiceConfigured && (
                    <p>
                      Male voice needs setup in the TTS service. Refresh service readiness after
                      configuring its reference audio and transcript.
                    </p>
                  )}
                <label>
                  Auto reply delay (seconds)
                  <input
                    type="number"
                    aria-label="Auto reply delay seconds"
                    min={1}
                    max={600}
                    step={0.5}
                    value={autoReplyDelaySeconds}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (value >= 1 && value <= 600)
                        preferences.update('autoReplyDelaySeconds', value);
                    }}
                  />
                </label>
                <label>
                  Auto reply turn limit
                  <input
                    type="number"
                    aria-label="Auto reply turn limit"
                    min={1}
                    max={100}
                    value={autoReplyMaxTurns}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isInteger(value) && value >= 1 && value <= 100)
                        preferences.update('autoReplyMaxTurns', value);
                    }}
                  />
                </label>
                <label>
                  Mira's messages
                  <select
                    aria-label="Mira message display"
                    value={displayMode}
                    disabled={disabled}
                    onChange={(event) =>
                      preferences.update('displayMode', event.target.value as 'full' | 'phrases')
                    }
                  >
                    <option value="full">Full reply</option>
                    <option value="phrases">Phrase bubbles · follow speech</option>
                  </select>
                </label>
                <label>
                  Text-only phrase delay (seconds)
                  <input
                    type="number"
                    aria-label="Text-only phrase delay seconds"
                    min={0.2}
                    max={10}
                    step={0.1}
                    value={textPhraseDelaySeconds}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (value >= 0.2 && value <= 10)
                        preferences.update('textPhraseDelaySeconds', value);
                    }}
                  />
                </label>
              </div>
              <p>
                Settings are remembered in this browser. Auto replies wait for Mira to finish;
                typing, Stop, errors, or leaving the tab pauses them. Proactive chat waits while
                auto replies are enabled.
              </p>
              <button
                type="button"
                onClick={() => {
                  stop();
                  preferences.reset();
                  setCompletedRevision(null);
                }}
              >
                Reset settings
              </button>
            </details>
            {persona?.renderer === 'vrm' && (
              <PoseControls
                disabled={!avatarReady}
                strength={poseStrength}
                holdSeconds={poseHoldSeconds}
                onStrength={(value) => preferences.update('poseStrength', value)}
                onHoldSeconds={(value) => preferences.update('poseHoldSeconds', value)}
                onPreview={(name) => {
                  autoReply.pause();
                  proactive.touch();
                  renderer.current?.previewPose?.(name, poseStrength, poseHoldSeconds);
                }}
                onStop={() => renderer.current?.stopPose?.()}
              />
            )}
          </div>
        </section>
      </main>
      <footer className="footer">
        <div className="persona-picker">
          <span>PERSONA</span>
          <select
            aria-label="Choose persona"
            value={personaId}
            disabled={disabled}
            onChange={(e) => setPersonaId(e.target.value)}
          >
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.renderer === 'vrm' ? '3D' : 'Live2D'}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
        <div className="service-status">
          <button onClick={() => void refreshHealth()} title="Refresh service readiness">
            <RefreshCw size={12} />
          </button>
          {(['asr', 'tts', 'lipsync'] as const).map((key) => (
            <span key={key} title={health?.[key].detail}>
              <i
                className={
                  health?.[key].status === 'ready'
                    ? 'ready'
                    : health?.[key].status === 'busy'
                      ? 'working'
                      : ''
                }
              />
              {key === 'lipsync' ? 'Lip sync' : key.toUpperCase()}
            </span>
          ))}
        </div>
        <span className="footer-note">A voice. A face. Your conversation.</span>
      </footer>
    </div>
  );
}
