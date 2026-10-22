import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  conversationSummarySchema,
  type ConversationSummary,
  type ServerEvent,
  type SavedConversation,
} from '@digital-human/shared';

export function conversationIdFromUrl() {
  const match = location.pathname.match(/^\/conversations\/([0-9a-f-]+)\/?$/i);
  return match && z.uuid().safeParse(match[1]).success ? match[1] : undefined;
}

export function useConversationHistory(options: {
  open: (id?: string) => Promise<boolean>;
  sessionId: string;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<ConversationSummary>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const resetting = useRef(false);

  async function refresh() {
    try {
      const response = await fetch('/api/conversations');
      if (!response.ok) throw new Error('Cannot load saved conversations.');
      setItems(z.array(conversationSummarySchema).parse(await response.json()));
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function open(id?: string, navigate = true) {
    setLoading(true);
    setError('');
    try {
      if (!(await latest.current.open(id))) return;
      if (navigate) history.pushState({}, '', id ? `/conversations/${id}` : '/');
      void refresh();
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    if (conversationIdFromUrl()) void open(conversationIdFromUrl(), false);
    const pop = () => {
      void open(conversationIdFromUrl(), false);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  function loaded(value?: SavedConversation) {
    resetting.current = false;
    setCurrent(
      value
        ? conversationSummarySchema.parse({ ...value, messageCount: value.messages.length })
        : undefined,
    );
  }
  function clear() {
    resetting.current = true;
    setCurrent(undefined);
    setError('');
    if (location.pathname !== '/') history.pushState({}, '', '/');
  }
  function receive(event: ServerEvent) {
    if (event.type === 'conversation.saved') {
      if (resetting.current) return true;
      const value = event.conversation;
      setCurrent(value);
      setError('');
      setItems((items) => [value, ...items.filter((item) => item.id !== value.id)]);
      history.replaceState({}, '', `/conversations/${value.id}`);
      return true;
    }
    if (event.type === 'conversation.save_failed') {
      setError(event.message);
      return true;
    }
    if (event.type === 'session.reset') {
      clear();
      resetting.current = false;
      void refresh();
    }
    return false;
  }
  async function save() {
    if (!latest.current.sessionId) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/sessions/${latest.current.sessionId}/save`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Conversation could not be saved.');
      setError('');
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return { items, current, error, loading, saving, open, loaded, clear, refresh, receive, save };
}
