export interface Credentials {
  GROQ_API_KEY?: string;
  GROQ_API_KEY_BACKUP?: string;
}
export function duration(value: string | null): number | undefined {
  if (!value) return;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const units: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (parts.length && parts.map((p) => p[0]).join('') === value)
    return parts.reduce((n, p) => n + Number(p[1]) * units[p[2]], 0);
  const time = Date.parse(value);
  if (Number.isFinite(time)) return Math.max(0, (time - Date.now()) / 1000);
}
export function providerRetry(response: Response): number {
  const retry = duration(response.headers.get('retry-after'));
  // Only exhausted header counters identify which reset is relevant. Token
  // counters describe TPM, request counters RPD; a non-exhausted RPD reset must
  // not turn a short TPM pause into an invented daily outage.
  const waits: number[] = [];
  for (const kind of ['tokens', 'requests'])
    if (response.headers.get('x-ratelimit-remaining-' + kind) === '0') {
      const reset = duration(response.headers.get('x-ratelimit-reset-' + kind));
      if (reset !== undefined) waits.push(reset);
    }
  return Math.ceil(Math.min(86400, Math.max(1, retry ?? (waits.length ? Math.max(...waits) : 60))));
}
export async function requestGroq(env: Credentials, body: string, fetcher: typeof fetch) {
  const send = (key: string) =>
    fetcher('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(25000),
    });
  let response = await send(env.GROQ_API_KEY!);
  let credential: 'primary' | 'backup' = 'primary';
  // Only an unambiguous authentication failure activates the standby key. Organization
  // quotas, model permissions, outages and uncertain requests never rotate credentials.
  if (
    response.status === 401 &&
    env.GROQ_API_KEY_BACKUP &&
    env.GROQ_API_KEY_BACKUP !== env.GROQ_API_KEY
  ) {
    await response.body?.cancel();
    response = await send(env.GROQ_API_KEY_BACKUP);
    credential = 'backup';
  }
  return { response, credential };
}
