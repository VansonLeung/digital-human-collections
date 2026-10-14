import { useEffect, useRef, useState } from 'react';

/** User-side automation has a finite run budget and waits for completed playback. */
export function useAutoReply(options: {
  enabled: boolean;
  delaySeconds: number;
  maxTurns: number;
  blocked: boolean;
  completedRevision: number | null;
  generateAndSend: (signal: AbortSignal) => Promise<boolean>;
}) {
  const [sent, setSent] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const handled = useRef<number | null>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;
  function pause() {
    clearTimeout(timer.current);
    request.current?.abort();
    request.current = undefined;
    setPending(false);
    setPaused(true);
  }
  function restart() {
    clearTimeout(timer.current);
    request.current?.abort();
    request.current = undefined;
    handled.current = latest.current.completedRevision;
    setSent(0);
    setPending(false);
    setPaused(false);
    setEpoch((value) => value + 1);
  }
  function resume() {
    handled.current = null;
    setSent(0);
    setPaused(false);
    setEpoch((value) => value + 1);
  }
  useEffect(() => {
    const activity = () => {
      if (latest.current.enabled) pause();
    };
    document.addEventListener('keydown', activity, true);
    document.addEventListener('pointerdown', activity, true);
    const visibility = () => {
      if (document.hidden) activity();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('keydown', activity, true);
      document.removeEventListener('pointerdown', activity, true);
      document.removeEventListener('visibilitychange', visibility);
      clearTimeout(timer.current);
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!options.enabled) {
      pause();
      setPaused(false);
    }
  }, [options.enabled]);
  useEffect(() => {
    clearTimeout(timer.current);
    if (
      !options.enabled ||
      paused ||
      options.blocked ||
      pending ||
      sent >= options.maxTurns ||
      options.completedRevision === null ||
      options.completedRevision === handled.current ||
      document.hidden
    )
      return;
    const revision = options.completedRevision;
    timer.current = setTimeout(async () => {
      if (latest.current.blocked || !latest.current.enabled || document.hidden) return;
      const controller = new AbortController();
      request.current = controller;
      setPending(true);
      try {
        const didSend = await latest.current.generateAndSend(controller.signal);
        if (request.current !== controller || controller.signal.aborted) return;
        if (didSend) {
          handled.current = revision;
          setSent((value) => value + 1);
        } else setPaused(true);
      } catch {
        if (!controller.signal.aborted) setPaused(true);
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          setPending(false);
        }
      }
    }, options.delaySeconds * 1000);
    return () => clearTimeout(timer.current);
  }, [
    options.enabled,
    options.blocked,
    options.completedRevision,
    options.delaySeconds,
    options.maxTurns,
    paused,
    pending,
    sent,
    epoch,
  ]);
  useEffect(() => {
    if (options.blocked && request.current) pause();
  }, [options.blocked]);
  return { sent, paused, pending, pause, restart, resume };
}
