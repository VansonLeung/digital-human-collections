import type { Language, LlmRequestBody } from '@digital-human/shared';
import type { Config } from '../config.js';
import { request, stageSignal, readLimited } from './http.js';
import {
  buildReplyMessages,
  type ChatMessage,
  type CompletionMessage,
} from '../llm/requestMessages.js';

export type { ChatMessage } from '../llm/requestMessages.js';

export class EmptyCompletionError extends Error {
  constructor() {
    super(
      'LLM returned an empty reply. The provider finished without generating visible text. Please try again.',
    );
    this.name = 'EmptyCompletionError';
  }
}

export function completionUrl(base: string) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`;
  return url.toString();
}

export async function* parseCompletionStream(
  body: ReadableStream<Uint8Array>,
  onFinishReason?: (reason: string) => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  function parseEvent() {
    const payload = data.join('\n');
    data = [];
    if (!payload || payload === '[DONE]') return { done: payload === '[DONE]', text: '' };
    const chunk = JSON.parse(payload);
    if (chunk.error) throw new Error('Provider stream failed');
    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (typeof finishReason === 'string') onFinishReason?.(finishReason);
    const content = chunk.choices?.[0]?.delta?.content;
    return { done: false, text: typeof content === 'string' ? content : '' };
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('Oversized LLM event');
      if (done && buffer && !buffer.endsWith('\n')) buffer += '\n';
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') {
          const event = parseEvent();
          if (event.text) yield event.text;
          if (event.done) return;
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (done) {
        const event = parseEvent();
        if (event.text) yield event.text;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function complete(
  config: Config,
  messages: CompletionMessage[],
  onDelta: (text: string) => void,
  parent: AbortSignal,
  callbacks: {
    onFinishReason?: (reason: string) => void;
    onRequestBody?: (body: LlmRequestBody) => void;
  } = {},
) {
  if (!config.LLM_MODEL_NAME) throw new Error('LLM_MODEL_NAME is not configured');
  const body = JSON.stringify({
    model: config.LLM_MODEL_NAME,
    messages,
    stream: config.LLM_STREAM === 'true',
    max_tokens: config.LLM_MAX_TOKENS,
    ...(config.LLM_THINKING === 'false'
      ? { chat_template_kwargs: { enable_thinking: false } }
      : {}),
  });
  // Capture a detached snapshot of the exact serialized body before any HTTP
  // failure. Request headers, credentials and endpoint configuration are excluded.
  callbacks.onRequestBody?.(JSON.parse(body));
  const response = await request(
    completionUrl(config.LLM_BASE_URL),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.LLM_API_KEY ? { Authorization: `Bearer ${config.LLM_API_KEY}` } : {}),
      },
      body,
      signal: stageSignal(parent, config.LLM_TIMEOUT_SECONDS),
    },
    'LLM',
  );
  let result = '';
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    if (!response.body) throw new Error('Empty LLM stream');
    for await (const delta of parseCompletionStream(response.body, callbacks.onFinishReason)) {
      result += delta;
      onDelta(delta);
      if (result.length > 16000) throw new Error('Answer exceeds limit');
    }
  } else {
    const data = JSON.parse((await readLimited(response, 1024 * 1024)).toString());
    const content = data.choices?.[0]?.message?.content;
    const finishReason = data.choices?.[0]?.finish_reason;
    if (typeof finishReason === 'string') callbacks.onFinishReason?.(finishReason);
    if (typeof content !== 'string') throw new Error('Unsupported completion response');
    result = content;
    onDelta(content);
    if (result.length > 16000) throw new Error('Answer exceeds limit');
  }
  if (!result.trim()) throw new EmptyCompletionError();
  return result.trim();
}

export async function answer(
  config: Config,
  history: ChatMessage[],
  language: Language,
  onDelta: (text: string) => void,
  parent: AbortSignal,
  options?: {
    proactive?: boolean;
    conversationalPhrases?: boolean;
    onFinishReason?: (reason: string) => void;
    onRequestBody?: (body: LlmRequestBody) => void;
  },
) {
  return complete(config, buildReplyMessages(history, language, options), onDelta, parent, options);
}
