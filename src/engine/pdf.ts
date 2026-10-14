import * as mupdf from 'mupdf';
import {
  findTargets,
  normalize,
  overlaps,
  type DocumentModel,
  type EditResult,
  type Glyph,
  type Line,
  type Operation,
  type PageModel,
  type Proposal,
  type Rect,
  type Target,
} from './model';

export const MAX_BYTES = 15 * 1024 * 1024;
export const STANDARD_FONTS = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
]);
class Arena {
  private objects: { destroy(): void }[] = [];
  own<T extends { destroy(): void }>(object: T): T {
    this.objects.push(object);
    return object;
  }
  close() {
    for (const object of this.objects.reverse()) object.destroy();
  }
}
export function openPDF(bytes: Uint8Array): mupdf.PDFDocument {
  if (bytes.length > MAX_BYTES) throw new Error('Choose a PDF smaller than 15 MB.');
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-')
    throw new Error('This file is not a PDF.');
  let doc: mupdf.PDFDocument;
  try {
    doc = new mupdf.PDFDocument(bytes);
  } catch {
    throw new Error('This PDF is damaged or could not be opened.');
  }
  try {
    if (doc.needsPassword() || !doc.hasPermission('edit'))
      throw new Error('Password-protected or editing-restricted PDFs are not supported.');
    const arena = new Arena();
    try {
      if (!arena.own(arena.own(doc.getTrailer()).get('Encrypt')).isNull())
        throw new Error('Encrypted PDFs are not supported.');
    } finally {
      arena.close();
    }
    if (doc.wasRepaired())
      throw new Error('This PDF needs repair. Export a fresh PDF before editing.');
    if (doc.countPages() < 1 || doc.countPages() > 80)
      throw new Error('Choose a document with 1 to 80 pages.');
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

function documentWarnings(doc: mupdf.PDFDocument): string[] {
  const a = new Arena();
  const warnings: string[] = [];
  try {
    const root = a.own(a.own(doc.getTrailer()).get('Root'));
    if (!a.own(root.get('AcroForm')).isNull())
      warnings.push(
        'Interactive forms and signatures are not supported. Export a flat copy first.',
      );
    const names = a.own(root.get('Names'));
    if (
      (!names.isNull() && !a.own(names.get('JavaScript')).isNull()) ||
      !a.own(root.get('OpenAction')).isNull() ||
      !a.own(root.get('AA')).isNull()
    )
      warnings.push('Documents with automatic actions are not supported.');
    if (!a.own(root.get('StructTreeRoot')).isNull())
      warnings.push(
        'Tagged PDFs are view-only: preserving their accessibility structure is not yet supported.',
      );
    return warnings;
  } finally {
    a.close();
  }
}

function extractPage(page: mupdf.PDFPage, index: number): PageModel {
  const lines: Line[] = [];
  let current: Line;
  const warnings: string[] = [];
  const bounds = page.getBounds();
  if (
    bounds[2] - bounds[0] > 1440 ||
    bounds[3] - bounds[1] > 1440 ||
    (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) > 1_500_000
  )
    throw new Error('A page is too large to process safely.');
  const st = page.toStructuredText('preserve-whitespace,preserve-spans');
  try {
    st.walk({
      beginLine: (rect, wmode, direction) => {
        current = { id: `p${index}l${lines.length}`, text: '', rect, direction, glyphs: [] };
        lines.push(current);
        if (wmode) warnings.push('Vertical text is not supported.');
      },
      onChar: (text, origin, font, size, quad, color) => {
        try {
          current.text += text;
          current.glyphs.push({
            text,
            origin,
            font: font.getName(),
            size,
            rect: [
              Math.min(quad[0], quad[2], quad[4], quad[6]),
              Math.min(quad[1], quad[3], quad[5], quad[7]),
              Math.max(quad[0], quad[2], quad[4], quad[6]),
              Math.max(quad[1], quad[3], quad[5], quad[7]),
            ],
            color,
          });
        } finally {
          font.destroy();
        }
      },
    });
  } finally {
    st.destroy();
  }
  if (lines.reduce((n, l) => n + l.glyphs.length, 0) > 15000)
    throw new Error('A page contains too much text to process safely.');
  return { index, bounds, lines, warnings: [...new Set(warnings)] };
}
function extract(doc: mupdf.PDFDocument): DocumentModel {
  const model: DocumentModel = { pages: [], warnings: documentWarnings(doc) };
  let total = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      const p = extractPage(page, i);
      total += p.lines.reduce((n, l) => n + l.text.length, 0);
      if (total > 100000)
        throw new Error('This document contains too much text. Split it into smaller PDFs.');
      model.pages.push(p);
    } finally {
      page.destroy();
    }
  }
  if (!total)
    model.warnings.push('No selectable text found. Scanned PDFs need OCR before editing.');
  return model;
}
export function inspectPDF(bytes: Uint8Array): DocumentModel {
  const doc = openPDF(bytes);
  try {
    return extract(doc);
  } finally {
    doc.destroy();
  }
}

function resolve(
  model: DocumentModel,
  target: Target,
): { line: Line; glyphs: Glyph[]; target: Target } {
  const actual = findTargets(model, target.original).find(
    (t) =>
      t.id === target.id &&
      t.page === target.page &&
      t.line === target.line &&
      t.start === target.start &&
      t.end === target.end,
  );
  if (!actual) throw new Error('The selected text changed. Find it again before applying.');
  const line = model.pages[actual.page].lines.find((l) => l.id === actual.line)!;
  return { line, glyphs: line.glyphs.slice(actual.start, actual.end), target: actual };
}
function auditPage(page: mupdf.PDFPage): string | undefined {
  let issue: string | undefined;
  const dev = new mupdf.Device({
    fillText: (_t, _m, cs, _c, alpha) => {
      if (alpha !== 1 || !['Gray', 'RGB'].includes(cs.getType()))
        issue = 'Transparent text or special text colors are not supported.';
    },
    strokeText: () => {
      issue = 'Outlined text is not supported.';
    },
    ignoreText: () => {
      issue = 'Hidden text is not supported.';
    },
    clipText: () => {
      issue = 'Text clipping is not supported.';
    },
    clipStrokeText: () => {
      issue = 'Text clipping is not supported.';
    },
    clipPath: () => {
      issue = 'Pages with clipping paths are view-only.';
    },
    clipStrokePath: () => {
      issue = 'Pages with clipping paths are view-only.';
    },
    beginMask: () => {
      issue = 'Pages with transparency masks are view-only.';
    },
    beginGroup: () => {
      issue = 'Pages with transparency groups are view-only.';
    },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
  } finally {
    dev.close();
    dev.destroy();
  }
  return issue;
}
function check(doc: mupdf.PDFDocument, model: DocumentModel, op: Operation): Proposal {
  let proposal: Proposal = { ...op, status: 'UNSUPPORTED', message: '' };
  try {
    if (model.warnings.length) throw new Error(model.warnings[0]);
    if (op.replacement.length > 500 || /[^\x20-\x7e]/.test(op.replacement))
      throw new Error(
        'Replacement text must use printable Latin ASCII characters. Unicode fonts are not yet supported.',
      );
    if (op.replacement === op.target.original) throw new Error('Enter different replacement text.');
    const { line, glyphs, target } = resolve(model, op.target);
    proposal = { ...proposal, target };
    const first = glyphs[0];
    const pageModel = model.pages[target.page];
    if (!first || !STANDARD_FONTS.has(first.font))
      throw new Error(
        'This embedded, subset, or custom font is view-only. This version edits standard PDF fonts without substitution.',
      );
    if (Math.abs(line.direction[0] - 1) > 0.001 || Math.abs(line.direction[1]) > 0.001)
      throw new Error('Rotated or skewed text is view-only.');
    if (
      glyphs.some(
        (g) =>
          g.font !== first.font ||
          Math.abs(g.size - first.size) > 0.01 ||
          Math.abs(g.origin[1] - first.origin[1]) > 0.05 ||
          JSON.stringify(g.color) !== JSON.stringify(first.color),
      )
    )
      throw new Error('Select text with one font, size, color, and baseline.');
    const page = doc.loadPage(target.page);
    const a = new Arena();
    try {
      const transform = page.getTransform();
      if (
        Math.abs(transform[0] - 1) > 0.001 ||
        Math.abs(transform[1]) > 0.001 ||
        Math.abs(transform[2]) > 0.001 ||
        Math.abs(transform[3] + 1) > 0.001
      )
        throw new Error('Rotated pages or nonstandard page units are view-only.');
      const issue = auditPage(page);
      if (issue) throw new Error(issue);
      const annots = page.getAnnotations();
      try {
        if (annots.some((an) => an.getType() !== 'Link'))
          throw new Error('Pages with comments or existing redactions are view-only.');
      } finally {
        annots.forEach((an) => an.destroy());
      }
      const fonts = a.own(a.own(a.own(page.getObject()).getInheritable('Resources')).get('Font'));
      let verified = false;
      fonts.forEach((f) => {
        a.own(f);
        const base = a.own(f.get('BaseFont')).asName();
        if (base === first.font && a.own(f.get('FontDescriptor')).isNull()) verified = true;
      });
      if (!verified)
        throw new Error(
          'The original standard font could not be verified. No substitute will be used.',
        );
      const font = a.own(new mupdf.Font(first.font));
      let width = 0;
      for (const char of op.replacement) {
        const gid = font.encodeCharacter(char);
        if (!gid) throw new Error('The original font does not contain a replacement character.');
        width += font.advanceGlyph(gid) * first.size;
      }
      // Reject custom character spacing/scaling; preserving baseline alone is insufficient.
      for (let i = 0; i < glyphs.length - 1; i++) {
        const advance = font.advanceGlyph(font.encodeCharacter(glyphs[i].text)) * first.size;
        if (Math.abs(glyphs[i + 1].origin[0] - glyphs[i].origin[0] - advance) > 0.15)
          throw new Error('Custom text spacing is not supported.');
      }
      const allowedWidth = target.rect[2] - first.origin[0];
      proposal = { ...proposal, font: first.font, size: first.size, width, allowedWidth };
      if (width > allowedWidth + 0.1)
        throw new Error(
          `Replacement needs ${width.toFixed(1)} pt; only ${allowedWidth.toFixed(1)} pt is available. Use shorter wording.`,
        );
      if (
        target.rect[0] < pageModel.bounds[0] ||
        target.rect[1] < pageModel.bounds[1] ||
        target.rect[2] > pageModel.bounds[2] ||
        target.rect[3] > pageModel.bounds[3]
      )
        throw new Error('This text crosses the page edge.');
      for (const l of pageModel.lines)
        for (let i = 0; i < l.glyphs.length; i++) {
          if (l.id === line.id && i >= target.start && i < target.end) continue;
          if (overlaps(target.rect, l.glyphs[i].rect))
            throw new Error('The selected text overlaps neighboring text.');
        }
      return {
        ...proposal,
        status: 'SAFE_TO_APPLY',
        message:
          'Fits the original text area. Same font, size, baseline, and color. Export will be checked before it becomes available.',
      };
    } finally {
      a.close();
      page.destroy();
    }
  } catch (error) {
    return {
      ...proposal,
      message: error instanceof Error ? error.message : 'This edit is unsupported.',
    };
  }
}
export function proposePDF(bytes: Uint8Array, op: Operation): Proposal {
  const doc = openPDF(bytes);
  try {
    return check(doc, extract(doc), op);
  } finally {
    doc.destroy();
  }
}

export function renderPDF(
  bytes: Uint8Array,
  pageIndex: number,
  scale = 1.25,
): { png: Uint8Array; width: number; height: number } {
  const doc = openPDF(bytes);
  try {
    const page = doc.loadPage(pageIndex);
    try {
      extractPage(page, pageIndex);
      const safeScale = Math.max(0.25, Math.min(2, scale));
      const pix = page.toPixmap(
        mupdf.Matrix.scale(safeScale, safeScale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        return { png: pix.asPNG().slice(), width: pix.getWidth(), height: pix.getHeight() };
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}
function pixels(page: mupdf.PDFPage) {
  const p = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    return {
      data: p.getPixels().slice(),
      width: p.getWidth(),
      height: p.getHeight(),
      n: p.getNumberOfComponents(),
    };
  } finally {
    p.destroy();
  }
}
function compare(before: mupdf.PDFPage, after: mupdf.PDFPage, allowed?: Rect) {
  const a = pixels(before),
    b = pixels(after);
  if (a.width !== b.width || a.height !== b.height || a.n !== b.n)
    throw new Error('Rendered page dimensions changed.');
  let outside = 0,
    changed = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      let delta = 0;
      for (let c = 0; c < a.n; c++) {
        const i = (y * a.width + x) * a.n + c;
        delta = Math.max(delta, Math.abs(a.data[i] - b.data[i]));
      }
      if (delta > 12) {
        changed++;
        if (
          !allowed ||
          x < Math.floor(allowed[0] * 1.5) - 2 ||
          x > Math.ceil(allowed[2] * 1.5) + 2 ||
          y < Math.floor(allowed[1] * 1.5) - 2 ||
          y > Math.ceil(allowed[3] * 1.5) + 2
        )
          outside++;
      }
    }
  return { outside, changed };
}
function features(page: mupdf.PDFPage): string {
  const a = new Arena();
  try {
    const obj = a.own(page.getObject());
    const links = page.getLinks();
    try {
      return JSON.stringify({
        bounds: page.getBounds(),
        links: links.map((l) => ({ uri: l.getURI(), rect: l.getBounds() })),
        rotate: a.own(obj.getInheritable('Rotate')).asJS(),
      });
    } finally {
      links.forEach((l) => l.destroy());
    }
  } finally {
    a.close();
  }
}
function bucketKey(g: Glyph, x = Math.floor(g.origin[0]), y = Math.floor(g.origin[1])) {
  return `${g.text}|${g.font}|${x}|${y}`;
}
export function applyPDF(bytes: Uint8Array, op: Operation): EditResult {
  const doc = openPDF(bytes);
  const arena = new Arena();
  let reopened: mupdf.PDFDocument | undefined;
  try {
    const model = extract(doc);
    const proposal = check(doc, model, op);
    if (proposal.status !== 'SAFE_TO_APPLY') throw new Error(proposal.message);
    const { target, glyphs } = resolve(model, proposal.target);
    const first = glyphs[0];
    const beforeFeatures: string[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const p = doc.loadPage(i);
      try {
        beforeFeatures.push(features(p));
      } finally {
        p.destroy();
      }
    }
    const page = arena.own(doc.loadPage(target.page));
    const pageObject = arena.own(page.getObject());
    const annotations = arena.own(pageObject.get('Annots'));
    const preservedAnnotations = arena.own(doc.newArray());
    if (!annotations.isNull())
      annotations.forEach((an) => {
        arena.own(an);
        preservedAnnotations.push(an);
      });
    const redact = arena.own(page.createAnnotation('Redact'));
    redact.setRect([
      target.rect[0] + 0.1,
      target.rect[1] + 0.1,
      target.rect[2] - 0.1,
      target.rect[3] - 0.1,
    ]);
    redact.update();
    page.applyRedactions(
      false,
      mupdf.PDFPage.REDACT_IMAGE_NONE,
      mupdf.PDFPage.REDACT_LINE_ART_NONE,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );
    if (!annotations.isNull()) pageObject.put('Annots', preservedAnnotations);
    const obj = arena.own(page.getObject());
    const oldResources = arena.own(obj.getInheritable('Resources'));
    const resources = arena.own(doc.newDictionary());
    oldResources.forEach((v, k) => {
      arena.own(v);
      resources.put(k, v);
    });
    const oldFonts = arena.own(oldResources.get('Font'));
    const fonts = arena.own(doc.newDictionary());
    oldFonts.forEach((v, k) => {
      arena.own(v);
      fonts.put(k, v);
    });
    let fontKey = 'EditorFont';
    let suffix = 0;
    while (!arena.own(fonts.get(fontKey)).isNull()) fontKey = `EditorFont${++suffix}`;
    fonts.put(fontKey, arena.own(doc.addSimpleFont(arena.own(new mupdf.Font(first.font)))));
    resources.put('Font', fonts);
    obj.put('Resources', resources);
    const oldContents = arena.own(obj.get('Contents'));
    const contents = arena.own(doc.newArray());
    contents.push(arena.own(doc.addStream('q\n', {})));
    if (oldContents.isArray())
      oldContents.forEach((v) => {
        arena.own(v);
        contents.push(v);
      });
    else if (!oldContents.isNull()) contents.push(oldContents);
    // Reset all inherited graphics state before inserting actual page text (not an annotation).
    const matrix = mupdf.Matrix.invert(page.getTransform());
    const x = first.origin[0] * matrix[0] + first.origin[1] * matrix[2] + matrix[4];
    const y = first.origin[0] * matrix[1] + first.origin[1] * matrix[3] + matrix[5];
    const escaped = op.replacement.replace(/[\\()]/g, '\\$&');
    const stream = `\nQ\nq\nBT /${fontKey} ${first.size} Tf ${first.color.join(' ')} rg 1 0 0 1 ${x} ${y} Tm (${escaped}) Tj ET\nQ\n`;
    contents.push(arena.own(doc.addStream(stream, {})));
    obj.put('Contents', contents);
    const buffer = arena.own(doc.saveToBuffer('garbage=4,compress'));
    const output = buffer.asUint8Array().slice();
    reopened = openPDF(output);
    const after = extract(reopened);
    if (after.pages.length !== model.pages.length)
      throw new Error('Validation failed: page count changed.');
    const allBefore = model.pages[target.page].lines.flatMap((l) => l.glyphs);
    const selected = new Set(glyphs);
    // PDF extraction may infer spaces in gaps. Preserve actual non-whitespace glyphs and all surrounding pixels.
    const unaffected = allBefore.filter((g) => !selected.has(g) && g.text.trim());
    const afterGlyphs = after.pages[target.page].lines.flatMap((l) => l.glyphs);
    const bag = new Map<string, Glyph[]>();
    for (const g of afterGlyphs) {
      const key = bucketKey(g);
      bag.set(key, [...(bag.get(key) || []), g]);
    }
    for (const g of unaffected) {
      let found = false;
      for (let dx = -1; dx <= 1 && !found; dx++)
        for (let dy = -1; dy <= 1 && !found; dy++) {
          const bucket = bag.get(
            bucketKey(g, Math.floor(g.origin[0]) + dx, Math.floor(g.origin[1]) + dy),
          );
          const at = bucket?.findIndex(
            (a) =>
              Math.abs(a.origin[0] - g.origin[0]) < 0.15 &&
              Math.abs(a.origin[1] - g.origin[1]) < 0.15 &&
              Math.abs(a.size - g.size) < 0.01,
          );
          if (bucket && at !== undefined && at >= 0) {
            bucket.splice(at, 1);
            found = true;
          }
        }
      if (!found) throw new Error('Validation failed: neighboring text changed.');
    }
    const inserted = afterGlyphs.filter((g) => overlaps(g.rect, target.rect));
    const regionText = inserted
      .sort((a, b) => a.origin[0] - b.origin[0])
      .map((g) => g.text)
      .join('');
    if (normalize(regionText) !== op.replacement)
      throw new Error(
        'Validation failed: replacement or original-text removal could not be verified.',
      );
    if (
      afterGlyphs.filter((g) => g.text.trim()).length !==
      unaffected.length + op.replacement.replace(/\s/g, '').length
    )
      throw new Error('Validation failed: unexpected text was added or removed.');
    const original = openPDF(bytes);
    let changedPixels = 0,
      outsidePixels = 0;
    try {
      for (let i = 0; i < model.pages.length; i++) {
        const a = original.loadPage(i),
          b = reopened.loadPage(i);
        try {
          if (features(b) !== beforeFeatures[i])
            throw new Error('Validation failed: links or page features changed.');
          const diff = compare(a, b, i === target.page ? target.rect : undefined);
          changedPixels += diff.changed;
          outsidePixels += diff.outside;
        } finally {
          a.destroy();
          b.destroy();
        }
      }
    } finally {
      original.destroy();
    }
    if (outsidePixels)
      throw new Error(
        `Validation failed: ${outsidePixels} unexpected pixels changed outside the text area. No edit was committed.`,
      );
    return {
      bytes: output,
      model: after,
      validation: {
        status: 'SAFE_TO_APPLY',
        pageCount: after.pages.length,
        changedPixels,
        outsidePixels,
        checkedPages: after.pages.length,
        checks: [
          'Reopened exported PDF',
          'Page count preserved',
          'Replacement searchable in target region',
          'Original target removed',
          'Neighboring text positions preserved',
          'Links and annotations preserved',
          'All pages compared at 108 dpi; zero unexpected pixels',
        ],
      },
    };
  } finally {
    reopened?.destroy();
    arena.close();
    doc.destroy();
  }
}
