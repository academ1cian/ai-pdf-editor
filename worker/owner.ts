import type { AIEnv } from './api';
export const appLimitsEnabled = (env: AIEnv) => env.AI_APP_LIMITS_ENABLED !== 'false';
const enc = new TextEncoder();
const cookieName = '__Host-pdf-owner';
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const decode = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function publicKey(env: AIEnv): JsonWebKey {
  const key = JSON.parse(String(env.AI_OWNER_PUBLIC_KEY || 'null')) as JsonWebKey;
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || !key.x || !key.y || key.d)
    throw new Error('Owner public key is not configured.');
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
}
async function signingKey(env: AIEnv) {
  if (!env.TURNSTILE_SECRET || !env.ALLOWED_ORIGIN)
    throw new Error('Owner authentication is not configured.');
  // Separate cryptographic purpose; neither this secret nor a session token enters client JSON.
  return crypto.subtle.importKey(
    'raw',
    enc.encode(
      'pdf-owner-auth-v1:' +
        env.TURNSTILE_SECRET +
        ':' +
        env.ALLOWED_ORIGIN +
        ':' +
        JSON.stringify(publicKey(env)),
    ),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
async function issue(env: AIEnv, kind: 'challenge' | 'session', lifetime: number) {
  const body = base64(
    enc.encode(
      JSON.stringify({ kind, expires: Date.now() + lifetime, nonce: crypto.randomUUID() }),
    ),
  );
  const mac = await crypto.subtle.sign('HMAC', await signingKey(env), enc.encode(body));
  return body + '.' + base64(new Uint8Array(mac));
}
async function valid(env: AIEnv, token: string, kind: string) {
  if (token.length > 2048) return false;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra) return false;
  if (!(await crypto.subtle.verify('HMAC', await signingKey(env), decode(mac), enc.encode(body))))
    return false;
  const claims = JSON.parse(new TextDecoder().decode(decode(body))) as {
    kind: string;
    expires: number;
  };
  return claims.kind === kind && Number.isFinite(claims.expires) && claims.expires > Date.now();
}
export async function ownerAuthorized(request: Request, env: AIEnv) {
  try {
    const token = request.headers
      .get('Cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1);
    return !!token && (await valid(env, token, 'session'));
  } catch {
    return false;
  }
}
export async function handleOwner(request: Request, env: AIEnv) {
  const path = new URL(request.url).pathname;
  const json = (body: unknown, status = 200, cookie?: string) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(cookie ? { 'Set-Cookie': cookie } : {}),
      },
    });
  if (!env.ALLOWED_ORIGIN || new URL(request.url).origin !== env.ALLOWED_ORIGIN)
    return json(
      { error: 'Owner login requires the configured website.', code: 'owner_origin' },
      403,
    );
  try {
    if (path === '/api/owner/challenge' && request.method === 'GET')
      return json({ challenge: await issue(env, 'challenge', 300000) });
    if (path !== '/api/owner/session' || request.headers.get('Origin') !== env.ALLOWED_ORIGIN)
      return json({ error: 'This origin is not allowed.', code: 'owner_origin' }, 403);
    if (request.method === 'DELETE')
      return json(
        { authenticated: false },
        200,
        `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
      );
    if (
      request.method !== 'POST' ||
      !request.headers.get('Content-Type')?.startsWith('application/json')
    )
      return json({ error: 'Use a JSON owner proof.', code: 'owner_proof' }, 400);
    const reader = request.body?.getReader();
    let size = 0,
      text = '';
    if (!reader) throw new Error();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new Error();
      }
      text += new TextDecoder().decode(value);
    }
    const proof = JSON.parse(text) as { challenge: string; signature: string };
    if (
      typeof proof.challenge !== 'string' ||
      typeof proof.signature !== 'string' ||
      proof.signature.length > 128 ||
      !(await valid(env, proof.challenge, 'challenge'))
    )
      return json(
        {
          error: 'Owner proof expired or invalid. Select your owner key again.',
          code: 'owner_proof',
        },
        401,
      );
    const key = await crypto.subtle.importKey(
      'jwk',
      publicKey(env),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        decode(proof.signature),
        enc.encode('pdf-owner-login-v1:' + proof.challenge),
      ))
    )
      return json({ error: 'This key is not the configured owner key.', code: 'owner_proof' }, 401);
    return json(
      { authenticated: true },
      200,
      `${cookieName}=${await issue(env, 'session', 8 * 3600000)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`,
    );
  } catch {
    return json(
      {
        error: 'Owner authentication is unavailable or the key proof is invalid.',
        code: 'owner_configuration',
      },
      503,
    );
  }
}
