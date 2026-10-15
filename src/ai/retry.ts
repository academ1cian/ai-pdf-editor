export type RetryNotice = { delay: number; attempt: number; maxAttempts: number; retryAt: number };
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const end = Date.now() + ms;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Request cancelled.', 'AbortError'));
    };
    const tick = () => {
      const left = end - Date.now();
      if (left <= 0) {
        cleanup();
        resolve();
      } else timer = setTimeout(tick, Math.min(left, 60000));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else tick();
  });
}
export async function requestPlanWithRetry(options: {
  payload: Record<string, unknown>;
  token: string;
  signal: AbortSignal;
  freshVerification: () => Promise<string>;
  onRetry: (notice: RetryNotice) => void;
  fetcher?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const fetcher = options.fetcher || fetch,
    wait = options.wait || waitForRetry;
  let token = options.token;
  for (let attempt = 1; attempt <= 3; attempt++) {
    options.signal.throwIfAborted();
    const response = await fetcher('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        ...options.payload,
        turnstileToken: token,
        requestId: crypto.randomUUID(),
      }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(35000)]),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (response.status !== 429 || body.code !== 'provider_rate_limit' || attempt === 3)
      return { response, body };
    const header = Number(response.headers.get('Retry-After')),
      given = body.retryAfter;
    const delay =
      typeof given === 'number' && Number.isFinite(given) && given >= 0
        ? given
        : response.headers.has('Retry-After') && Number.isFinite(header) && header >= 0
          ? header
          : 60;
    options.onRetry({
      delay,
      attempt: attempt + 1,
      maxAttempts: 3,
      retryAt: Date.now() + delay * 1000,
    });
    await wait(delay * 1000, options.signal);
    options.signal.throwIfAborted();
    token = await options.freshVerification();
  }
  throw new Error('Provider retry attempts exhausted.');
}
