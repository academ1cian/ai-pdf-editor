# AI PDF Editor

Iterative text, layout and image corrections with one real PDF preview and approval. Follow-up requests refine the current proposal; manual changes and exact local logo lettering work without a provider.

[Open the editor](https://ai-pdf-editor.pages.dev). See [the current workflow, validation and limits](docs/ITERATIVE-EDITING.md), plus [numeric operand internals](docs/OPERAND-EDITING.md). Release identity is available at `/version.json`; historical evidence below describes the earlier release.

![Actual editor after a validated edit](docs/screenshots/editor.png)

## Iterative editing

Coordinated invoice requests in English, Russian, or mixed accounting terminology can be interpreted locally when one main rate/charge pair and a reconciled payable total are identifiable. Separate fees are preserved and arithmetic is deterministic. No cloud consent or provider allowance is needed for that narrow path. Opting in to Groq uses the protected cloud planner for broader requests.

Upload a supported PDF, describe coordinated changes, inspect the actual candidate, and add or correct requests without losing the earlier edits. Edit a previous request to replace it and invalidate dependent later turns. One approval downloads the entire pending transaction; one document Undo restores its base. The worker validates a temporary copy without changing history; “Apply & Download” commits and downloads those same bytes as one Undo transaction. Compare original/edited views and inspect highlighted changes. Manual Find & Replace and batch selection remain available in the secondary tab.

The recovery acceptance fixture is a three-page synthetic logistics invoice with weight, units, primary freight, a separate unloading fee, shipment information, and a total on another page. The one-sentence instruction is “Change the rate and charges to 1000 and update the total accordingly.” Financial source identities and original arithmetic are verified before calculating new totals. Complete relevant monetary context is required; ambiguous or unverified relationships are not silently guessed.

Current model comparison: 120B passed the exact invoice and repeated-date multi-edit scenarios; 20B passed the invoice but missed two repeated dates. Runtime integrity checks remain independent of model output.

## What works

- PDF upload/drop, multi-page navigation, zoom, fit-to-width, selectable text lines and exact find.
- Exact partial-text and multi-line drag selection, Ctrl/Cmd-assisted addition, and persistent non-contiguous selections across pages.
- Compact batch queue with individual replacements/inclusion/removal, a common replacement action, review/apply-all, and one-step undo for the entire atomic batch.
- Explicit occurrence selection when text appears multiple times.
- Review source/replacement, page/position, font/size, measured fit and rejection reasons.
- Original compatible numeric operand replacement, with applied redaction and insertion as a validated fallback for other supported spans. No rectangle covering old text and no annotation-only mock edits.
- Export validation: reopen, page count, exact changed-region text, neighboring glyph positions, hyperlinks and all-page pixel comparison.
- Immutable original, validated snapshots, undo, reset, change history and genuinely modified downloads.
- Optional AI proposals through a protected Groq Worker; real production integration verified. Manual editing works independently of AI availability.

## Honest support boundaries

Text editing preserves original operands where compatible, measures whitespace in both directions, wraps complete text and can move connected paragraph lines coherently. When original font reuse is unavailable, supported replacements use embedded Noto Sans with appropriate emphasis, including Cyrillic. Images support per-occurrence upload/replacement/removal and bounded movement, while exact logo wording is reconstructed locally on uniform backgrounds. See [detailed support and validation boundaries](docs/ITERATIVE-EDITING.md).

Forms/signatures, encrypted/restricted/repaired files, complex semantic trees, rotated/clipped text, arbitrary table reconstruction, difficult overlaps and pagination may be unsupported. Image-only pages use image tools rather than selectable-text editing. Upload limits: 15 MB, 80 pages, bounded page dimensions and text counts. History: 20 transactions or 80 MB; up to 40 text changes and 20 image changes per transaction. Unsupported follow-ups preserve the last validated preview.

Validation at 108 dpi is evidence, not a guarantee of every printer, viewer or PDF feature. This editor is **not a certified document sanitization product**: content could also exist in metadata, attachments or other locations.

## Measured editing gate

**32 distinct synthetic PDFs investigated: 28 PASS, 4 EXPECTED UNSUPPORTED, 0 FAIL.** Fixtures cover English, Cyrillic, standard/embedded/subset fonts, font styles/sizes, longer/shorter strings, duplicates, multiple pages, resumes, invoices, tables, vectors, nearby text, colors, hyperlinks and difficult cases. They contain no real private information.

Every successful proof-of-concept export reopened with independent PDF.js extraction. Every affected and unaffected page was raster-compared at 108 dpi; zero unexpected pixels outside each original/new text region plus a two-pixel antialias margin. The original input remained unchanged. See [engine decision](docs/ADR-001-pdf-engine.md), [test matrix](docs/TEST-MATRIX.md) and [machine-readable evidence](tests/evidence/results.json).

The hosted quality gate runs unit/integration/safety checks, the 32-PDF proof, typecheck/lint/build, Worker compilation and complete browser workflows across Chromium, Firefox and WebKit. New cases cover accumulated requests, earlier-request edits, failed/rate-limited follow-ups, image uploads, sanitized SVG and exact local wordmarks. Real downloads are reopened independently and compared with the preview SHA-256. Live Groq/Workers AI evidence is kept separate from mocked failure tests. Private acceptance evidence remains local and ignored.

## Architecture

```mermaid
flowchart LR
    PDF[Local PDF] --> W[Browser Web Worker]
    W --> M[Structured document model]
    M --> R[Explicit target and proposal review]
    R --> E[Compatible operand editing / validated fallback]
    E --> V[Reopen + structural + pixel validation]
    V --> D[Validated PDF download]
    M -.consented relevant text and layout.-> API[Cloudflare Pages API binding]
    API --> P[Worker: request + Turnstile checks]
    P --> B[SQLite Durable Object budget]
    B --> G[Groq strict structured proposal]
    G --> R
```

The reusable engine (`src/engine`) is independent of React. It separates extraction/modeling, targeting/geometry, mutation, validation, worker transport and history. MuPDF was selected after measuring real removal and insertion; PDF.js independently verifies exports. pdf-lib generates fixtures. AI never edits PDF bytes or declares an edit successful.

## AI and privacy

Groq `openai/gpt-oss-120b` was selected after the focused synthetic comparison (3/3 cases versus 1/3 for 20B); it supports strict JSON-schema outputs as verified on 2026-10-14. The selected ID is configurable from a documented allowlist. Zod validates both incoming context and proposed edits; the proxy resolves references against actual supplied blocks and the client re-resolves targets before deterministic layout checks.

Only consented relevant extracted text, positions, page/block references and label/value hints go to Groq (up to 50 lines in a compact payload, with an exact preview before sending). Context may include other pages. PDFs are never uploaded/stored. No content logging or analytics. Turnstile verification requires the actual hostname/action; origin, payload and output limits fail closed. When `AI_APP_LIMITS_ENABLED=true`, SQLite Durable Object caps are 80 requests / 100,000 tokens per UTC day globally, 30/day and 4/minute per browser session, and 60/day and 12/minute per shared network. Reservations reconcile actual provider usage; confirmed provider rejections refund tokens/day counts, while uncertain network failures retain their reservation. With `AI_APP_LIMITS_ENABLED=false`, authenticated owner requests bypass the quota store and all these checks; historical counters cannot block testing. Day-salted hashes store no raw IP or document text. Financial arithmetic uses verified fixed-point relationships, and ambiguous instructions ask for clarification before any edits. See [focused changes and limitations](docs/FOCUSED-UPGRADE.md).

## Development and remote verification

On a development machine or GitHub Codespace with Node 24 and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm fixtures
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm poc
pnpm build
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
```

**No local tool installation is needed for the owner.** GitHub-hosted Ubuntu runners execute CI and browser compatibility tests. The repository deployment workflow builds separately from secret provisioning; Groq credentials never enter Vite's environment or frontend artifacts.

## Deploy with repository secrets

Use [GitHub repository secrets](https://github.com/academ1cian/ai-pdf-editor/settings/secrets/actions), entered directly in the browser:

| Secret                  | Purpose                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `GROQ_API_KEY_BACKUP`   | Optional standby credential; only HTTP 401 failover, never organization-quota rotation                 |
| `GROQ_API_KEY`          | Groq Free provider key; only Worker provisioning and the bounded hosted synthetic benchmark receive it |
| `CLOUDFLARE_API_TOKEN`  | Scoped Pages/Worker deployment and read-only plan verification                                         |
| `CLOUDFLARE_ACCOUNT_ID` | Chosen Cloudflare account                                                                              |
| `TURNSTILE_SECRET`      | Server verification secret for the real widget                                                         |

Optional bounded allowance variables are documented in [iterative editing](docs/ITERATIVE-EDITING.md). Image AI uses the existing Worker binding and a separate consent/budget; no additional API key is required.

Public repository variables: `TURNSTILE_SITE_KEY`, `CF_FREE_PLAN_CONFIRMED=true` after verifying both providers are Free, and `DEPLOY_ENABLED=true` when ready. Deployed Pages project: `ai-pdf-editor`; verified production hostname: [`ai-pdf-editor.pages.dev`](https://ai-pdf-editor.pages.dev). Authenticated project creation checks the returned hostname and stops on a collision.

Read [deployment instructions and minimum authorization](docs/DEPLOYMENT.md). Deployment sends secret values directly over TLS to Cloudflare's Worker Secret API; no secret-valued shell arguments, temporary files, uploaded artifacts or log output. It checks the account's subscriptions read-only and refuses paid/unrecognized account plans. No billing/subscription writes are implemented. Forked PRs cannot deploy. Production smoke testing runs in a separate job without deployment/provider credentials.

## License and reuse

Combined application: **AGPL-3.0-only**, with [full license](LICENSE) and [dependency inventory](docs/DEPENDENCY-LICENSES.md). MuPDF is AGPL-3.0-or-later, not MIT. Proprietary reuse of this combined engine requires replacing MuPDF or obtaining appropriate commercial licensing from Artifex. Preserve upstream notices and provide corresponding source when distributing or hosting modified versions. Self-hosted UI fonts use SIL OFL-1.1.

## Known invoice-specific investigation

The screenshot invoice produced “Validation failed: neighboring text changed.” A synthetic invoice using matching 9.8 pt standard-font geometry passes, and nearby-field/transaction regressions are covered. The original PDF bytes were not provided, so its exact failure is **not claimed fixed**. Integrity failures continue to block export and preserve the previous valid snapshot. A sanitized reproducing PDF is needed to finish that specific diagnosis.

## Next improvements

1. Extend font reuse only after embedded glyph mapping and embedding-right checks pass new fixtures.
2. Add independent render comparisons at multiple scales and larger legitimate redistributable corpora.
3. Add deeper PDF feature validation and broader document support without weakening rejection rules.

Execution state and outstanding work: [progress log](docs/PROGRESS.md).

## Owner development/testing

The current deployment uses `AI_APP_LIMITS_ENABLED=false` behind owner authentication. Application quotas, reservations and the estimated 7500-token gate are bypassed; real provider limits still apply. Select your local owner key file in the website to enable cloud testing. Local requests remain local even with cloud consent checked. Provider429 retries are bounded, cancellable and refresh verification. See [owner testing setup and security](docs/OWNER-TESTING.md).
