# Browser-only Cloudflare deployment

No local Node.js, Wrangler installation, or API key in chat is needed. The source repository is public at https://github.com/academ1cian/ai-pdf-editor. GitHub Actions runs tests on standard hosted Ubuntu runners. Cloudflare builds from GitHub on its infrastructure. Use your personal account and only free plans; do not enable billing or paid services.

## 1. Publish the frontend from GitHub

1. Sign in directly to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **Workers & Pages → Create application → Pages → Connect to Git**. Authorize Cloudflare's GitHub integration yourself, granting access only to `academ1cian/ai-pdf-editor`.
3. Set project name `ai-pdf-editor` (or an available alternative), production branch `main`, framework `Vite`, root directory `/`, build command `pnpm build`, output directory `dist`.
4. Build environment: `NODE_VERSION=24`, `PNPM_VERSION=11.25.0`. The repository lockfile pins dependencies. `pnpm fixtures` is part of the build so the synthetic sample is generated.
5. Save and deploy. Record the **actual** returned pages.dev URL and deployed commit. There is no live demo URL until this deployment succeeds.

The Pages functions return an honest AI-disabled response until the proxy service binding is configured. Manual editing is completely client-side and works first.

## 2. Deploy the protected AI Worker

1. In Workers & Pages, create a Worker from the **same GitHub repository** using Cloudflare Workers Builds. Name it `ai-pdf-editor-proxy`, branch `main`.
2. Root directory `/`; build command `pnpm typecheck`; deploy command `pnpm exec wrangler deploy --config wrangler.jsonc`. Cloudflare runs Wrangler remotely; you install nothing on your computer.
3. `wrangler.jsonc` declares an `AIBudget` SQLite Durable Object migration and binding, supported on Workers Free. Do not switch it to the legacy paid-only key-value backend.
4. Leave `ENABLE_AI=false` until the following setup is complete.

## 3. Configure secrets directly in Cloudflare

1. Create a free **Turnstile managed widget** in Cloudflare for the actual pages.dev hostname. Save its public site key and secret in the Cloudflare UI. No secret is needed in chat.
2. Worker → **Settings → Variables and Secrets → Add → Secret**:
   - `GROQ_API_KEY`: enter the key directly from your Groq Free account.
   - `TURNSTILE_SECRET`: enter the widget's secret directly.
3. Nonsecret settings in the tracked Worker configuration must match the real deployment:
   - `ALLOWED_ORIGIN`: the exact HTTPS pages.dev origin, no trailing slash.
   - `TURNSTILE_SITE_KEY`: the widget's public site key.
   - `GROQ_MODEL`: `openai/gpt-oss-20b`, verified in Groq's structured-output docs on 2026-10-14. Check account model access before enabling.
   - `ENABLE_AI`: `true`, only after both secrets and Turnstile are ready.
4. These nonsecret values can be provided to the development agent in chat; it updates the tracked config. Wrangler deployment uses configuration-file variables as its source of truth, so dashboard-only nonsecret overrides could be overwritten by the next build.
5. Pages project → **Settings → Bindings → Service binding**: variable `AI_PROXY`, service `ai-pdf-editor-proxy`. Redeploy Pages to apply the binding. A `wrangler.pages.jsonc` example is included for optional CI/direct deployment; native Git integration can configure the binding in the dashboard.

The API refuses wrong origins, invalid payloads, failed or wrong-host/action Turnstile tokens, unavailable budget storage and exceeded budgets. PDF text is never stored. Budget counters contain only day-scoped salted client hashes and usage counts. Global maximum: 40 requests / 50,000 conservatively reserved tokens per UTC day. Per client: 2 requests/minute, 6/day. Failed upstream attempts consume their reservation. Groq's organization quota can be shared with other applications; this app cannot control those applications.

## 4. Verify the actual deployment

1. Access the actual URL and `/api/config`. Check build commit, JS/WASM/font loads, and console/network errors.
2. GitHub → Actions → **Verify public deployment → Run workflow**: supply the actual HTTPS pages.dev URL. It uploads a real fixture, reviews/applies a replacement, downloads the PDF, independently extracts exported text, verifies original bytes, and checks undo/reset. These are remote tests.
3. In the public app, open the sample, choose AI assistant, consent to sending the current page's extracted text, and complete Turnstile. Ask to replace `Jordan Example` with `Robin Sample`. Review, apply, download, and independently verify the result. An automated test cannot replace a real Turnstile challenge with a fake token while claiming live production AI works.
4. Push a subsequent harmless documentation change and confirm Cloudflare automatically deploys the matching commit before claiming continuous deployment is verified.

Until these checks execute successfully, status remains **PARTIALLY COMPLETE**.

## Alternative: GitHub Actions deployment with browser-entered repository secrets

If Cloudflare Git integration is unavailable, use a narrowly scoped Cloudflare API token stored **directly in GitHub's repository environment secrets UI**, and execute Wrangler only on a hosted runner. A token must be scoped to the chosen account and the Pages/Workers deployment resources, with no billing or unrelated account privileges. Do not paste it into chat or commit it. This route still needs user authorization in the browser; there is no preauthenticated Cloudflare connector or remote OAuth session in this chat.

## Free infrastructure references

Reviewed 2026-10-14: [Pages Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/), [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [dashboard secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [SQLite Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/), [Groq Free limits](https://console.groq.com/docs/rate-limits).

Pages Free documents 500 builds/month and 25 MiB per asset. The MuPDF WASM asset is about 10.4 MB before HTTP compression. Workers Free and SQLite Durable Objects stop serving over their free limits; no paid-plan upgrade is performed. Confirm the account is on Free before creating resources. Account-specific plans, quotas, native build auth and public deployment have not yet been verified.
