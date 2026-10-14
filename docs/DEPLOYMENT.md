# GitHub Actions → Cloudflare Free

All install/build/test/deployment commands execute on standard GitHub-hosted Ubuntu runners. No local Node.js, Wrangler or secret file is required. Secrets are entered directly in the GitHub browser interface.

## Exact setup

Repository: https://github.com/academ1cian/ai-pdf-editor

Requested Pages project: **`ai-pdf-editor`**. Planned production hostname: **`ai-pdf-editor.pages.dev`**. This is not a claimed live URL until Cloudflare deployment succeeds. The script checks the actual returned `subdomain` and stops if Cloudflare assigns something different. `CF_PAGES_PROJECT` can override the project name after a collision is resolved explicitly.

Create a free managed Turnstile widget for **`ai-pdf-editor.pages.dev`**. Do not use testing site keys in production. The proxy verifies both that exact hostname and action `pdf-plan`.

In [repository Actions secrets](https://github.com/academ1cian/ai-pdf-editor/settings/secrets/actions), add:

| Secret | Purpose |
|---|---|
| `GROQ_API_KEY` | Key from Groq Free; received only by the provisioning step |
| `CLOUDFLARE_API_TOKEN` | Account-scoped deployment and read-only subscription verification |
| `CLOUDFLARE_ACCOUNT_ID` | The chosen Cloudflare account ID |
| `TURNSTILE_SECRET` | Real widget's server-side verification secret |

Create the Cloudflare token directly in its dashboard. Limit account resources to the chosen account. Permissions:

- **Cloudflare Pages: Edit** for Pages project creation/deployment.
- **Workers Scripts: Edit** (`Workers Scripts Write` in the API) for the Worker, SQLite Durable Object migration and Worker secrets. Newer permission UIs may expose Workers Admin; initial creation needs permission to create a new Worker. Do not grant unrelated zone, DNS, storage or routing permissions.
- **Billing: Read**, only to verify account-level subscriptions. **No Billing Write** and no subscription-change endpoints are used.

In [repository Actions variables](https://github.com/academ1cian/ai-pdf-editor/settings/variables/actions), add:

| Variable | Value |
|---|---|
| `TURNSTILE_SITE_KEY` | Real widget's public site key |
| `CF_FREE_PLAN_CONFIRMED` | `true` after verifying Workers Free and Groq Free in their dashboards |
| `DEPLOY_ENABLED` | `true` when deployment is authorized and secrets are ready |
| `CF_PAGES_PROJECT` | Optional; default `ai-pdf-editor` |

Never paste tokens/keys into chat or source. A GitHub repository secret cannot be read back through this application; only the hosted deployment step receives it.

## Pipeline and secret isolation

1. **Quality and PDF integrity** runs on main pushes: frozen install, synthetic fixtures, both TypeScript environments, lint, unit/integration/deployment-safety tests, executable PDF proof, frontend build, Worker dry-run compilation, and Chromium/Firefox/WebKit tests.
2. **Deploy to Cloudflare Free** follows a successful same-repository main push. Forked PRs cannot deploy; manual dispatch is restricted to main.
3. A separate build job checks/builds the actual chosen commit with **no provider or deployment secrets**. Its artifact contains only public frontend files. The public version manifest records the exact commit.
4. The deploy job installs dependencies before credentials are provided. A step verifies account subscriptions through read-only API calls. It refuses missing/unknown plans, paid plans and externally managed contracts; a dedicated account with no paid account-level subscriptions is the conservative supported setup. It never upgrades plans or activates billing.
5. It creates the Pages project if absent, verifies the assigned hostname, writes **nonsecret-only** generated Wrangler configuration, and deploys the Worker with a SQLite-backed Durable Object. Missing secrets keep AI fail-closed.
6. A separate step receives `GROQ_API_KEY` and `TURNSTILE_SECRET` and sends each directly over TLS to Cloudflare's Worker Secret API. **No secret-valued shell arguments, temporary files, build inputs, artifacts, or logs.** Errors contain normalized status information, never request/response bodies or credential values.
7. It deploys Pages with a service binding `AI_PROXY` to the Worker. The browser calls the same-origin `/api/plan`, not a secret-bearing third-party URL. The script verifies public `/api/config` reports AI configured.
8. A separate hosted smoke job receives **no deployment/provider credentials**. It tests actual PDF upload, rendering, manual proposal/apply/download, independent exported-text extraction, original bytes, undo/reset and critical rejection cases. It checks the public version manifest against the intended commit.

The deployment workflow is `.github/workflows/deploy.yml`. Run it through the [Actions UI](https://github.com/academ1cian/ai-pdf-editor/actions/workflows/deploy.yml) when setup is complete, or let the next successful main-push quality run trigger it.

## Live AI verification

In the actual public app, open the synthetic sample, choose AI assistant, consent to sending current-page extracted text, and complete real Turnstile if prompted. Ask to replace `Jordan Example` with `Robin Sample`. The model must return a real structured proposal, the user/QA must review/apply it, and the downloaded PDF must independently contain the replacement without the original in its target region.

Automated API mocks and fake CAPTCHA tokens are not live integration evidence. A human-interactive challenge requires participation in the browser. Until real provider/Turnstile and public export checks succeed, project status remains PARTIALLY COMPLETE.

## Abuse protection and free limits

Global maximum: 40 requests / 50,000 conservatively reserved tokens per UTC day. Per client: 2/minute, 6/day. Failed upstream requests consume reservations. Budget storage is transactional, strongly consistent SQLite Durable Object storage; unavailable storage fails closed. Stored counters contain salted day-scoped client hashes and counts, no PDF text/raw IPs.

Groq's documented Free allowance for `openai/gpt-oss-20b` on 2026-10-14: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD, subject to account exceptions. This app's budget is smaller, but cannot control other applications sharing the organization quota. Provider rate limits remain authoritative. Strict structured outputs are required; no obsolete-model fallback is silently attempted.

Cloudflare Pages Free documents 500 builds/month and 25 MiB per asset. MuPDF's WASM asset is approximately 10.4 MB uncompressed. Workers Free supports SQLite Durable Objects and fails requests beyond free limits. The project uses no paid-only storage, custom domain, purchased service or billing write operation.

## Alternatives without a deployment token

Cloudflare's native Git integration can build Pages and Workers directly from this repository after browser authorization. It requires setting Worker secrets in Cloudflare's UI instead of GitHub. This is an alternative; the owner's selected path is GitHub Actions repository secrets.

## Primary references

Reviewed 2026-10-14: [Pages CI deployment](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/), [Worker GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Worker permissions](https://developers.cloudflare.com/workers/authorization/workers/), [read-only subscriptions API](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [SQLite Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Turnstile Free](https://developers.cloudflare.com/turnstile/plans/), [Groq rate limits](https://console.groq.com/docs/rate-limits), [Groq strict outputs](https://console.groq.com/docs/structured-outputs).
