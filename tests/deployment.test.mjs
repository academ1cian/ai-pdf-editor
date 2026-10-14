import { it, expect } from 'vitest';
import { assertFreeSubscriptions, provisionSecrets, settings } from '../scripts/deployment.mjs';
const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'dummy-token',
  GROQ_API_KEY: 'dummy-groq',
  TURNSTILE_SECRET: 'dummy-turnstile',
  CF_FREE_PLAN_CONFIRMED: 'true',
};
it('rejects paid, ambiguous, and externally managed subscriptions', () => {
  expect(() => assertFreeSubscriptions([])).not.toThrow();
  expect(() =>
    assertFreeSubscriptions([
      { price: 0, rate_plan: { id: 'workers_free', public_name: 'Workers Free' } },
    ]),
  ).not.toThrow();
  for (const sub of [
    { price: 5, rate_plan: { id: 'workers_paid' } },
    { rate_plan: { id: 'free' } },
    { price: 0, rate_plan: { id: 'enterprise' } },
    { price: 0, rate_plan: { id: 'unknown' } },
    { price: 0, rate_plan: { id: 'free', public_name: 'Business Plan' } },
    { price: 0, rate_plan: { id: 'free', externally_managed: true } },
  ])
    expect(() => assertFreeSubscriptions([sub])).toThrow();
});
it('requires explicit zero-budget account confirmation', () => {
  expect(() => settings({ ...env, CF_FREE_PLAN_CONFIRMED: 'false' })).toThrow();
  expect(() => settings({ ...env, CF_PAGES_PROJECT: 'bad/../project' })).toThrow();
});
it('transmits secrets only to the Worker secret endpoint, never in URL', async () => {
  const calls = [];
  const mock = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ success: true, result: {} });
  };
  const result = await provisionSecrets(env, mock);
  expect(result).toEqual({ provisioned: ['GROQ_API_KEY', 'TURNSTILE_SECRET'] });
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.url).toMatch(/\/workers\/scripts\/ai-pdf-editor-proxy\/secrets$/);
    expect(call.url).not.toContain('dummy');
    expect(call.options.method).toBe('PUT');
    expect(JSON.parse(call.options.body).type).toBe('secret_text');
  }
  expect(JSON.parse(calls[0].options.body).text).toBe(env.GROQ_API_KEY);
});
it('does not echo secret values in errors', async () => {
  await expect(
    provisionSecrets(env, async () => new Response('dummy-groq dummy-token', { status: 403 })),
  ).rejects.toThrow('HTTP 403');
  try {
    await provisionSecrets(
      env,
      async () => new Response('dummy-groq dummy-token', { status: 403 }),
    );
  } catch (error) {
    expect(String(error)).not.toContain('dummy');
  }
});
