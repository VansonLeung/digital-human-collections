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
} from '@digital-human/shared';
import type { AvatarRenderer } from './avatars/types';
import { SpeechQueuePlayer } from './audio/SpeechQueuePlayer';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  interrupted?: boolean;
  personaName?: string;
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
  const [personaId, setPersonaId] = useState('constraint-twist');
  const [language, setLanguage] = useState<ReplyLanguage>('auto');

  const [health, setHealth] = useState<Health>();
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState('Ready when you are');

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [speech, setSpeech] = useState(true);

  const [avatarReady, setAvatarReady] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [caption, setCaption] = useState('');

  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [review, setReview] = useState(false);
  const [lastSpeech, setLastSpeech] = useState<Speech[]>();
  const [retry, setRetry] = useState(false);
  const [credits, setCredits] = useState(false);

  const canvas = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const renderer = useRef<AvatarRenderer | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const session = useRef('');
  const currentTurn = useRef<string | null>(null);
  const acceptTurn = useRef(false);
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
  }, [messages, state]);

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
    if (event.type === 'session.ready') {
      setConnected(true);
      setState('Ready');
      return;
    }
    if (event.type === 'session.reset') {
      currentTurn.current = null;
      setBusy(false);
      setMessages([]);
      setCaption('');
      setLastSpeech(undefined);
      setState('Ready');
      return;
    }
    if (event.type === 'turn.started') {
      if (!acceptTurn.current) return;
      currentTurn.current = event.turnId;
      acceptTurn.current = false;
      setBusy(true);
      setMessages((m) => [
        ...m,
        {
          id: event.turnId!,
          role: 'assistant',
          text: '',
          personaName: selectedPersona.current?.name,
        },
      ]);
      return;
    }
    if (event.type === 'error' && !event.turnId) {
      setError(event.message);
      if (!currentTurn.current) {
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
        setMessages((m) =>
          m.map((v) => (v.id === event.turnId ? { ...v, text: v.text + event.text } : v)),
        );
        break;
      case 'answer.final':
        setMessages((m) => m.map((v) => (v.id === event.turnId ? { ...v, text: event.text } : v)));
        if (queueTurn.current !== event.turnId) setCaption(event.text);
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
        player.current!.stop();
        setLastSpeech(undefined);
        setError(event.message);
        setRetry(event.retryable);
        break;
      case 'turn.interrupted':
        player.current!.stop();
        setMessages((m) => m.map((v) => (v.id === event.turnId ? { ...v, interrupted: true } : v)));
        currentTurn.current = null;
        setBusy(false);
        setState('Ready');
        break;
      case 'turn.completed':
        currentTurn.current = null;
        setBusy(false);
        setState('Ready');
        void refreshHealth();
        break;
    }
  }

  async function start() {
    setError('');
    setState('Connecting');
    try {
      await player.current!.unlock();
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
        if (parsed.success) receive(parsed.data);
      };
      ws.onclose = () => {
        if (socket.current !== ws) return;
        player.current!.stop();
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

  function send(text = draft) {
    if (!connected || busy || recording || transcribing || !text.trim()) return;
    setError('');
    setRetry(false);
    setReview(false);
    setDraft('');
    setBusy(true);
    setState('Thinking');
    setCaption('');
    setLastSpeech(undefined);
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: 'user', text: text.trim() }]);
    acceptTurn.current = true;
    void player.current!.unlock();
    command({
      type: 'turn.send',
      text: text.trim(),
      personaId,
      language,
      speech: speech && avatarReady,
    });
  }

  function stop() {
    player.current!.stop();
    queueTurn.current = null;
    speechPhrases.current = [];
    setLastSpeech(undefined);
    setPaused(false);
    acceptTurn.current = false;
    const id = currentTurn.current;
    command({ type: 'turn.stop', ...(id ? { turnId: id } : {}) });
    if (id) setMessages((m) => m.map((v) => (v.id === id ? { ...v, interrupted: true } : v)));
    currentTurn.current = null;
    setBusy(false);
    setState('Ready');
    transcription.current?.abort();
    setTranscribing(false);
  }

  function reset() {
    stop();
    command({ type: 'session.reset' });
    setMessages([]);
    setCaption('');
    setDraft('');
    setError('');
    setReview(false);
    setLastSpeech(undefined);
  }

  async function record() {
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

  const disabled = busy || recording || transcribing;
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
                onClick={() => {
                  player.current!.setMuted(!muted);
                  setMuted(!muted);
                }}
              >
                {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
              <span />
              <button
                aria-label={paused ? 'Resume speech' : 'Pause speech'}
                disabled={state !== 'Speaking'}
                onClick={() =>
                  void player.current!.togglePause().then(() => setPaused(player.current!.paused))
                }
              >
                {paused ? <Play size={18} /> : <Pause size={18} />}
              </button>
              <button aria-label="Stop response" disabled={!busy} onClick={stop}>
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
                {connected ? state : 'Your personal AI companion'}
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
                    <span className="thinking">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {message.interrupted && <span className="interrupted">Interrupted</span>}
                </div>
              </div>
            ))}
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
          {review && (
            <div className="review">
              <Check size={14} />
              Transcript ready. Edit it below before sending.
            </div>
          )}
          {(lastSpeech || retry) && !busy && (
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
              send();
            }}
          >
            <textarea
              aria-label="Message"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                recording
                  ? `Listening… ${seconds}s`
                  : transcribing
                    ? 'Transcribing your question…'
                    : 'Type a message…'
              }
              maxLength={4000}
              rows={1}
              disabled={!connected || disabled}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
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
              aria-label="Send message"
              disabled={!connected || disabled || !draft.trim()}
            >
              <ArrowUp size={21} />
            </button>
          </form>
          <div className="chat-options">
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
