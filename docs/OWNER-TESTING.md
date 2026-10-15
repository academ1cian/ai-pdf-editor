# Owner testing without application quotas

Set the **server-side** variable `AI_APP_LIMITS_ENABLED=false` to bypass every application quota for text and image AI. The deployed owner-testing configuration uses this value. Missing values default to quotas enabled; `true` re-enables the existing configurable quotas. GitHub Actions passes the repository variable through `scripts/deployment.mjs` into the Worker, falling back to the checked-in Worker configuration.

Disabled mode never calls the quota Durable Object: no global/session/network request or token allowances, daily attempt cap, rolling reservations, estimate-based 7500-token rejection, accounting failures or application cooldowns can block it. Existing counters are retained untouched for later re-enablement, and are never consulted in disabled mode. No replacement hidden quota is introduced. Image quotas are bypassed too. Normal limits on uploaded bytes, context size, output size, image resolution and execution time remain resource-safety checks.

## Owner authentication

The website and local PDF tools remain public. **All unrestricted text/image provider requests require an authenticated owner session**, in addition to origin checks, document consent and Turnstile. Anonymous requests receive `401 owner_required` before verification/provider calls. Direct access through the proxy's workers.dev URL cannot create an owner session.

An owner P-256 key is generated locally, with its private JSON file in `owner-access-key.json` in the workspace folder containing the Git checkout (outside the repository, file mode 0600). Keep a secure backup of that file; it is the owner login credential. Select it with **Sign in with your owner key file** on the website. The browser imports it locally with Web Crypto and sends only a signature over a short-lived, server-authenticated challenge. The private key never leaves the device, enters public assets, CI, logs or provider context. Only the public JWK is configured in `AI_OWNER_PUBLIC_KEY` (checked-in Worker variable or optional GitHub repository variable).

The server issues a Secure, HttpOnly, SameSite=Strict host-only cookie, valid for eight hours. Signing out clears it. Authentication expiry is not a usage allowance. Changing the public key or the existing server signing secret invalidates old sessions. Unrestricted deployment fails closed without a valid public key; a private JWK is explicitly rejected. No extra API key, OAuth account, service subscription or paid access product is needed.

Cryptography uses the [Workers Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/): P-256 ECDSA with SHA-256 for owner proofs and a purpose-separated HMAC for challenges/sessions. Owner secrets are never VITE variables.

## Actual provider limits and retries

Groq's real organization limits still apply. Only a real Groq HTTP 429 with `provider_rate_limit` schedules an automatic retry. The browser displays the provider's delay and next retry time, waits that delay, refreshes Turnstile, and retries the frozen logical request with a fresh submission ID. A request makes at most three provider attempts. **Cancel AI request** interrupts waiting/verification/fetch; the instruction and previous validated PDF remain available for immediate approval. No retries occur for application errors, authentication, invalid output or uncertain network failures. The Worker never rotates same-organization keys on 429; the optional standby remains authentication-failure-only.

The candidate is rebuilt once a complete successful plan arrives, from the approved base and accumulated edits. Waiting/failed attempts cannot duplicate edits or apply financial operations twice. Requests supported by the local interpreter always run locally, even when the cloud-consent checkbox is checked. Consent permits cloud use for other requests; it does not force cloud use.

The free-account deployment check remains mandatory. Actual Cloudflare free allocation limits still apply to image AI. No paid service, billing write, upgrade or top-up was added.

## Verification

Server tests use generated test keys and mock provider responses to verify owner authentication, expired/forged proofs, old exhausted stores, sequential requests above former session limits, a valid context above the former 7500 estimate, image quota bypass, retained input/verification checks, and real-provider error classification. Retry tests verify delay, fresh verification, cancellation, bounded attempts and unchanged pending edit summaries. Browser tests capture genuine downloads and compare preview/download SHA-256, including financial follow-ups with cloud consent checked, successful retry and cancelled retry. Mocked 429 tests do not claim live quota exhaustion.
