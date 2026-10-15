import { appLimitsEnabled, ownerAuthorized } from './owner';
import type { AIEnv } from './api';
export const IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
export const IMAGE_BUDGET = {
  dailyRequests: 8,
  dailyTokens: 8,
  perMinute: 1,
  perDay: 2,
  networkDay: 4,
  networkMinute: 2,
};
export function imageEnabled(env: AIEnv) {
  return (
    env.ENABLE_IMAGE_AI === 'true' &&
    env.IMAGE_AI_FREE_VERIFIED === 'true' &&
    !!env.AI &&
    (!appLimitsEnabled(env) || !!env.BUDGET) &&
    !!env.TURNSTILE_SECRET &&
    !!env.TURNSTILE_SITE_KEY &&
    !!env.ALLOWED_ORIGIN
  );
}
export async function editImage(
  binding: NonNullable<AIEnv['AI']>,
  prompt: string,
  image?: Uint8Array,
) {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', '512');
  form.append('height', '512');
  if (image)
    form.append(
      'input_image_0',
      new Blob([image.slice().buffer], { type: 'image/png' }),
      'selection.png',
    );
  const serialized = new Response(form);
  return binding.run(IMAGE_MODEL, {
    multipart: { body: serialized.body!, contentType: serialized.headers.get('content-type')! },
  });
}
export async function handleImage(
  request: Request,
  env: AIEnv,
  fetcher: typeof fetch,
  readBody: (r: Request, limit: number) => Promise<string>,
) {
  const origin = env.ALLOWED_ORIGIN;
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(typeof body === 'object' &&
        body &&
        'retryAfter' in body &&
        typeof body.retryAfter === 'number'
          ? { 'Retry-After': String(Math.ceil(body.retryAfter)) }
          : {}),
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      },
    });
  if (!origin || request.headers.get('Origin') !== origin)
    return json({ error: 'This origin is not allowed.', code: 'origin' }, 403);
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  if (request.method !== 'POST') return json({ error: 'Use POST for image editing.' }, 405);
  if (!appLimitsEnabled(env) && !(await ownerAuthorized(request, env)))
    return json(
      {
        error: 'Sign in with your owner key to use unrestricted image AI.',
        code: 'owner_required',
      },
      401,
    );
  if (!imageEnabled(env))
    return json(
      {
        error:
          'Free image AI is unavailable. Uploaded replacements and exact local logo wording remain available.',
        code: 'image_unavailable',
      },
      503,
    );
  let payload: {
    prompt: string;
    image?: string;
    consent: boolean;
    sessionId: string;
    requestId: string;
    turnstileToken: string;
  };
  let input: Uint8Array | undefined;
  try {
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Error();
    payload = JSON.parse(await readBody(request, 1500000));
    if (
      payload.consent !== true ||
      typeof payload.prompt !== 'string' ||
      payload.prompt.trim().length < 3 ||
      payload.prompt.length > 800 ||
      typeof payload.turnstileToken !== 'string' ||
      payload.turnstileToken.length > 2048 ||
      ![payload.sessionId, payload.requestId].every(
        (id) => typeof id === 'string' && /^[a-f\d-]{36}$/i.test(id),
      )
    )
      throw new Error();
    if (payload.image) {
      if (typeof payload.image !== 'string' || payload.image.length > 1400000) throw new Error();
      input = Uint8Array.from(atob(payload.image), (c) => c.charCodeAt(0));
      if (input.length < 24 || new TextDecoder().decode(input.slice(1, 4)) !== 'PNG')
        throw new Error();
      const view = new DataView(input.buffer),
        w = view.getUint32(16),
        h = view.getUint32(20);
      if (!w || !h || w >= 512 || h >= 512) throw new Error();
    }
  } catch {
    return json(
      {
        error:
          'Invalid image request. Use a selected PNG crop smaller than 512 × 512 and explicit image consent.',
        code: 'invalid_image',
      },
      400,
    );
  }
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return json({ error: 'Client verification is unavailable.', code: 'verification' }, 403);
  let stage = 'verification';
  let rejectProvider: ((retryAfter: number) => Promise<void>) | undefined;
  try {
    const v = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET!,
          response: payload.turnstileToken,
          remoteip: ip,
        }),
        signal: AbortSignal.timeout(8000),
      }),
      verified = (await v.json()) as { success?: boolean; hostname?: string; action?: string };
    if (
      !v.ok ||
      !verified.success ||
      verified.hostname !== new URL(origin).hostname ||
      verified.action !== 'pdf-plan'
    )
      return json({ error: 'Please complete verification again.', code: 'turnstile_failed' }, 403);
    let settleImage: () => Promise<void> = async () => {};
    if (appLimitsEnabled(env)) {
      const day = new Date().toISOString().slice(0, 10),
        hash = async (s: string) =>
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(day + ':image:' + s + ':' + env.TURNSTILE_SECRET),
              ),
            ),
          )
            .map((n) => n.toString(16).padStart(2, '0'))
            .join('');
      const client = await hash(payload.sessionId),
        network = await hash(ip),
        id = client.slice(0, 24) + ':' + payload.requestId;
      const budget = env.BUDGET!.get(env.BUDGET!.idFromName('global-workers-ai-image-budget'));
      stage = 'accounting';
      const reservation = await budget.fetch(
        new Request('https://budget/reserve', {
          method: 'POST',
          body: JSON.stringify({ client, network, id, tokens: 1, kind: 'image' }),
        }),
      );
      const usage = (await reservation.json()) as { reason?: string; retryAfter?: number };
      if (!reservation.ok)
        return json(
          {
            error:
              'The separate image allowance is temporarily unavailable. Local logo and upload tools still work. Daily limits reset at midnight UTC.',
            code: 'image_' + (usage.reason || 'budget'),
            retryAfter: usage.retryAfter || 60,
          },
          429,
        );
      rejectProvider = async (retryAfter) => {
        await budget.fetch(
          new Request('https://budget/reconcile', {
            method: 'POST',
            body: JSON.stringify({ client, id, rejected: true, kind: 'image' }),
          }),
        );
        await budget.fetch(
          new Request('https://budget/cooldown', {
            method: 'POST',
            body: JSON.stringify({
              client,
              id,
              retryAfter,
              reason: 'provider_rate_limit',
              kind: 'image',
            }),
          }),
        );
      };
      settleImage = async () => {
        await budget.fetch(
          new Request('https://budget/reconcile', {
            method: 'POST',
            body: JSON.stringify({ client, id, actual: 1, kind: 'image' }),
          }),
        );
      };
    }
    stage = 'provider';
    // No automatic retries, paid model fallback, AI Gateway credits, or top-ups.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      editImage(env.AI!, payload.prompt, input),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timeout')), 45000);
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    if (!result.image || typeof result.image !== 'string' || result.image.length > 3000000)
      return json(
        {
          error: 'Image AI returned an invalid result. Previous PDF preview preserved.',
          code: 'image_invalid_output',
        },
        502,
      );
    const signature = atob(result.image.slice(0, 32));
    if (!signature.startsWith('\x89PNG') && !signature.startsWith('\xff\xd8'))
      return json(
        {
          error: 'Image AI returned an unsupported image format. Previous preview preserved.',
          code: 'image_invalid_output',
        },
        502,
      );
    stage = 'accounting';
    await settleImage();
    return json({
      image: result.image,
      model: IMAGE_MODEL,
      usage: appLimitsEnabled(env)
        ? 'Separate application allowance: 8 images/day shared, 2/session/day. Cloudflare free Neuron allocation is account-wide and resets at midnight UTC.'
        : 'Application quotas disabled for authenticated owner testing. Actual Cloudflare free allocation still applies.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = message.match(
      /(?:^|\D)(3036|3040|5018|5016|3023|3041|5035|5007|3042)(?:\D|$)/,
    )?.[1];
    if (stage === 'provider' && code) {
      if (['3036', '3040'].includes(code)) {
        const retryAfter =
          code === '3036'
            ? Math.ceil(
                (Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z') +
                  86400000 -
                  Date.now()) /
                  1000,
              )
            : 60;
        await rejectProvider?.(retryAfter).catch(() => {});
        return json(
          {
            error:
              code === '3036'
                ? 'Cloudflare’s account-wide free image allocation is exhausted. It resets at midnight UTC. Use local or uploaded images; no paid fallback is enabled.'
                : 'Cloudflare image capacity is temporarily busy. Wait one minute; your existing preview remains available.',
            code: code === '3036' ? 'image_provider_daily' : 'image_provider_capacity',
            retryAfter,
          },
          429,
        );
      }
      return json(
        {
          error:
            'This account cannot access the configured free image model. Use uploaded images or exact local logo wording. No paid model is used.',
          code: 'image_provider_access',
        },
        503,
      );
    }
    return json(
      {
        error:
          stage === 'verification'
            ? 'Image verification could not be reached.'
            : stage === 'accounting'
              ? 'Image usage accounting is temporarily unavailable.'
              : 'Workers AI image editing is unavailable or timed out. Your previous preview is preserved; use upload or exact local wording. Provider usage may be uncertain.',
        code: 'image_' + stage + '_unavailable',
      },
      502,
    );
  }
}
