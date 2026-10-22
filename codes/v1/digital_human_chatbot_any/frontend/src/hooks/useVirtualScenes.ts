import { useEffect, useRef, useState } from 'react';
import type { Command, SceneSnapshot, ServerEvent } from '@digital-human/shared';

type StepEvent = Extract<ServerEvent, { type: 'scene.step' }>;

export function useVirtualScenes(options: {
  enabled: boolean;
  autoEnter: boolean;
  replyCompleted: boolean;
  autoBlocked: boolean;
  connected: boolean;
  blocked: boolean;
  revision: number;
  send: (command: Command) => void;
  onInteraction: () => void;
  onStep: (event: StepEvent) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [scene, setScene] = useState<SceneSnapshot>();
  const [pending, setPending] = useState(false);
  const decision = useRef(false);
  const automaticAttempt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (options.connected)
      latest.current.send({ type: 'scene.configure', enabled: options.enabled });
    else {
      setScene(undefined);
      setPending(false);
      decision.current = false;
      automaticAttempt.current = undefined;
    }
  }, [options.enabled, options.connected]);

  function receive(event: ServerEvent) {
    if (event.type === 'scene.state') {
      setScene(event.scene);
      setPending(false);
      decision.current = false;
      return true;
    }
    if (event.type === 'scene.step') {
      latest.current.onStep(event);
      return true;
    }
    if (event.type === 'error' && event.stage === 'scene') {
      setPending(false);
      decision.current = false;
    }
    if (event.type === 'session.reset') {
      setScene(undefined);
      setPending(false);
      decision.current = false;
      automaticAttempt.current = undefined;
    }
    return false;
  }
  function decide(accept: boolean, automatic = false) {
    const current = latest.current;
    if (
      !scene?.proposal ||
      !current.enabled ||
      !current.connected ||
      current.blocked ||
      decision.current
    )
      return;
    if (!automatic) current.onInteraction();
    decision.current = true;
    setPending(true);
    current.send({
      type: 'scene.decide',
      proposalId: scene.proposal.id,
      version: scene.version,
      revision: current.revision,
      accept,
    });
  }
  useEffect(() => {
    if (!options.autoEnter) automaticAttempt.current = undefined;
    if (
      !options.enabled ||
      !options.autoEnter ||
      !options.replyCompleted ||
      options.blocked ||
      options.autoBlocked ||
      !options.connected ||
      !scene?.proposal ||
      scene.agreement?.proposalId !== scene.proposal.id ||
      scene.agreement.timing !== 'now' ||
      pending ||
      !scene.enabled ||
      document.hidden
    )
      return;
    const key = `${scene.proposal.id}:${scene.version}`;
    if (automaticAttempt.current === key) return;
    automaticAttempt.current = key;
    decide(true, true);
  }, [
    options.enabled,
    options.autoEnter,
    options.replyCompleted,
    options.blocked,
    options.autoBlocked,
    options.connected,
    options.revision,
    scene,
    pending,
  ]);
  return { scene, pending, receive, decide: (accept: boolean) => decide(accept) };
}
