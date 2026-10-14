# Manual multi-selection and atomic batch edits

The manual queue uses no AI provider, quota or Turnstile verification.

## Workflow
1. Find exact text or drag over characters on the page. Dragging can span several lines; each original line retains its own replacement and baseline.
2. Choose **Add to changes**, or Ctrl/Cmd-click a line to add it directly. Keep adding unrelated spans on any page. Queued spans remain highlighted when returning to a page.
3. Edit each replacement. Optionally assign one replacement to all included changes. Exclude or remove individual items, or clear the queue.
4. **Review all changes** checks every included item and identifies unsupported/overlapping/stale fields.
5. **Apply all changes** validates one combined PDF and commits one history entry. A single Undo restores the document before that entire batch. Reset restores original bytes.
6. Download is enabled only after successful export validation and while no queued changes remain.

A batch supports up to 40 changes. Adding a selection that would exceed the limit adds nothing. Duplicate selections are identified. Conflicting spans are rejected. Each replacement must fit its original span; fonts, sizes, colors, baselines and line breaks are preserved. This is multi-selection, not paragraph reflow. Existing unsupported fonts/forms/scans and other document safety boundaries still apply.

## Transaction and validation
Targets carry snapshot identity and exact page/line/character ranges. Geometry is recomputed from original glyphs instead of trusting UI rectangles. Preflight resolves all operations against the same immutable source. All redactions on a page are applied together before inserting any replacements, avoiding resolution against rewritten extraction order.

The combined export is saved and reopened once. Every actual unaffected glyph across every page is checked as a multiset of text, font, position, size and color. Replacement glyphs and target-region text are independently resolved in the reopened model. Original targets cannot remain as unmatched text. All pages retain features/links and are pixel-compared at 108 dpi, allowing changes only inside the individual span masks plus the documented two-pixel antialiasing margin. The permitted region is never expanded to a bounding rectangle enclosing distant selections.

Only a fully validated export is passed to History.commit. Preflight, mutation, validation or history-limit failure leaves the worker's prior snapshot intact. React sends one applyBatch request; it does not loop over the single-edit Apply operation.

## Regression evidence
Hosted unit/integration tests cover three distant edits on one page; edits across three pages; repeated text; partial/adjacent spans; different replacement lengths; nearby invoice table fields; invalid-item rollback; duplicate/overlap/stale references; one-step undo/reset; independent PDF.js extraction; unchanged source; and all-page visual preservation.

The synthetic dense invoice includes the reported Helvetica-Bold 9.8 pt field geometry. Its shorter numeric replacement passes. **The actual screenshot invoice bytes were not provided; its exact “neighboring text changed” failure is not claimed resolved.** Screenshots cannot reveal the original content streams, fonts or redaction behavior. Failures still block export rather than bypassing integrity checks.

Real browser tests additionally exercise pointer drag across partial lines, persistent cross-page highlights, common replacements, exclusion/removal, review/apply, exported PDF.js text checks and one-step undo/reset. They assert no /api/plan request is made. Production verification remains required before this extension is marked released.

Firefox expanded native ranges unexpectedly for absolutely positioned text. The editor therefore resolves actual pointer endpoints against glyph spans and shows the exact resulting selections, with explicit Add to changes as the portable workflow.
