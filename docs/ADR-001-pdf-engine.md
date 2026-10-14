# ADR 001 — Constrained real text replacement with MuPDF

Decision date: 2026-10-14. Decision gate: **23 successful edits, 8 expected unsupported, 0 failures across 31 distinct PDFs**. See executable `scripts/prove-engine.ts` and `tests/evidence/results.json`.

## Candidates and evidence

| Engine | Existing content removal | Extraction / geometry | Export | License / outcome |
|---|---|---|---|---|
| [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) / [page API](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFPage.html) | Applied redactions permanently remove page text | Character origins, quads, font, size, color through structured-text walker | PDF object and content-stream API; full rewrite with garbage collection | Installed `mupdf` 1.28.1 is AGPL-3.0-or-later. Selected; combined app AGPL-3.0-only. |
| [PDF.js](https://mozilla.github.io/pdf.js/) / [source](https://github.com/mozilla/pdf.js) | No general arbitrary page-content replacement API | Text items, rendering, selectable text layers | Viewer save facilities are not a general text replacement engine | Apache-2.0. Used independently to reopen and extract exported fixtures and browser downloads. |
| [pdf-lib](https://github.com/Hopding/pdf-lib#limitations) | Its documented API cannot remove/edit text outside form fields | Does not extract arbitrary existing-page text | Good creation, drawing, forms, low-level objects | MIT. Used to generate synthetic fixtures; drawing a rectangle over text does not meet removal requirements. |
| [PDFium C API](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h) | Page object removal and text-object creation exist | C text-page and object APIs | GenerateContent required after object changes | BSD-style core, third-party licenses. Viable future alternative, but a C API is not itself a maintained full browser binding; no additional custom WASM build justified after MuPDF passed the gate. Not benchmarked. |

## Algorithm and measured support

1. Open and reject encrypted/restricted/repaired, oversized, or excessive-page documents.
2. Extract structured character positions and style. Identify exact text and explicitly selected occurrence. NBSP can normalize to ordinary space; no broad fuzzy matching.
3. Verify a uniform horizontal baseline and a standard Helvetica/Times/Courier font, confirmed against the actual page font resource. Embedded/custom/subset fonts are rejected, even when their name resembles a standard font. Reject custom spacing, clipping, transparency and unsupported page structures.
4. Measure replacement glyph advances at the original size. Require it to fit the original area; do not shrink, reflow, or substitute fonts. Reject overlap with neighboring text.
5. Work on a fresh document. Apply text-only redaction without fill rectangles, image deletion, or vector-art removal. Preserve original link annotations.
6. Append real PDF text content using the same standard font, color, size and baseline, with an isolated graphics state. This is **page content, not a FreeText annotation**. The old text has already been removed.
7. Fully rewrite using `garbage=4,compress`; no incremental history containing the old content is retained in the exported file.
8. Reopen the exported bytes. Verify page count, exact replacement in its original region, non-whitespace neighboring glyph positions, non-whitespace glyph counts and link destinations/rectangles.
9. Render **every page** before/after at 108 dpi. Accept zero pixels outside the target rectangle plus a two-pixel antialias margin with channel difference >12. The allowed region is the source span, never an entire page. Failed validation never commits the candidate bytes.
10. Independent PDF.js extraction and original-source byte checks run in the proof of concept and browser download test.

PDF extraction can infer spaces in visual gaps. Neighbor preservation compares real non-whitespace glyph positions with 0.15 pt tolerance; the target region is checked including spaces, and visual comparison covers all surrounding pixels. This avoids misclassifying a changed *inferred* space as missing page content.

## Font and geometry policy

Base-14 font metrics are reproducible; standard PDF font rendering can still differ between independent PDF readers. No font substitution is performed by this editor. Replacements may have more characters if their measured width is smaller. Cyrillic and other Unicode text are readable but view-only; supporting them requires safe original-font reuse, glyph availability, embedding rights and round-trip mapping tests. Full and subset Liberation Sans fixtures demonstrate honest rejection.

MuPDF redaction may remove links intersecting a redacted rectangle. The implementation preserves original link objects, then checks their reopened destinations and geometry. Other annotations and interactive forms are view-only. Tagged PDFs are rejected for editing because a page-content rewrite can invalidate their semantic accessibility tree.

## Runtime and limits

Browser WASM runs inside a dedicated module worker; only the current viewer page is rendered. Explicitly destroy document, page, pixmap, structured-text, font and PDF object wrappers. Rendering is capped at 2× and page size is bounded. Session history stores immutable validated snapshots (maximum 20 edits); undo/reset restore exact bytes. Worker processing is interrupted after 45 seconds. Limits: 15 MB, 80 pages, 15,000 glyphs/page, 100,000 glyphs/document.

This is a constrained text editor, **not a certified redaction/sanitization product**. Old text could also exist in metadata, attachments or unrelated regions. Pixel checks at one raster scale are evidence of preservation, not proof of every PDF feature or printer behavior.

## Interaction references

[Acrobat](https://helpx.adobe.com/acrobat/using/edit-text-pdfs1.html) documents font availability and fallback issues; [PDFgear](https://www.pdfgear.com/windows-user-guide/edit-pdf-text.htm) uses directly selected text blocks. The UI adopts an always-visible document, selectable lines, an explicit inspector, and apply/reject review. It does not copy their claims of broad editability. Minimal workflow, no decorative chat interface.
