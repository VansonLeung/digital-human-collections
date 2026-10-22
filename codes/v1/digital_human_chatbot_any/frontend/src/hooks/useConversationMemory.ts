import { useState } from 'react';
import type { ConversationMemory, ServerEvent, Command } from '@digital-human/shared';

export function useConversationMemory(options: {
  revision: number;
  send: (command: Command) => void;
  onInteraction: () => void;
}) {
  const [memories, setMemories] = useState<ConversationMemory[]>([]);
  function receive(event: ServerEvent) {
    if (event.type === 'memory.state') {
      setMemories(event.memories);
      return true;
    }
    if (event.type === 'session.reset' || event.type === 'session.ready') setMemories([]);
    return false;
  }
  function edit(id: string, value: string) {
    if (!value.trim()) return;
    options.onInteraction();
    options.send({ type: 'memory.edit', id, value: value.trim(), revision: options.revision });
  }
  function forget(id: string) {
    options.onInteraction();
    options.send({ type: 'memory.forget', id, revision: options.revision });
  }
  return { memories, receive, edit, forget };
}
