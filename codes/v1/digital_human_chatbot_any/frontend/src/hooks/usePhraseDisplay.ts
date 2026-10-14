import { useEffect, useRef, useState } from 'react';

type Phrase = { turnId: string; phraseIndex: number; text: string };

/** Text-only timing is separate; spoken phrases reveal on the audio callback. */
export function usePhraseDisplay(onReveal: (phrase: Phrase) => void) {
  const [revealing, setRevealing] = useState(false);
  const active = useRef<
    | {
        id: string;
        speech: boolean;
        delayMs: number;
        finished: boolean;
        last: number;
        queue: Phrase[];
        seen: Set<number>;
      }
    | undefined
  >(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  function stop() {
    clearTimeout(timer.current);
    timer.current = undefined;
    active.current = undefined;
    setRevealing(false);
  }
  function drain() {
    const turn = active.current;
    if (!turn || turn.speech || timer.current) return;
    if (!turn.queue.length) {
      if (turn.finished) setRevealing(false);
      return;
    }
    setRevealing(true);
    timer.current = setTimeout(
      () => {
        timer.current = undefined;
        if (active.current !== turn) return;
        const phrase = turn.queue.shift()!;
        turn.last = performance.now();
        reveal.current(phrase);
        drain();
      },
      Math.max(0, turn.delayMs - (performance.now() - turn.last)),
    );
  }
  function begin(id: string, speech: boolean, delaySeconds: number) {
    stop();
    active.current = {
      id,
      speech,
      delayMs: delaySeconds * 1000,
      finished: false,
      last: -Infinity,
      queue: [],
      seen: new Set(),
    };
    if (!speech) setRevealing(true);
  }
  function phrase(item: Phrase) {
    const turn = active.current;
    if (!turn || turn.id !== item.turnId || turn.seen.has(item.phraseIndex)) return;
    turn.seen.add(item.phraseIndex);
    if (turn.speech) reveal.current(item);
    else {
      turn.queue.push(item);
      drain();
    }
  }
  function finish(id: string) {
    const turn = active.current;
    if (turn?.id === id) {
      turn.finished = true;
      drain();
    }
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return { revealing, begin, phrase, finish, stop };
}
