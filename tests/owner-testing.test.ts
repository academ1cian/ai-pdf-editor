import { readFileSync } from 'node:fs';
import { inspectPDF } from '../src/engine/pdf';
import { localConversation } from '../src/ai/conversation';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { handleAPI, type AIEnv } from '../worker/api';
import { requestPlanWithRetry, waitForRetry } from '../src/ai/retry';
let privateKey: CryptoKey, publicKey: JsonWebKey, cookie: string;
const env: AIEnv = {
  ENABLE_AI: 'true',
  ENABLE_IMAGE_AI: 'true',
  IMAGE_AI_FREE_VERIFIED: 'true',
  AI_APP_LIMITS_ENABLED: 'false',
  GROQ_API_KEY: 'primary-test',
  GROQ_API_KEY_BACKUP: 'standby-test',
  TURNSTILE_SECRET: 'test-only-owner-signing-secret',
  TURNSTILE_SITE_KEY: 'site',
  ALLOWED_ORIGIN: 'https://editor.example',
};
const body = {
  instruction: 'Replace pending with reviewed',
  blocks: [{ id: 'b', page: 1, text: 'Status: pending' }],
  turnstileToken: 'token',
  sessionId: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
};
const plan = {
  edits: [
    {
      id: 'e',
      operation: 'replace',
      page: 1,
      blockId: 'b',
      original: 'pending',
      replacement: 'reviewed',
      explanation: 'Requested.',
      ambiguity: 'none',
    },
  ],
};
function req(path = '/api/plan', data: unknown = body, owner = true) {
  return new Request('https://editor.example' + path, {
    method: 'POST',
    headers: {
      Origin: env.ALLOWED_ORIGIN!,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1',
      ...(owner ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(data),
  });
}
const b64 = (data: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
async function proof() {
  const r = await handleAPI(new Request('https://editor.example/api/owner/challenge'), env);
  const { challenge } = await r.json();
  return {
    challenge,
    signature: b64(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new TextEncoder().encode('pdf-owner-login-v1:' + challenge),
      ),
    ),
  };
}
const upstream = (status = 200, headers?: HeadersInit) =>
  (async (url: RequestInfo | URL) =>
    String(url).includes('siteverify')
      ? Response.json({ success: true, hostname: 'editor.example', action: 'pdf-plan' })
      : Response.json(
          status === 200
            ? {
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }],
                usage: { total_tokens: 4400 },
              }
            : { error: { message: 'Provider response' } },
          { status, headers },
        )) as typeof fetch;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  privateKey = pair.privateKey;
  publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  env.AI_OWNER_PUBLIC_KEY = JSON.stringify(publicKey);
  const r = await handleAPI(req('/api/owner/session', await proof(), false), env);
  expect(r.status).toBe(200);
  cookie = r.headers.get('Set-Cookie')!.split(';')[0];
});
describe('authenticated owner testing without application quotas', () => {
  it('requires an owner signature, keeps secure HttpOnly sessions, rejects anonymous text/image and forged cookies', async () => {
    const fetcher = vi.fn(upstream());
    for (const path of ['/api/plan', '/api/image'])
      expect((await handleAPI(req(path, body, false), env, fetcher)).status).toBe(401);
    const forged = req();
    forged.headers.set('Cookie', '__Host-pdf-owner=forged');
    expect((await handleAPI(forged, env, fetcher)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const signed = await proof();
    signed.signature = 'A'.repeat(86);
    expect((await handleAPI(req('/api/owner/session', signed, false), env)).status).toBe(401);
    const loggedIn = await handleAPI(req('/api/owner/session', await proof(), false), env);
    expect(loggedIn.headers.get('Set-Cookie')).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(await loggedIn.text()).not.toContain('__Host');
    const cors = req('/api/owner/session', await proof(), false);
    cors.headers.set('Origin', 'https://attacker.example');
    expect((await handleAPI(cors, env)).status).toBe(403);
  });
  it('rejects expired sessions and invalid owner configuration', async () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 3600000);
    expect((await handleAPI(req(), env, upstream())).status).toBe(401);
    spy.mockRestore();
    expect(
      (
        await handleAPI(
          req(),
          {
            ...env,
            AI_OWNER_PUBLIC_KEY: JSON.stringify({ ...publicKey, d: 'must-never-be-deployed' }),
          },
          upstream(),
        )
      ).status,
    ).toBe(401);
  });
  it('makes no budget calls for sequential requests, old exhausted counters or the former rolling threshold', async () => {
    const quota = vi.fn(async () =>
      Response.json({ reason: 'global_daily', retryAfter: 86400 }, { status: 429 }),
    );
    const configured = {
      ...env,
      AI_DAILY_REQUESTS: '1',
      AI_DAILY_TOKENS: '1',
      AI_SESSION_DAY: '1',
      AI_SESSION_MINUTE: '1',
      AI_NETWORK_DAY: '1',
      AI_NETWORK_MINUTE: '1',
      AI_GLOBAL_MINUTE_TOKENS: '1',
      BUDGET: { idFromName: (s: string) => s, get: () => ({ fetch: quota }) },
    };
    const fetcher = vi.fn(upstream());
    for (let i = 0; i < 12; i++) {
      const r = await handleAPI(req(), configured, fetcher);
      expect(r.status).toBe(200);
      expect(r.headers.get('X-AI-App-Limits-Enabled')).toBe('false');
      expect(r.headers.has('X-AI-Limits')).toBe(false);
    }
    expect(quota).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(24);
  });
  it('does not reject a large valid payload based on the 7500-token estimate', async () => {
    const blocks = [
      body.blocks[0],
      ...Array.from({ length: 48 }, (_, i) => ({
        id: 'large' + i,
        page: 1,
        text: 'invented context '.repeat(12),
        rect: [0, 0, 200, 20] as [number, number, number, number],
        font: 'Helvetica',
        size: 10,
        baseline: 20,
        field: {
          type: 'text',
          label: '',
          row: 'example',
          column: '',
          role: 'unknown',
          description: 'invented',
        },
      })),
    ];
    const r = await handleAPI(req('/api/plan', { ...body, blocks }), env, upstream());
    expect(r.status).toBe(200);
    const limited = await handleAPI(
      req('/api/plan', { ...body, blocks }),
      {
        ...env,
        AI_APP_LIMITS_ENABLED: 'true',
        BUDGET: {
          idFromName: (n) => n,
          get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
        },
      },
      upstream(),
    );
    expect(limited.status).toBe(413);
  });
  it('preserves input, verification and origin validation independently of quotas', async () => {
    expect((await handleAPI(req('/api/plan', { bad: true }), env, upstream())).status).toBe(400);
    const invalid = req();
    invalid.headers.set('Origin', 'https://attacker.example');
    expect((await handleAPI(invalid, env, upstream())).status).toBe(403);
    expect(
      (await handleAPI(req(), env, (async () => Response.json({ success: false })) as typeof fetch))
        .status,
    ).toBe(403);
  });
  it('returns actual provider429 delay, never rotates on429, and never persists an artificial cooldown', async () => {
    const fetcher = vi.fn(upstream(429, { 'Retry-After': '2.25' }));
    const r = await handleAPI(req(), env, fetcher);
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'provider_rate_limit', retryAfter: 3 });
    expect(r.headers.get('Retry-After')).toBe('3');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const network = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('siteverify'))
        return Response.json({ success: true, hostname: 'editor.example', action: 'pdf-plan' });
      throw new Error('network');
    });
    expect((await handleAPI(req(), env, network as typeof fetch)).status).toBe(502);
    expect((await handleAPI(req(), env, upstream())).status).toBe(200);
  });
  it('also bypasses image reservations without disabling image consent or resource checks', async () => {
    const imageEnv = {
      ...env,
      AI: {
        run: vi.fn(async () => ({
          image:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        })),
      },
      BUDGET: {
        idFromName: () => {
          throw new Error('Historical image counters must not be read');
        },
        get: () => {
          throw new Error('No quota store');
        },
      },
    };
    const data = {
      prompt: 'Edit invented artwork',
      consent: true,
      sessionId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      turnstileToken: 'token',
    };
    for (let i = 0; i < 4; i++)
      expect((await handleAPI(req('/api/image', data), imageEnv, upstream())).status).toBe(200);
    expect(
      (await handleAPI(req('/api/image', { ...data, consent: false }), imageEnv, upstream()))
        .status,
    ).toBe(400);
  });
  it('exposes disabled mode and authenticated status but no private credentials', async () => {
    const r = await handleAPI(
      new Request('https://editor.example/api/config', { headers: { Cookie: cookie } }),
      env,
    );
    const d = await r.json();
    expect(d).toMatchObject({
      appLimitsEnabled: false,
      ownerRequired: true,
      ownerAuthenticated: true,
      limits: null,
    });
    expect(JSON.stringify(d)).not.toContain('test-only');
  });
});
describe('bounded cancellable provider retries (mock)', () => {
  it('waits exactly the provider delay, refreshes verification, retains the same logical request and makes at most three attempts', async () => {
    const sent: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(init!.body as string));
      return sent.length < 3
        ? Response.json(
            { error: 'Groq429', code: 'provider_rate_limit', retryAfter: 7 },
            { status: 429 },
          )
        : Response.json(plan);
    });
    const fresh = vi.fn(async () => 'fresh-' + sent.length),
      wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {}),
      notice = vi.fn();
    const result = await requestPlanWithRetry({
      payload: {
        instruction: 'Please revise the status',
        pending: [{ original: '1000', replacement: '950' }],
      },
      token: 'initial',
      signal: new AbortController().signal,
      freshVerification: fresh,
      onRetry: notice,
      wait,
      fetcher: fetcher as typeof fetch,
    });
    expect(result.response.status).toBe(200);
    expect(wait.mock.calls.map((c) => c[0])).toEqual([7000, 7000]);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(sent.map((s) => s.turnstileToken)).toEqual(['initial', 'fresh-1', 'fresh-2']);
    expect(new Set(sent.map((s) => s.requestId)).size).toBe(3);
    expect(sent.every((s) => JSON.stringify(s.pending) === JSON.stringify(sent[0].pending))).toBe(
      true,
    );
  });
  it('does not retry application errors, authentication, invalid output or uncertain network failures', async () => {
    for (const [status, code] of [
      [429, 'global_minute'],
      [401, 'owner_required'],
      [502, 'invalid_model_output'],
    ] as const) {
      const fetcher = vi.fn(async () => Response.json({ code }, { status }));
      await requestPlanWithRetry({
        payload: {},
        token: 't',
        signal: new AbortController().signal,
        freshVerification: async () => 'new',
        onRetry: () => {},
        fetcher: fetcher as typeof fetch,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('cancellation interrupts the wait without another request', async () => {
    const controller = new AbortController(),
      fetcher = vi.fn(async () =>
        Response.json({ code: 'provider_rate_limit', retryAfter: 60 }, { status: 429 }),
      );
    const result = requestPlanWithRetry({
      payload: {},
      token: 't',
      signal: controller.signal,
      freshVerification: async () => 'new',
      onRetry: () => controller.abort(),
      fetcher: fetcher as typeof fetch,
    });
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const c = new AbortController();
    const sleep = waitForRetry(10000, c.signal);
    c.abort();
    await expect(sleep).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('stops after the bounded retry count while retaining provider failure details', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { code: 'provider_rate_limit', retryAfter: 0, error: 'Actual provider capacity' },
        { status: 429 },
      ),
    );
    const r = await requestPlanWithRetry({
      payload: {},
      token: 't',
      signal: new AbortController().signal,
      freshVerification: async () => 'new',
      onRetry: () => {},
      wait: async () => {},
      fetcher: fetcher as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(r.body.error).toBe('Actual provider capacity');
  });
});

it('keeps a supported multi-page invoice calculation local when its payable total is on another page', () => {
  const model = inspectPDF(new Uint8Array(readFileSync('tests/fixtures/recovery-logistics.pdf')));
  const result = localConversation(
    model,
    [],
    'Change the rate and charges to 1000 and update the total accordingly.',
  );
  expect(result?.operations.map((op) => op.replacement)).toEqual([
    '1000.0000',
    '1000.00',
    '1090.00',
  ]);
  expect(result?.operations.map((op) => op.target.page)).toEqual([0, 0, 2]);
});
