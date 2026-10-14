// GitHub-hosted runner only. Never log HTTP bodies, headers, env, or secret values.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function assertFreeSubscriptions(subscriptions) {
  if (!Array.isArray(subscriptions))
    throw new Error('Cannot verify Cloudflare plan. Deployment stopped.');
  // Be conservative: a dedicated account with no paid account-level subscriptions is required.
  for (const sub of subscriptions) {
    const plan = sub.rate_plan;
    if (
      typeof sub.price !== 'number' ||
      sub.price !== 0 ||
      !plan ||
      plan.externally_managed ||
      plan.is_contract ||
      !/free/i.test(`${plan.id || ''} ${plan.public_name || ''}`) ||
      /paid|enterprise|business|\bpro\b|\bbasic\b|\bstandard\b/i.test(
        `${plan.id || ''} ${plan.public_name || ''}`,
      )
    )
      throw new Error(
        'A paid or unrecognized account subscription was found. Only a verified free account is allowed. No billing changes were made.',
      );
  }
}
export function settings(env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const project = env.CF_PAGES_PROJECT || 'ai-pdf-editor';
  if (!/^[a-f0-9]{32}$/i.test(account || ''))
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be configured.');
  if (!/^[a-z0-9][a-z0-9-]{1,56}[a-z0-9]$/.test(project))
    throw new Error('Invalid Pages project name.');
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is missing.');
  if (env.CF_FREE_PLAN_CONFIRMED !== 'true')
    throw new Error(
      'Confirm Workers Free and Groq Free in the browser, then set CF_FREE_PLAN_CONFIRMED=true.',
    );
  return {
    account,
    project,
    origin: `https://${project}.pages.dev`,
    worker: 'ai-pdf-editor-proxy',
  };
}
export async function cfRequest(
  env,
  path,
  { method = 'GET', body, allow404 = false } = {},
  fetcher = fetch,
) {
  const { account } = settings(env);
  let response;
  try {
    response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Cloudflare could not be reached. No credential details are logged.');
  }
  if (response.status === 404 && allow404) return null;
  // Do not include response bodies or request parameters in exceptions.
  if (!response.ok)
    throw new Error(
      `Cloudflare ${method} request failed (HTTP ${response.status}). Check token permissions in Cloudflare.`,
    );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Cloudflare returned an invalid response.');
  }
  if (!data.success) throw new Error('Cloudflare rejected a request. Check the account dashboard.');
  return data;
}
export async function provisionSecrets(env, fetcher = fetch) {
  const { worker } = settings(env);
  for (const name of ['GROQ_API_KEY', 'TURNSTILE_SECRET'])
    if (!env[name] || env[name].includes('\n'))
      throw new Error(`Repository secret ${name} is missing or invalid.`);
  for (const name of ['GROQ_API_KEY', 'TURNSTILE_SECRET'])
    await cfRequest(
      env,
      `/workers/scripts/${worker}/secrets`,
      { method: 'PUT', body: { name, type: 'secret_text', text: env[name] } },
      fetcher,
    );
  return { provisioned: ['GROQ_API_KEY', 'TURNSTILE_SECRET'] };
}
async function verifyFree(env) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const data = await cfRequest(env, `/subscriptions?page=${page}&per_page=50`);
    items.push(...data.result);
    const total =
      data.result_info?.total_pages ??
      Math.ceil((data.result_info?.total_count ?? items.length) / 50);
    if (page >= total) {
      assertFreeSubscriptions(items);
      console.log(
        'Free-account subscription check passed. No subscription or billing API writes are used.',
      );
      return;
    }
  }
  throw new Error('Could not finish the account plan check. Deployment stopped.');
}
async function runWrangler(args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    timeout: 180000,
  });
  if (result.status !== 0) throw new Error('Remote Cloudflare deployment command failed.');
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Run this deployment from GitHub Actions. No local credentials are needed.');
  const mode = process.argv[2];
  const env = process.env;
  const { project, origin, worker } = settings(env);
  if (mode === 'secrets') {
    await provisionSecrets(env);
    console.log('Worker secrets provisioned securely. Values were not printed or written to disk.');
    return;
  }
  if (mode === 'prepare') {
    await verifyFree(env);
    if (
      !env.TURNSTILE_SITE_KEY ||
      env.TURNSTILE_SITE_KEY.startsWith('1x') ||
      env.TURNSTILE_SITE_KEY.startsWith('2x')
    )
      throw new Error(
        'Configure a real public TURNSTILE_SITE_KEY; test keys are not allowed in production.',
      );
    const existing = await cfRequest(env, `/pages/projects/${project}`, { allow404: true });
    let projectResult = existing;
    if (!existing)
      projectResult = await cfRequest(env, '/pages/projects', {
        method: 'POST',
        body: { name: project, production_branch: 'main' },
      });
    else if (existing.result.name !== project || existing.result.production_branch !== 'main')
      throw new Error('Existing Pages project configuration differs. Stopped before changing it.');
    if (projectResult.result.subdomain !== `${project}.pages.dev`)
      throw new Error(
        `Cloudflare assigned a different public hostname: ${projectResult.result.subdomain}. Update the planned hostname and Turnstile before proceeding. No AI was enabled.`,
      );
    await mkdir('.deployment', { recursive: true });
    const config = JSON.parse(
      (await readFile('wrangler.jsonc', 'utf8')).replace(/^\s*\/\/.*$/gm, ''),
    );
    config.vars = {
      ...config.vars,
      ENABLE_AI: 'true',
      ALLOWED_ORIGIN: origin,
      TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY,
    };
    // Config lives at repository root so relative entrypoints remain correct.
    await writeFile('wrangler.generated.json', JSON.stringify(config, null, 2));
    const pages = JSON.parse(await readFile('wrangler.pages.jsonc', 'utf8'));
    pages.name = project;
    await writeFile('wrangler.pages.generated.json', JSON.stringify(pages, null, 2));
    console.log('Prepared free Pages/SQLite Worker configuration for', origin);
    await runWrangler(['deploy', '--config', 'wrangler.generated.json']);
    return;
  }
  if (mode === 'pages') {
    // Pages only accepts a standard Wrangler filename. This ephemeral runner checkout
    // uses the Pages config at the root during upload, then restores the Worker config.
    const workerConfig = await readFile('wrangler.jsonc', 'utf8');
    await writeFile('wrangler.jsonc', await readFile('wrangler.pages.generated.json', 'utf8'));
    try {
      await runWrangler([
        'pages',
        'deploy',
        'dist',
        '--project-name',
        project,
        '--branch',
        'main',
        '--commit-hash',
        env.GITHUB_SHA,
      ]);
    } finally {
      await writeFile('wrangler.jsonc', workerConfig);
    }
    // A successful upload can precede production routing propagation.
    let publicReady = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const [config, version] = await Promise.all([
          fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(10000) }),
          fetch(`${origin}/version.json?deployment=${env.GITHUB_SHA}`, {
            signal: AbortSignal.timeout(10000),
          }),
        ]);
        publicReady =
          config.ok &&
          version.ok &&
          (await config.json()).enabled === true &&
          (await version.json()).commit === env.GITHUB_SHA;
        if (publicReady) break;
      } catch {
        // Transient routing/network failures are retried; response bodies are not logged.
      }
      if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!publicReady)
      throw new Error(
        'Public API/version checks failed after propagation retries. Deployment is not verified.',
      );
    // Public metadata only; available to the following smoke-test job.
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `url=${origin}\n`);
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `Deployed commit ${env.GITHUB_SHA} to ${origin}. Manual browser smoke tests must pass; live AI still needs a real Turnstile-authorized browser check.\n`,
      );
    console.log('Public frontend and AI configuration accessible:', origin, 'Worker:', worker);
    return;
  }
  throw new Error('Unknown deployment step.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
