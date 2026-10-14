# Execution log

## 2026-10-14 — Research and editing gate

- Workspace started as an empty Git repository; no unrelated code present.
- GitHub connector authenticated as `academ1cian`; repository creation capability is not exposed by that connector. CLI authentication remains to be checked.
- No Groq/Cloudflare credential environment variables or standard Wrangler configuration found. No deployment or live AI claimed.
- Research: MuPDF.js offers actual redaction plus PDF object/content APIs (AGPL); PDF.js provides independent extraction/rendering (Apache-2.0); pdf-lib creates synthetic fixtures (MIT) but does not expose arbitrary existing-page text removal.
- Next: install tools, implement and measure standalone editing proof against 25+ synthetic fixtures. Choose constrained supported scope from results before UI work.
- Requested hosting: Cloudflare Pages frontend and free Worker proxy. No paid resources authorized.

This log is updated at meaningful milestones. Test and deployment claims must refer to executed checks.

## 2026-10-14 — Manual editor and browser gate

- Selected MuPDF 1.28.1 after the measured editing gate: 31 distinct synthetic PDFs; 23 PASS, 8 EXPECTED UNSUPPORTED, zero FAIL. Exported PDFs independently reopened/extracted by PDF.js. Zero unexpected pixels outside allowed span regions at 108 dpi.
- Fixed meaningful proof failures: inferred whitespace must not be mistaken for real neighboring glyphs; indirect PDF object numbers must not be compared across a garbage-collected rewrite; preserve link objects removed by redaction.
- Implemented React viewer/manual replacement/review/apply/validation/export/undo/reset, Web Worker CPU processing and bounded immutable history.
- Fixed a browser-only initialization race with an explicit worker-ready handshake.
- Executed: 28 Vitest tests pass; 3 real Chrome/Chromium end-to-end tests pass; frontend production build and Worker deployment dry-run succeed. Type checks/lint passed after splitting browser/Worker type environments and pinning compatible TypeScript 6.0.3.
- Actual screenshots captured in docs/screenshots. PDF before/after evidence under tests/evidence.
- Created new public repository `academ1cian/ai-pdf-editor`, ID 1419238721, and published an initial scope/research README using the GitHub connector. No unrelated repositories modified.
- User clarified managed-computer constraints. Further test/build/deployment execution is being moved to GitHub-hosted runners. No separate remote shell is exposed by this chat; initial execution used Codex's bundled local runtime. No more local tool installation is required.
- User chose GitHub Actions repository secrets instead of a local .dev.vars file. Remote deployment workflow provisions Worker secrets directly via Cloudflare's TLS API, isolates frontend build and public smoke jobs from credentials, and refuses paid/unknown account subscriptions. Extra deployment safety tests have been authored; their remote result is pending.
- Pending: publish source milestones through GitHub connector, execute remote Chromium/Firefox/WebKit CI, configure secrets/Turnstile/free-plan confirmation via browser, deploy actual Cloudflare resources, verify public URL/manual export/live AI, verify a subsequent push triggers deployment.
- Current project status: PARTIALLY COMPLETE. Public deployment and real Groq success are not claimed.

## 2026-10-14 — Hosted compatibility and first deployment

- GitHub-hosted verification passed: 34 unit/integration/safety tests, 12 end-to-end tests across Chromium, Firefox, and WebKit, typecheck/lint/build, Worker dry-run, and the 31-PDF integrity matrix (23 PASS, 8 EXPECTED UNSUPPORTED, zero FAIL).
- Fixed accessibility failures found by the new WCAG audit; both empty and populated editor states pass the automated audit.
- After the user updated the scoped token, the hosted account subscription check passed. No billing writes or paid upgrades occurred.
- Cloudflare created the requested Pages project and confirmed its hostname is ai-pdf-editor.pages.dev. The SQLite Worker deployed and GitHub Actions provisioned both production secrets directly over TLS.
- First frontend upload failed because Pages rejects a custom Wrangler config path. Corrected deployment to use the standard root filename only during the ephemeral runner upload. Also corrected the hosted formatting workflow's pnpm script invocation.
- Public frontend and live AI verification remain pending. Status: PARTIALLY COMPLETE.

## 2026-10-14 — Public manual and real AI workflows

- Public deployment at https://ai-pdf-editor.pages.dev is accessible. Hosted Chromium production smoke tests passed all four cases, including actual upload, edit, download, independent PDF.js reopen, original unchanged, undo/reset, negative inputs, sample, responsive layout and automated accessibility audits. Public version matched commit 0a98b9356ba62f5da4f68a16ef7c6e9209a79c1d.
- Production Turnstile verified automatically in the real browser. Groq returned a real Jordan Example → Robin Sample proposal; QA reviewed it, applied it, observed successful text/geometry/pixel export validation, and downloaded the actual synthetic PDF.
- Added that actual downloaded synthetic PDF as reproducible evidence and a separate hosted PDF.js verifier. Independent AI-export verification is pending this run; no mock provider or fake CAPTCHA was used.
- The initial post-upload API check ran before routing propagation; retry succeeded. Added bounded propagation retries checking both enabled API and exact public commit before reporting deployment ready.

## 2026-10-14 — Acceptance evidence and handoff

- Independent hosted PDF.js verification of the real AI export passed (run 38596234860): one page, exact searchable replacement, original target absent, all other extracted text preserved; original and export SHA-256 recorded in docs/evidence/production-ai-verification.json.
- Hosted format/license refresh succeeded (run 38596541920); refreshed dependency inventory and formatted implementation committed by the runner.
- Production manual and real AI acceptance criteria have passed for the explicitly constrained scope. Updated README, test matrix, deployment instructions and production evidence with executed results and real screenshots.
- Status: COMPLETE for the documented MVP scope. The final documentation/source commit still receives the same automatic quality/deployment/public smoke gates; their live results are linked through GitHub Actions. No remaining user credential action is needed.

## 2026-10-14 — Atomic manual batch extension (in progress)

- Added one-snapshot batch preflight, stale target identity, duplicate/overlap rejection, one redaction pass per affected page, and combined structural/glyph/style/all-page pixel validation. Individual disjoint span masks are retained; no enclosing-page acceptance mask.
- Worker commits one validated export for a whole batch. Undo reverses that single history entry. Failures preserve current bytes and source; no React loop of individual Apply calls.
- Added exact glyph-aligned pointer selection, cross-line selection, Ctrl/Cmd-assisted addition, persistent cross-page highlights, per-field replacements/validation/inclusion/removal, clear-all, common replacement and review/apply-all.
- Hosted 44 unit/integration/safety tests pass; the 32-fixture gate is 24 PASS, 8 EXPECTED UNSUPPORTED, zero FAIL. The screenshot-style 9.8 pt Helvetica-Bold invoice-number replacement passes, but the actual screenshot invoice bytes were not supplied and its exact failure is not claimed fixed.
- Expanded real browser tests found Firefox native selection expansion, now resolved from pointer endpoint glyphs, and a numeric option-selector ambiguity in the test, corrected to explicit values.
- Refined only the landing illustration's content to a neutral project brief; preserved tilt, muted green styling and Small changes / Carefully made overlay.
- Status: PARTIALLY COMPLETE for the new requirement until updated compatibility tests and actual production batch export verification pass. No AI/budget/Turnstile dependency or paid-service change was introduced.

## 2026-10-14 — Manual batch production verification
- Hosted 44 unit/integration/safety tests and all 24 Chromium/Firefox/WebKit browser cases passed for release cb70bfd28ef3be27e04ae8bf492d77847c72f53d.
- Real public deployment passed all 8 hosted Chromium smoke cases (run 38603594003), including four non-contiguous replacements, persistent cross-page highlights, one combined export, independent PDF.js verification of every change, unchanged original and one-step undo. Zero /api/plan requests.
- Preserved actual production batch PDF, SHA-256, review/applied screenshots and neutral project-brief landing screenshot under docs/evidence and docs/screenshots.
- Added two extra touching-glyph boundary cases: one safely rejected in preflight; one preserves the neighbor and passes export validation. The original screenshot invoice remains unverified without its PDF bytes. No integrity guard was bypassed and no exact-file fix is claimed.
- Manual batch editing and requested landing polish are released. The invoice-specific diagnosis remains open; the final evidence/test commit is gated by quality, deployment and public smoke checks before handoff.

## 2026-10-14 — Exact public client revision verification
- A later metadata-only deployment exposed stale /version.json responses on the canonical Pages URL, despite Cloudflare's API confirming the correct production deployment and the immutable deployment URL serving the expected manifest. Public API configuration remained enabled.
- Release verification now compares the public root HTML's content-hashed client entry against the exact built artifact, then checks the compiled commit identity in the actual loaded browser application. A stale client still fails; this does not accept an unrelated version or skip functional public tests.
- The version manifest receives no-store and root HTML no-cache headers. Credential-free diagnostic workflows retain only public HTTP/version information; Cloudflare metadata diagnostics print only sanitized deployment status, branch and revision, not secret-bearing bodies.
