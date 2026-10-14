# Focused usability upgrade

The previous fitting preflight limited text to its exact original width. The AI request contained only the first 50 current-page lines without geometry or field associations. Budget reservations used UTF-8 bytes and never reconciled provider usage; all clients sharing an IP had six daily requests.

## Implemented
- Preserve font and baseline first. Expand into at most 36 pt of adjacent whitespace, bounded by unrelated glyphs, vector segments, images and page edges. Recognized whole numeric columns retain their right edge. If necessary, reduce size by at most 5%, explicitly shown in review. No neighboring elements move.
- Actual PDF redaction and insertion remain atomic. Verify expected new positions/sizes, all unaffected glyphs, page features, and pixels outside each original/new region.
- Compact context contains page/block IDs, positions, order and inferred row/column label/value associations. Choose relevant lines across pages within a small payload. The UI previews exactly what is sent. Layout hints can be incomplete.
- Reject numeric instructions that target headings or unresolved fields. Clarify uncertain intent instead of queuing random replacements. Stage coherent AI plans in the existing manual batch.
- Fixed-point decimal arithmetic verifies original rate × quantity or sum-of-charges relationships, then substitutes approved proposed source values. Aggregate totals require complete context. Show calculations for approval. Unsupported relationships ask for clarification.
- Default application caps: 80 requests / 100,000 tokens daily globally; 30 requests daily and 4/minute per browser session; shared-network aggregate 60/day and 12/minute. Day-salted hashes store no raw IP or document content. A browser session ID is not an identity; network/global limits remain authoritative.
- Conservative UTF-8 token reservations are reconciled with provider total usage, including reasoning. Confirmed provider rejections refund tokens/day counts; minute abuse attempts remain counted. Uncertain network failures retain the reservation. Errors distinguish app/session/network caps and provider throttles, with retry/reset guidance.
- No paid services enabled. Groq documents 1,000 requests/day, 8,000 tokens/minute and 200,000 tokens/day for both tested models; actual response headers confirmed 1,000 RPD / 8,000 TPM. Account-specific allowances may differ.

## Unsupported
Controlled local reflow, moving neighbors, custom/embedded fonts, OCR and complex protected PDF structures remain unsupported. Financial relationships involving discounts, taxes, missing pages, multiple totals or ambiguous row membership may require manual edits or clarification. The exact previously reported customer invoice cannot be verified without its sanitized PDF bytes.

## Verification
Focused regressions cover dense invoice numeric replacement/right alignment, marginal width expansion and bounded type reduction, unsafe header targeting, deterministic totals, atomic batch/one-step undo, actual-usage accounting/refunds, independent PDF.js extraction and neighboring content/pixel preservation. Hosted workflows run existing browser compatibility tests as well.
A small real Groq benchmark compares 20B and 120B on synthetic resume, ambiguous invoice and explicit financial instructions. These are limited observations, not a claim of professional-grade document understanding.
