import { useEffect, useRef, useState } from 'react';

/** One follow-up per user message; timers never call the LLM while the UI is busy. */
export function useProactiveChat(options: {
  enabled: boolean;
  delaySeconds: number;
  blocked: boolean;
  onFollowUp: () => void;
  onActivity: () => void;
}) {
  const [epoch, setEpoch] = useState(0);
  const eligible = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;

  const touch = () => {
    clearTimeout(timer.current);
    setEpoch((value) => value + 1);
  };
  const suppress = () => {
    eligible.current = false;
    touch();
  };
  const arm = () => {
    eligible.current = true;
    touch();
  };

  useEffect(() => {
    const activity = () => {
      touch();
      latest.current.onActivity();
    };
    document.addEventListener('pointerdown', activity);
    document.addEventListener('keydown', activity);
    document.addEventListener('visibilitychange', activity);
    return () => {
      document.removeEventListener('pointerdown', activity);
      document.removeEventListener('keydown', activity);
      document.removeEventListener('visibilitychange', activity);
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!options.enabled || options.blocked || document.hidden || !eligible.current) return;
    timer.current = setTimeout(() => {
      if (!eligible.current || latest.current.blocked || !latest.current.enabled || document.hidden)
        return;
      eligible.current = false;
      latest.current.onFollowUp();
    }, options.delaySeconds * 1000);
    return () => clearTimeout(timer.current);
  }, [options.enabled, options.delaySeconds, options.blocked, epoch]);

  return { arm, suppress, touch };
}
