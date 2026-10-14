# Production verification — 2026-10-14

Public application: **https://ai-pdf-editor.pages.dev**. Cloudflare returned the exact requested project hostname. Subscription verification passed before resource creation; no billing writes, paid plan activation or upgrades occurred.

## Hosted public workflow

[Deployment and public smoke run](https://github.com/academ1cian/ai-pdf-editor/actions/runs/38594486505), verified source commit `0a98b9356ba62f5da4f68a16ef7c6e9209a79c1d`.

Four Chromium cases passed against the actual public HTTPS site, independently of the local preview: upload/render/manual review/apply/download/PDF.js reopen/original unchanged/undo/reset; invalid input and responsive layout; duplicates/overflow/scans; sample edit and accessibility/keyboard checks. The public version manifest matched the chosen commit. Actual production screenshots are under `docs/screenshots`, downloaded from this run's public-smoke artifact. The public browser tests reported no application page errors.

## Real AI workflow

The real in-app browser loaded the production sample and consented to send this synthetic page to Groq. Real Turnstile completed automatically; no fake token, test site key or CAPTCHA bypass was used. Instruction: “Replace Jordan Example with Robin Sample. Make no other changes.”

Groq `openai/gpt-oss-20b` returned the requested structured proposal. QA selected “Check & review”, confirmed the exact target and replacement, observed Helvetica-Bold 28 pt with no substitution and a passing fit check, then applied the change. The engine reopened the export, checked text/geometry/features and compared the page at 108 dpi without unexpected visual changes. “Download PDF” produced the actual synthetic export preserved in [production-ai.pdf](evidence/production-ai.pdf).

[Independent hosted PDF.js verification](https://github.com/academ1cian/ai-pdf-editor/actions/runs/38596234860) passed:
- One page before and after.
- `Robin Sample` is searchable and `Jordan Example` is absent.
- All other extracted text is preserved (comparison ignores PDF content-stream order).
- Output bytes differ; the public original still contains its original name.
- Original SHA-256: `53c1b64bde9efaff1d340e037df492795c7a17c2ebd260d3caa0d1dc65f467ef`.
- Export SHA-256: `d1b2cff0351f7c88ef4db224627e44822d666c44486056df01b46e6408e197a6`.

[Machine-readable result](evidence/production-ai-verification.json) records the actual checked revision and timestamp. `scripts/verify-production-ai.mjs` reruns extraction on the stored **actual production export**; it does not call or simulate a provider. Testing a new live provider request requires the real UI workflow again.

Turnstile's cross-origin iframe emitted opaque NaN diagnostic console messages. They did not prevent verification or the provider request; no application JavaScript errors were observed. This is recorded rather than claiming an entirely empty console.

## Deployment reliability and repeatability

Main-push quality success actually triggered deployment. The initial upload exposed a Pages custom-config restriction (fixed), followed by a routing propagation race (retry succeeded). Deployment now uses the required standard Pages config filename only in the ephemeral runner checkout and waits for both enabled API configuration and the exact public version before starting its credential-free smoke job.

GitHub Actions stores provider/deployment credentials. Only the provisioning step receives Groq/Turnstile secrets and sends them directly over TLS to Cloudflare Worker secrets. Public builds, screenshots, PDFs and test artifacts contain synthetic/public data only. The free-account read gate and conservative transactional AI budgets remain enabled.

## Scope

This is the constrained MVP: short single-line printable ASCII replacements in standard PDF fonts that fit the original area. Embedded/custom fonts, scans, forms/signatures, encryption, semantic tags and complex geometry remain unsupported. Validation is not certification of arbitrary PDF features or secure document sanitization.
