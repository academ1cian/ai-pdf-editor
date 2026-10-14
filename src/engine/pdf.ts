import * as mupdf from 'mupdf';
import {
  targetFromRange,
  glyphsForTarget,
  type BatchProposal,
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
function revision(bytes: Uint8Array): string {
  // Snapshot identity for stale-selection detection; geometry/text are also re-resolved.
  let a = 2166136261, b = 0x9e3779b9;
  for (const byte of bytes) { a = Math.imul(a ^ byte, 16777619); b = Math.imul(b ^ byte, 2246822519); }
  return `${bytes.length}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
function extract(doc: mupdf.PDFDocument, snapshot?: string): DocumentModel {
  const model: DocumentModel = { revision: snapshot, pages: [], warnings: documentWarnings(doc) };
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
    return extract(doc, revision(bytes));
  } finally {
    doc.destroy();
  }
}

function resolve(
  model: DocumentModel,
  target: Target,
): { line: Line; glyphs: Glyph[]; target: Target } {
  if (target.revision !== model.revision) throw new Error('This selection belongs to an older document version. Select it again.');
  const actual = targetFromRange(model, target.page, target.line, target.start, target.end);
  if (!actual || actual.id !== target.id || normalize(actual.original) !== normalize(target.original))
    throw new Error('The selected text changed. Find it again before applying.');
  const line = model.pages[actual.page].lines.find(l => l.id === actual.line)!;
  return { line, glyphs: glyphsForTarget(line, actual), target: actual };
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
          if (l.id === line.id && glyphs.includes(l.glyphs[i])) continue;
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
    return check(doc, extract(doc, revision(bytes)), op);
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
function compare(before: mupdf.PDFPage, after: mupdf.PDFPage, allowed: Rect[] = []) {
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
        if (!allowed.some(r =>
          x >= Math.floor(r[0] * 1.5) - 2 && x <= Math.ceil(r[2] * 1.5) + 2 &&
          y >= Math.floor(r[1] * 1.5) - 2 && y <= Math.ceil(r[3] * 1.5) + 2))
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

function preflight(doc: mupdf.PDFDocument, model: DocumentModel, operations: Operation[]): BatchProposal {
  if (!Array.isArray(operations) || !operations.length || operations.length > 40)
    return {status: 'UNSUPPORTED', operations: [], message: 'Choose between 1 and 40 changes per batch.'};
  const proposals = operations.map(op => check(doc, model, op));
  for (let i = 0; i < proposals.length; i++)
    for (let j = 0; j < i; j++) {
      const a = proposals[i].target, b = proposals[j].target;
      if (a.page === b.page && (a.id === b.id ||
        (a.line === b.line && a.start < b.end && a.end > b.start) || overlaps(a.rect, b.rect, 0.01))) {
        proposals[i] = {...proposals[i], status: 'UNSUPPORTED', message: `Conflicts with change ${j + 1}: duplicate or overlapping selection.`};
        proposals[j] = {...proposals[j], status: 'UNSUPPORTED', message: `Conflicts with change ${i + 1}: duplicate or overlapping selection.`};
      }
    }
  const failed = proposals.findIndex(p => p.status !== 'SAFE_TO_APPLY');
  return {operations: proposals, status: failed < 0 ? 'SAFE_TO_APPLY' : 'UNSUPPORTED',
    message: failed < 0 ? 'All changes fit. The combined PDF will be validated before committing.' :
      `Change ${failed + 1} (page ${proposals[failed].target.page + 1}): ${proposals[failed].message}`};
}
export function proposeBatchPDF(bytes: Uint8Array, operations: Operation[]): BatchProposal {
  const doc = openPDF(bytes);
  try { return preflight(doc, extract(doc, revision(bytes)), operations); }
  finally { doc.destroy(); }
}
export function applyPDF(bytes: Uint8Array, op: Operation): EditResult {
  return applyBatchPDF(bytes, [op]);
}
export function applyBatchPDF(bytes: Uint8Array, operations: Operation[]): EditResult {
  const doc = openPDF(bytes);
  const arena = new Arena();
  let reopened: mupdf.PDFDocument | undefined;
  try {
    const model = extract(doc, revision(bytes));
    const batch = preflight(doc, model, operations);
    if (batch.status !== 'SAFE_TO_APPLY') throw new Error(batch.message);
    const resolved = batch.operations.map((op, index) => ({...op, ...resolve(model, op.target), index}));
    const beforeFeatures = model.pages.map(p => {
      const page = doc.loadPage(p.index);
      try { return features(page); } finally { page.destroy(); }
    });
    // All geometry and glyph references above come from the same unmodified snapshot.
    for (const pageModel of model.pages) {
      const edits = resolved.filter(op => op.target.page === pageModel.index);
      if (!edits.length) continue;
      const page = arena.own(doc.loadPage(pageModel.index));
      const obj = arena.own(page.getObject());
      const annotations = arena.own(obj.get('Annots'));
      const preservedAnnotations = arena.own(doc.newArray());
      if (!annotations.isNull()) annotations.forEach(an => { arena.own(an); preservedAnnotations.push(an); });
      for (const edit of edits) {
        const redact = arena.own(page.createAnnotation('Redact'));
        const r = edit.target.rect;
        redact.setRect([r[0] + 0.1, r[1] + 0.1, r[2] - 0.1, r[3] - 0.1]);
        redact.update();
      }
      // Applying once per page avoids rewriting inserted replacements or invalidating later targets.
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE,
        mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      if (!annotations.isNull()) obj.put('Annots', preservedAnnotations);
      const oldResources = arena.own(obj.getInheritable('Resources'));
      const resources = arena.own(doc.newDictionary());
      oldResources.forEach((v,k) => {arena.own(v); resources.put(k,v);});
      const fonts = arena.own(doc.newDictionary());
      arena.own(oldResources.get('Font')).forEach((v,k) => {arena.own(v); fonts.put(k,v);});
      const fontKeys = new Map<string, string>();
      let suffix = 0;
      for (const {glyphs} of edits) {
        const fontName = glyphs[0].font;
        if (fontKeys.has(fontName)) continue;
        let key = 'EditorFont';
        while (!arena.own(fonts.get(key)).isNull()) key = `EditorFont${++suffix}`;
        fonts.put(key, arena.own(doc.addSimpleFont(arena.own(new mupdf.Font(fontName)))));
        fontKeys.set(fontName, key);
      }
      resources.put('Font', fonts);
      obj.put('Resources', resources);
      const oldContents = arena.own(obj.get('Contents'));
      const contents = arena.own(doc.newArray());
      contents.push(arena.own(doc.addStream('q\n', {})));
      if (oldContents.isArray()) oldContents.forEach(v => {arena.own(v); contents.push(v);});
      else if (!oldContents.isNull()) contents.push(oldContents);
      const matrix = mupdf.Matrix.invert(page.getTransform());
      const streams = edits.map(edit => {
        const first = edit.glyphs[0];
        const x = first.origin[0]*matrix[0] + first.origin[1]*matrix[2] + matrix[4];
        const y = first.origin[0]*matrix[1] + first.origin[1]*matrix[3] + matrix[5];
        const escaped = edit.replacement.replace(/[\\()]/g, '\\$&');
        const color = first.color.length === 1 ? `${first.color[0]} g` : `${first.color.join(' ')} rg`;
        return `q\nBT /${fontKeys.get(first.font)} ${first.size} Tf ${color} 1 0 0 1 ${x} ${y} Tm (${escaped}) Tj ET\nQ\n`;
      });
      contents.push(arena.own(doc.addStream('\nQ\n' + streams.join(''), {})));
      obj.put('Contents', contents);
    }
    const output = arena.own(doc.saveToBuffer('garbage=4,compress')).asUint8Array().slice();
    reopened = openPDF(output);
    const after = extract(reopened, revision(output));
    if (after.pages.length !== model.pages.length) throw new Error('Validation failed: page count changed. No changes committed.');
    // Match preserved glyphs as a multiset, independently of extraction/content-stream order.
    for (const pageModel of model.pages) {
      const edits = resolved.filter(op => op.target.page === pageModel.index);
      const selected = new Set(edits.flatMap(op => op.glyphs));
      const unaffected = pageModel.lines.flatMap(l => l.glyphs).filter(g => g.text.trim() && !selected.has(g));
      const afterGlyphs = after.pages[pageModel.index].lines.flatMap(l => l.glyphs);
      const bag = new Map<string, Glyph[]>();
      for (const g of afterGlyphs.filter(g => g.text.trim())) {
        const key = bucketKey(g); bag.set(key, [...(bag.get(key) || []), g]);
      }
      const consume = (g: Glyph) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const bucket = bag.get(bucketKey(g, Math.floor(g.origin[0])+dx, Math.floor(g.origin[1])+dy));
          const at = bucket?.findIndex(a => Math.abs(a.origin[0]-g.origin[0]) < 0.15 &&
            Math.abs(a.origin[1]-g.origin[1]) < 0.15 && Math.abs(a.size-g.size) < 0.01 &&
            a.color.length === g.color.length && a.color.every((c,i) => Math.abs(c-g.color[i]) < 0.01));
          if (bucket && at !== undefined && at >= 0) {bucket.splice(at,1); return true;}
        }
        return false;
      };
      for (const g of unaffected)
        if (!consume(g)) throw new Error(`Validation failed: neighboring text changed on page ${pageModel.index+1} at ${g.origin.map(n => n.toFixed(1)).join(', ')} pt. No changes committed.`);
      for (const edit of edits) {
        const first = edit.glyphs[0];
        const font = arena.own(new mupdf.Font(first.font));
        let x = first.origin[0];
        for (const char of edit.replacement) {
          if (char.trim() && !consume({...first, text: char, origin: [x, first.origin[1]]}))
            throw new Error(`Change ${edit.index+1} (page ${pageModel.index+1}): replacement text/style could not be verified. No changes committed.`);
          x += font.advanceGlyph(font.encodeCharacter(char))*first.size;
        }
        // Ignore only inferred leading/trailing whitespace in extraction gaps. Internal spaces remain checked.
        const regionText = afterGlyphs.filter(g => overlaps(g.rect, edit.target.rect) &&
          g.origin[0] >= first.origin[0]-0.15 && g.origin[0] < x-0.01)
          .sort((a,b) => a.origin[0]-b.origin[0]).map(g => g.text).join('');
        if (normalize(regionText).trim() !== edit.replacement.trim())
          throw new Error(`Change ${edit.index+1} (page ${pageModel.index+1}): replacement or original-text removal could not be verified. No changes committed.`);
      }
      if ([...bag.values()].some(items => items.length))
        throw new Error(`Validation failed: unexpected text on page ${pageModel.index+1}. No changes committed.`);
    }
    const original = openPDF(bytes);
    let changedPixels = 0, outsidePixels = 0;
    try {
      for (let i=0; i<model.pages.length; i++) {
        const a=original.loadPage(i), b=reopened.loadPage(i);
        try {
          if (features(b) !== beforeFeatures[i]) throw new Error(`Validation failed: links or page features changed on page ${i+1}. No changes committed.`);
          const diff = compare(a,b,resolved.filter(op => op.target.page === i).map(op => op.target.rect));
          changedPixels += diff.changed; outsidePixels += diff.outside;
          if (diff.outside) throw new Error(`Validation failed: ${diff.outside} unexpected pixels changed on page ${i+1} outside selected text areas. No changes committed.`);
        } finally {a.destroy(); b.destroy();}
      }
    } finally {original.destroy();}
    return {bytes: output, model: after, validation: {
      status: 'SAFE_TO_APPLY', pageCount: after.pages.length, changedPixels, outsidePixels,
      checkedPages: after.pages.length, checks: [
        'Reopened combined exported PDF', 'Page count preserved',
        `${resolved.length} replacements searchable in their target regions`,
        'Original targets removed', 'All unaffected text positions and styles preserved',
        'Links and annotations preserved', 'All pages compared at 108 dpi; zero unexpected pixels',
        'All changes validated together; one atomic transaction',
      ],
    }};
  } finally {reopened?.destroy(); arena.close(); doc.destroy();}
}
