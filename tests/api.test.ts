import { describe, it, expect } from 'vitest';
import { handleAPI, type AIEnv } from '../worker/api';
import { reserve, reconcile, type Usage } from '../worker/budget';
import { AIPlanSchema, AIRequestSchema } from '../src/ai/schema';
const body = {
  instruction: 'Replace pending with ready',
  blocks: [{ id: 'p0l0', page: 1, text: 'Status: pending' }],
  turnstileToken: 'token',
};
const validPlan = {
  edits: [
    {
      id: 'e1',
      operation: 'replace',
      page: 1,
      blockId: 'p0l0',
      original: 'pending',
      replacement: 'ready',
      explanation: 'Requested status correction.',
      ambiguity: 'none',
    },
  ],
};
const env: AIEnv = {
  ENABLE_AI: 'true',
  GROQ_API_KEY: 'test-key',
  TURNSTILE_SECRET: 'test-secret',
  TURNSTILE_SITE_KEY: 'public-key',
  ALLOWED_ORIGIN: 'https://editor.example',
  BUDGET: {
    idFromName: (n) => n,
    get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
  },
};
const request = (data: unknown = body, origin = 'https://editor.example') =>
  new Request('https://proxy.example/api/plan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.1',
    },
    body: JSON.stringify(data),
  });
const fetcher = (
  plan: unknown = validPlan,
  verification: unknown = { success: true, hostname: 'editor.example', action: 'pdf-plan' },
  status = 200,
) =>
  (async (url: RequestInfo | URL) =>
    String(url).includes('siteverify')
      ? Response.json(verification)
      : Response.json(
          { choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] },
          { status },
        )) as typeof fetch;
describe('untrusted AI and request schemas', () => {
  it('validates structured edit plans', () => {
    expect(AIPlanSchema.safeParse(validPlan).success).toBe(true);
    expect(AIPlanSchema.safeParse({ edits: [{ ...validPlan.edits[0], page: 0 }] }).success).toBe(
      false,
    );
    expect(AIPlanSchema.safeParse({ edits: [], unexpected: true }).success).toBe(false);
  });
  it('rejects extra request fields and too much context', () => {
    expect(AIRequestSchema.safeParse({ ...body, apiKey: 'injection' }).success).toBe(false);
    expect(
      AIRequestSchema.safeParse({
        ...body,
        blocks: Array.from({ length: 10 }, (_, i) => ({
          id: `b${i}`,
          page: 1,
          text: 'a'.repeat(1500),
        })),
      }).success,
    ).toBe(false);
  });
});
describe('free proxy and abuse protection', () => {
  it('is disabled without all secrets and bindings', async () => {
    expect((await handleAPI(request(), {})).status).toBe(403);
    const r = await handleAPI(new Request('https://proxy.example/api/config'), {});
    expect((await r.json()).enabled).toBe(false);
  });
  it('fails closed when AI is switched off', async () => {
    expect((await handleAPI(request(), { ...env, ENABLE_AI: 'false' }, fetcher())).status).toBe(
      503,
    );
  });
  it('restricts origins and handles preflight', async () => {
    expect(
      (await handleAPI(request(body, 'https://attacker.example'), env, fetcher())).status,
    ).toBe(403);
    const r = await handleAPI(
      new Request('https://proxy.example/api/plan', {
        method: 'OPTIONS',
        headers: { Origin: env.ALLOWED_ORIGIN! },
      }),
      env,
    );
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN);
  });
  it('rejects invalid requests before calling provider', async () => {
    expect((await handleAPI(request({ bad: 1 }), env, fetcher())).status).toBe(400);
    expect(
      (await handleAPI(request({ ...body, instruction: 'x'.repeat(60001) }), env, fetcher()))
        .status,
    ).toBe(400);
  });
  it('requires successful, correct-host, correct-action CAPTCHA', async () => {
    for (const verification of [
      { success: false },
      { success: true, hostname: 'attacker.example', action: 'pdf-plan' },
      { success: true, hostname: 'editor.example', action: 'wrong' },
    ])
      expect((await handleAPI(request(), env, fetcher(validPlan, verification))).status).toBe(403);
  });
  it('enforces budget before upstream', async () => {
    const limited = {
      ...env,
      BUDGET: {
        idFromName: (n: string) => n,
        get: () => ({ fetch: async () => new Response(null, { status: 429 }) }),
      },
    };
    expect((await handleAPI(request(), limited, fetcher())).status).toBe(429);
  });
  it('normalizes provider rate limits, invalid output, and network failures', async () => {
    expect((await handleAPI(request(), env, fetcher(validPlan, undefined, 429))).status).toBe(429);
    expect((await handleAPI(request(), env, fetcher({ invalid: true }))).status).toBe(502);
    expect(
      (
        await handleAPI(
          request(),
          env,
          fetcher({ edits: [{ ...validPlan.edits[0], blockId: 'invented' }] }),
        )
      ).status,
    ).toBe(502);
    expect(
      (
        await handleAPI(request(), env, (async () => {
          throw new Error('network');
        }) as typeof fetch)
      ).status,
    ).toBe(502);
  });
  it('returns only validated, resolved proposals', async () => {
    const r = await handleAPI(request(), env, fetcher());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(validPlan);
  });
  it('reserves global tokens and enforces burst limits', () => {
    const time = Date.UTC(2026, 9, 14);
    let u = reserve(undefined, 'a', 100, time).usage;
    u = reserve(u, 'a', 100, time).usage;
    u = reserve(u, 'a', 100, time).usage;
    u = reserve(u, 'a', 100, time).usage;
    expect(reserve(u, 'a', 100, time).reason).toBe('session_minute');
    expect(reserve(u, 'b', 100000, time).allowed).toBe(false);
    expect(reserve(u, 'a', 100, time + 60000).allowed).toBe(true);
    expect(reserve(u, 'a', 100, time + 86400000).usage.requests).toBe(1);
    expect(reserve(undefined, 'a', -1, time).allowed).toBe(false);
  });
});

it('reconciles real provider usage, refunds 429, and distinguishes application throttles', async () => {
  let usage: Usage | undefined;
  let count = 0;
  const configured: AIEnv = {
    ...env,
    BUDGET: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (req) => {
          const b = (await req.json()) as {
            client: string;
            network: string;
            id: string;
            tokens: number;
            actual?: number;
            rejected?: boolean;
          };
          if (new URL(req.url).pathname === '/reconcile') {
            usage = reconcile(usage!, b.id, b.actual, b.rejected);
            return new Response(null, { status: 204 });
          }
          const r = reserve(
            usage,
            b.client,
            b.tokens,
            Date.UTC(2026, 9, 14) + count++ * 20000,
            undefined,
            b.network,
            b.id,
          );
          usage = r.usage;
          return Response.json(
            { reason: r.reason, retryAfter: r.retryAfter, remaining: r.remaining },
            { status: r.allowed ? 200 : 429 },
          );
        },
      }),
    },
  };
  const actual = (async (url: RequestInfo | URL) =>
    String(url).includes('siteverify')
      ? Response.json({ success: true, hostname: 'editor.example', action: 'pdf-plan' })
      : Response.json({
          usage: { total_tokens: 150 },
          choices: [{ message: { content: JSON.stringify(validPlan) }, finish_reason: 'stop' }],
        })) as typeof fetch;
  for (let i = 0; i < 8; i++)
    expect((await handleAPI(request(), configured, actual)).status).toBe(200);
  expect(usage!.tokens).toBe(1200);
  const refused = await handleAPI(request(), configured, fetcher(validPlan, undefined, 429));
  expect((await refused.json()).code).toBe('provider_rate_limit');
  expect(usage!.tokens).toBe(1200);
  expect(usage!.requests).toBe(8);
  usage = { ...usage!, tokens: 100000 };
  const capped = await handleAPI(request(), configured, actual);
  expect((await capped.json()).code).toBe('global_daily');
});

it('bounds uncertain reservations by estimated tokens instead of every serialized byte', async () => {
  let held = 0;
  const budget = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname === '/reserve')
          held = ((await req.json()) as { tokens: number }).tokens;
        return Response.json({ remaining: 29 });
      },
    }),
  };
  const r = await handleAPI(request(), { ...env, BUDGET: budget }, fetcher());
  expect(r.status).toBe(200);
  expect(held).toBeGreaterThan(2000);
  expect(held).toBeLessThan(7500);
});
it('image route requires separate consent and passes a real multipart input image to the binding (mock)', async () => {
  const image =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  let inference = 0;
  const imageEnv: AIEnv = {
    ...env,
    ENABLE_IMAGE_AI: 'true',
    IMAGE_AI_FREE_VERIFIED: 'true',
    BUDGET: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    AI: {
      run: async (model, input) => {
        inference++;
        expect(model).toBe('@cf/black-forest-labs/flux-2-klein-4b');
        const form = await new Response(input.multipart.body, {
          headers: { 'Content-Type': input.multipart.contentType },
        }).formData();
        expect(form.get('input_image_0')).toBeInstanceOf(Blob);
        expect(form.get('width')).toBe('512');
        return { image };
      },
    },
  };
  const payload = {
    prompt: 'Turn the supplied red square blue.',
    image,
    consent: true,
    sessionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    turnstileToken: 'mock-token',
  };
  const imageRequest = (data: unknown) =>
    new Request('https://proxy.example/api/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://editor.example',
        'CF-Connecting-IP': '192.0.2.1',
      },
      body: JSON.stringify(data),
    });
  expect(
    (await handleAPI(imageRequest({ ...payload, consent: false }), imageEnv, fetcher())).status,
  ).toBe(400);
  expect(inference).toBe(0);
  expect((await handleAPI(imageRequest(payload), imageEnv, fetcher())).status).toBe(200);
  expect(inference).toBe(1);
});
it('image provider daily allocation uses an accurate UTC reset and no paid fallback (mock)', async () => {
  const imageEnv: AIEnv = {
    ...env,
    ENABLE_IMAGE_AI: 'true',
    IMAGE_AI_FREE_VERIFIED: 'true',
    BUDGET: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    AI: {
      run: async () => {
        throw new Error('3036: Account limited');
      },
    },
  };
  const response = await handleAPI(
    new Request('https://proxy.example/api/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://editor.example',
        'CF-Connecting-IP': '192.0.2.1',
      },
      body: JSON.stringify({
        prompt: 'Create an invented blue square.',
        consent: true,
        sessionId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        turnstileToken: 'mock',
      }),
    }),
    imageEnv,
    fetcher(),
  );
  expect(response.status).toBe(429);
  const body = (await response.json()) as { code: string; error: string; retryAfter: number };
  expect(body.code).toBe('image_provider_daily');
  expect(body.error).toContain('midnight UTC');
  expect(body.retryAfter).toBeGreaterThan(0);
  expect(response.headers.get('Retry-After')).toBe(String(body.retryAfter));
});
