import { useEffect, useRef, useState } from 'react';
import type { ReplyLanguage, ReplyDiagnostic } from '@digital-human/shared';

export function useReplySuggestion(options: {
  draft: string;
  language: ReplyLanguage;
  revision: number;
  blocked: boolean;
  onDraft: (text: string) => void;
  onError: (message: string, diagnostic?: ReplyDiagnostic) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [preview, setPreview] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;
  function cancel() {
    request.current?.abort();
    request.current = undefined;
    setLoading(false);
    setAutoLoading(false);
    setPreview('');
  }
  useEffect(() => {
    cancel();
  }, [options.draft, options.language, options.revision, options.blocked]);
  useEffect(() => () => request.current?.abort(), []);

  async function generate(sessionId: string, mode?: { signal: AbortSignal; automatic: true }) {
    if (latest.current.blocked || request.current) return;
    const controller = new AbortController();
    const snapshot = latest.current;
    if (mode?.signal.aborted) return;
    const abort = () => controller.abort();
    mode?.signal.addEventListener('abort', abort, { once: true });
    request.current = controller;
    setLoading(true);
    setAutoLoading(!!mode);
    setPreview('');
    try {
      const response = await fetch(`/api/sessions/${sessionId}/suggest-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: snapshot.language, revision: snapshot.revision }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (controller.signal.aborted || request.current !== controller) return;
      if (!response.ok) {
        latest.current.onError(result.error || 'Reply suggestion failed.', result.diagnostic);
        return;
      }
      if (
        typeof result.draft !== 'string' ||
        result.revision !== latest.current.revision ||
        snapshot.draft !== latest.current.draft
      )
        return;
      if (mode) return result.draft as string;
      if (snapshot.draft.trim()) setPreview(result.draft);
      else latest.current.onDraft(result.draft);
    } catch (error) {
      if (!controller.signal.aborted)
        latest.current.onError(error instanceof Error ? error.message : 'Reply suggestion failed.');
    } finally {
      mode?.signal.removeEventListener('abort', abort);
      if (request.current === controller) {
        request.current = undefined;
        setLoading(false);
        setAutoLoading(false);
      }
    }
  }
  function accept() {
    if (preview) latest.current.onDraft(preview);
    setPreview('');
  }
  return { loading, autoLoading, preview, generate, cancel, accept };
}
