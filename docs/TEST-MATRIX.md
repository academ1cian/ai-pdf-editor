# Editing proof of concept — measured fixture matrix

Run `pnpm fixtures` then `pnpm poc`. Fixtures are synthetic and redistributable; they are generated with pdf-lib, with full/subset Liberation Sans from the PDF.js distribution for font-coverage cases. No genuine personal, employee, customer or financial records.

Executed gate: **31 distinct PDFs; 23 PASS; 8 EXPECTED UNSUPPORTED; 0 FAIL.** Repeated copies are not counted as distinct fixtures. Supporting JSON: `tests/evidence/results.json`. Successful edits have reopened bytes, preserved page count, exact replacement/removal within the region, selectable/searchable text checked independently by PDF.js, unaffected glyph geometry, preserved links, and all-page pixel comparisons with zero unexpected pixels beyond the original span plus two-pixel raster margin.

| ID | Scenario | Result |
|---|---|---|
| 01 | Simple English paragraph; word replacement | PASS |
| 02 | Times serif; name replacement | PASS |
| 03 | Courier monospaced code | PASS |
| 04 | 32 pt heading | PASS |
| 05 | 8 pt reference/date | PASS |
| 06 | Bold Helvetica job title | PASS |
| 07 | Italic Times | PASS |
| 08 | Bold italic Helvetica | PASS |
| 09 | Shorter name | PASS |
| 10 | Different-length replacement that fits | PASS |
| 11 | Longer string exceeding original width | EXPECTED UNSUPPORTED — measured overflow |
| 12 | Identical names; second occurrence selected | PASS — first preserved |
| 13 | Two pages; second-page edit | PASS — both pages checked |
| 14 | Resume layout | PASS |
| 15 | Invoice layout | PASS |
| 16 | Table with rules and monospaced text | PASS |
| 17 | Mixed text/vector graphics | PASS |
| 18 | Text close to another span | PASS — neighbors preserved |
| 19 | Colored background | PASS — no white rectangle |
| 20 | Hyperlink intersecting edit | PASS — destination/geometry preserved |
| 21 | Colored text | PASS |
| 22 | Rotated text | EXPECTED UNSUPPORTED |
| 23 | Image/vector-only scan analogue | EXPECTED UNSUPPORTED — no selectable target; no OCR claim |
| 24 | Interactive form field | EXPECTED UNSUPPORTED |
| 25 | Target crosses font-style boundary | EXPECTED UNSUPPORTED |
| 26 | Text near bottom page edge | PASS |
| 27 | Empty replacement/deletion | PASS |
| 28 | Tightly separated paragraph lines | PASS |
| 29 | Fully embedded Liberation Sans | EXPECTED UNSUPPORTED — no font substitution |
| 30 | Subset Liberation Sans | EXPECTED UNSUPPORTED — no font substitution |
| 31 | Russian/Cyrillic text | EXPECTED UNSUPPORTED — Unicode editing not supported |

The scan analogue tests absence of selectable text; it is not counted as a photographic scan/OCR benchmark. Full arbitrary embedded-font support is not implied by successful standard-font cases.

## Additional automated checks

Executed GitHub-hosted Vitest suite: **34 tests, all pass**. Coverage includes exact/missing/ambiguous targets, normalization, forged rectangles/stale references, repeated edits/undo/reset/source immutability, unsupported fonts, overflow, real encrypted PDFs, corruption/type/size limits, Unicode/newline rejection, opacity/overlap/clipping, a 20-page document, validation evidence, strict AI schemas, allowed origins, Turnstile host/action, persistent budget decisions, provider/network/malformed-output errors, resolved proposals, subscription-plan rejection and secret-provisioning isolation.

Executed GitHub-hosted browser suite: **12 tests, all pass** across Chromium, Firefox and WebKit (four each). Upload → render → manual review → apply → download → independent PDF.js extraction → unchanged original → undo/reset; invalid files/mobile layout; duplicate selection/overflow/scan handling; sample workflow; WCAG2 A/AA audits and keyboard privacy-dialog dismissal. Both production JS and WASM are exercised.

Actual public HTTPS deployment: **4 Chromium smoke cases, all pass**, with exact commit verification. Real browser Turnstile and Groq returned the requested synthetic name replacement. The actual downloaded AI export independently passed PDF.js comparison on a hosted runner. Mocked API unit tests are separate from this real provider evidence. See [production verification](PRODUCTION-VERIFICATION.md) for run links, hashes, provenance and console observations.
