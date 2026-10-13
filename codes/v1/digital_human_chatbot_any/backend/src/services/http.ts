export class UpstreamError extends Error {
  constructor(
    public stage: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });

export function stageSignal(parent: AbortSignal, seconds: number) {
  return AbortSignal.any([parent, AbortSignal.timeout(seconds * 1000)]);
}

export async function request(url: string, init: RequestInit, stage: string): Promise<Response> {
  const signal = init.signal as AbortSignal;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.ok) return response;
    if (response.status === 429 && attempt < 3) {
      const wait = Math.min(5, Math.max(1, Number(response.headers.get('Retry-After')) || 1));
      await response.body?.cancel();
      await sleep(wait * 1000, signal);
      continue;
    }
    // Provider errors can contain sensitive details; expose a bounded generic message.
    await response.body?.cancel();
    const description: Record<number, string> = {
      401: 'Authentication rejected. Check backend credentials.',
      403: 'Access rejected by the service.',
      408: 'Audio decoding timed out.',
      413: 'Recording exceeds the size or duration limit.',
      422: 'Service rejected the input, language or voice.',
      429: 'Service is busy. Please retry shortly.',
    };
    throw new UpstreamError(
      stage,
      response.status,
      `${stage}: ${description[response.status] || `Service returned HTTP ${response.status}.`}`,
    );
  }
}

export async function readLimited(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty service response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Service response exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
