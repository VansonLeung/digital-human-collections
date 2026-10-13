import type { Language } from '@digital-human/shared';
import type { Config } from '../config.js';
import { request, stageSignal, readLimited } from './http.js';
import { systemPrompt } from '../llm/prompts.js';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export function completionUrl(base: string) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`;
  return url.toString();
}

export async function* parseCompletionStream(
  body: ReadableStream<Uint8Array>,
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

export async function answer(
  config: Config,
  history: ChatMessage[],
  language: Language,
  onDelta: (text: string) => void,
  parent: AbortSignal,
) {
  if (!config.LLM_MODEL_NAME) throw new Error('LLM_MODEL_NAME is not configured');
  const response = await request(
    completionUrl(config.LLM_BASE_URL),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.LLM_API_KEY ? { Authorization: `Bearer ${config.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: config.LLM_MODEL_NAME,
        messages: [
          {
            role: 'system',
            content: systemPrompt(language),
          },
          ...history.slice(-12),
        ],
        stream: config.LLM_STREAM === 'true',
        max_tokens: config.LLM_MAX_TOKENS,
        ...(config.LLM_THINKING === 'false'
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {}),
      }),
      signal: stageSignal(parent, config.LLM_TIMEOUT_SECONDS),
    },
    'LLM',
  );
  let result = '';
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    if (!response.body) throw new Error('Empty LLM stream');
    for await (const delta of parseCompletionStream(response.body)) {
      result += delta;
      if (result.length > 16000) throw new Error('Answer exceeds limit');
      onDelta(delta);
    }
  } else {
    const data = JSON.parse((await readLimited(response, 1024 * 1024)).toString());
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Unsupported completion response');
    result = content;
    onDelta(content);
  }
  if (!result.trim()) throw new Error('LLM returned no visible answer');
  return result.trim();
}
