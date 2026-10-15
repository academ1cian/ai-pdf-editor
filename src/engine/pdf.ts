import * as mupdf from 'mupdf';
import {
  inspectImages,
  planImages,
  applyImages,
  imageChangeRegions,
  extractImage,
  type ImageOperation,
} from './images';
import { replacementFont } from './fonts';
import { planOperands, applyOperands } from './operands';
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
  // Structured text reports a geometric-mean size under anisotropic scaling.
  // Capture the real text transform so reconstruction preserves native vertical
  // point size and horizontal scaling rather than subtly shrinking financial text.
  const positioned = lines.flatMap((l) => l.glyphs),
    buckets = new Map<string, Glyph[]>();
  for (const g of positioned) {
    const key = g.text + ':' + Math.round(g.origin[0] * 10) + ':' + Math.round(g.origin[1] * 10);
    buckets.set(key, [...(buckets.get(key) || []), g]);
  }
  const metricsDevice = new mupdf.Device({
    fillText: (text, ctm) => {
      text.walk({
        showGlyph: (font, trm, _gid, unicode) => {
          try {
            const matrix = mupdf.Matrix.concat(trm, ctm),
              glyph = buckets
                .get(
                  String.fromCodePoint(unicode) +
                    ':' +
                    Math.round(matrix[4] * 10) +
                    ':' +
                    Math.round(matrix[5] * 10),
                )
                ?.find(
                  (g) =>
                    Math.abs(g.origin[0] - matrix[4]) < 0.02 &&
                    Math.abs(g.origin[1] - matrix[5]) < 0.02,
                );
            if (glyph) {
              const vertical = Math.hypot(matrix[2], matrix[3]);
              if (vertical > 0) {
                glyph.verticalSize = vertical;
                glyph.horizontalScale = Math.hypot(matrix[0], matrix[1]) / vertical;
              }
            }
          } finally {
            font.destroy();
          }
        },
      });
    },
  });
  try {
    page.runPageContents(metricsDevice, mupdf.Matrix.identity);
  } finally {
    metricsDevice.close();
    metricsDevice.destroy();
  }
  if (lines.reduce((n, l) => n + l.glyphs.length, 0) > 15000)
    throw new Error('A page contains too much text to process safely.');
  return { index, bounds, lines, warnings: [...new Set(warnings)] };
}
function revision(bytes: Uint8Array): string {
  // Snapshot identity for stale-selection detection; geometry/text are also re-resolved.
  let a = 2166136261,
    b = 0x9e3779b9;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 16777619);
    b = Math.imul(b ^ byte, 2246822519);
  }
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
      p.images = inspectImages(doc, i, model.revision);
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
  if (target.revision !== model.revision)
    throw new Error('This selection belongs to an older document version. Select it again.');
  const actual = targetFromRange(model, target.page, target.line, target.start, target.end);
  if (
    !actual ||
    actual.id !== target.id ||
    normalize(actual.original) !== normalize(target.original)
  )
    throw new Error('The selected text changed. Find it again before applying.');
  const line = model.pages[actual.page].lines.find((l) => l.id === actual.line)!;
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

/** Measure the clear horizontal corridor using glyphs, vector borders and image instances. */
function fitRegion(page: mupdf.PDFPage, model: PageModel, glyphs: Glyph[], target: Target) {
  const first = glyphs[0];
  const obstacles: Rect[] = model.lines
    .flatMap((l) => l.glyphs)
    .filter((g) => !glyphs.includes(g) && !!g.text.trim())
    .map((g) => g.rect);
  const addPath = (path: mupdf.Path, ctm: mupdf.Matrix) => {
    let x = 0,
      y = 0,
      sx = 0,
      sy = 0;
    const point = (a: number, b: number) => [
      a * ctm[0] + b * ctm[2] + ctm[4],
      a * ctm[1] + b * ctm[3] + ctm[5],
    ];
    const segment = (a: number, b: number) => {
      const p = point(x, y),
        q = point(a, b);
      obstacles.push([
        Math.min(p[0], q[0]) - 0.5,
        Math.min(p[1], q[1]) - 0.5,
        Math.max(p[0], q[0]) + 0.5,
        Math.max(p[1], q[1]) + 0.5,
      ]);
      x = a;
      y = b;
    };
    path.walk({
      moveTo: (a, b) => {
        x = sx = a;
        y = sy = b;
      },
      lineTo: segment,
      curveTo: (a, b, c, d, e, f) => {
        const pts = [point(x, y), point(a, b), point(c, d), point(e, f)];
        obstacles.push([
          Math.min(...pts.map((p) => p[0])) - 0.5,
          Math.min(...pts.map((p) => p[1])) - 0.5,
          Math.max(...pts.map((p) => p[0])) + 0.5,
          Math.max(...pts.map((p) => p[1])) + 0.5,
        ]);
        x = e;
        y = f;
      },
      closePath: () => segment(sx, sy),
    });
  };
  const dev = new mupdf.Device({
    strokePath: (path, _stroke, ctm) => addPath(path, ctm),
    // Filled paths are conservatively treated as borders, including rectangular fills.
    fillPath: (path, _evenOdd, ctm) => addPath(path, ctm),
    fillImage: (_image, ctm) => {
      const pts = [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ].map(([x, y]) => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]]);
      obstacles.push([
        Math.min(...pts.map((p) => p[0])),
        Math.min(...pts.map((p) => p[1])),
        Math.max(...pts.map((p) => p[0])),
        Math.max(...pts.map((p) => p[1])),
      ]);
    },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
  } finally {
    dev.close();
    dev.destroy();
  }
  const numeric =
    /^[$€£]?-?\d[\d,]*(?:\.\d+)?%?$/.test(target.original.trim()) &&
    model.lines.find((l) => l.id === target.line)?.text.trim() === target.original.trim();
  const rightEvidence =
    numeric &&
    model.lines.some(
      (l) =>
        !l.glyphs.some((g) => glyphs.includes(g)) &&
        ((/^(?:-?\d[\d,]*\.?\d*)$/.test(l.text.trim()) &&
          Math.abs(l.rect[2] - target.rect[2]) < 1 &&
          Math.abs(l.rect[1] - target.rect[1]) < 100) ||
          (/^(rate|charges?|amount|total|balance)$/i.test(l.text.trim()) &&
            l.rect[3] <= target.rect[1] &&
            target.rect[1] - l.rect[3] < 100 &&
            Math.abs((l.rect[0] + l.rect[2]) / 2 - (target.rect[0] + target.rect[2]) / 2) < 35)),
    );
  // Both directions matter: a right-hand heading can use clear space to its left.
  let left = model.bounds[0] + 12;
  let right = model.bounds[2] - 12;
  for (const r of obstacles) {
    if (r[1] >= target.rect[3] || r[3] <= target.rect[1]) continue;
    if (r[2] <= target.rect[0] + 0.15) left = Math.max(left, r[2] + 0.5);
    else if (r[0] >= target.rect[2] - 0.15) right = Math.min(right, r[0] - 0.5);
    else if (overlaps(r, target.rect)) {
      // Interior graphics cannot safely be occupied by new glyphs.
      left = Math.max(left, first.origin[0]);
      right = Math.min(right, target.rect[2]);
    }
  }
  return { left, right, rightAligned: rightEvidence, obstacles };
}

function check(doc: mupdf.PDFDocument, model: DocumentModel, op: Operation): Proposal {
  let proposal: Proposal = { ...op, status: 'UNSUPPORTED', message: '' };
  try {
    if (model.warnings.length) throw new Error(model.warnings[0]);
    if (
      op.replacement.length > 2000 ||
      Array.from(op.replacement).some(
        (c) => (c.charCodeAt(0) < 32 && c !== '\n') || c.charCodeAt(0) === 127,
      )
    )
      throw new Error('Use printable replacement text (up to 2,000 characters).');
    if (op.replacement === op.target.original) throw new Error('Enter different replacement text.');
    const { line, glyphs, target } = resolve(model, op.target);
    proposal = { ...proposal, target };
    const first = glyphs[0];
    const baseSize = first.verticalSize || first.size;
    const pageModel = model.pages[target.page];
    if (!first)
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
    const operand = planOperands(doc, op, glyphs);
    if (operand)
      return {
        ...proposal,
        target,
        status: 'SAFE_TO_APPLY',
        strategy: 'operand',
        message:
          'Preserves the original font, encoding, spacing and text operators. Export integrity will be checked before download.',
        font: first.font,
        size: first.size,
        origin: first.origin,
        layoutRect: target.rect,
        fitting: 'original',
      };
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
        if (
          base.replace(/^[A-Z]{6}\+/, '') === first.font &&
          (!STANDARD_FONTS.has(first.font) || a.own(f.get('FontDescriptor')).isNull())
        )
          verified = true;
      });
      if (!verified)
        throw new Error(
          'The original standard font could not be verified. No substitute will be used.',
        );
      const font = a.own(replacementFont(first.font, op.replacement));
      const embedded = !STANDARD_FONTS.has(first.font) || font.getName() !== first.font;
      let width = 0;
      for (const char of op.replacement.replace(/\n/g, '')) {
        const gid = font.encodeCharacter(char);
        if (!gid) throw new Error('The original font does not contain a replacement character.');
        width += font.advanceGlyph(gid) * baseSize * (embedded ? 1 : first.horizontalScale || 1);
      }
      // Reject custom character spacing/scaling; preserving baseline alone is insufficient.
      for (let i = 0; STANDARD_FONTS.has(first.font) && i < glyphs.length - 1; i++) {
        const metrics = a.own(replacementFont(first.font, target.original));
        const advance = metrics.advanceGlyph(metrics.encodeCharacter(glyphs[i].text)) * first.size;
        if (Math.abs(glyphs[i + 1].origin[0] - glyphs[i].origin[0] - advance) > 0.15)
          throw new Error('Custom text spacing is not supported.');
      }
      const region = fitRegion(page, pageModel, glyphs, target);
      const alignment = region.rightAligned ? 'right' : 'left';
      const oldWidth = target.rect[2] - first.origin[0];
      const allowedWidth = Math.max(
        width <= oldWidth + 0.1 ? oldWidth : 0,
        region.rightAligned ? target.rect[2] - region.left : region.right - region.left,
      );
      let size = baseSize;
      let fitting: Proposal['fitting'] = width <= oldWidth + 0.1 ? 'original' : 'whitespace';
      const horizontalScale = embedded ? 1 : first.horizontalScale || 1;
      const measure = (text: string, s: number) =>
        Array.from(text).reduce(
          (n, c) => n + font.advanceGlyph(font.encodeCharacter(c)) * s * horizontalScale,
          0,
        );
      const makeLines = (s: number, limit = allowedWidth) => {
        const result: string[] = [];
        for (const paragraph of op.replacement.split('\n')) {
          let row = '';
          for (const word of paragraph.split(/ +/)) {
            if (measure(word, s) > limit + 0.1) return;
            const next = row ? row + ' ' + word : word;
            if (measure(next, s) > limit + 0.1) {
              result.push(row);
              row = word;
            } else row = next;
          }
          result.push(row);
        }
        return result;
      };
      const topOffset = embedded ? -1.1 * baseSize : target.rect[1] - first.origin[1];
      const bottomOffset = embedded ? 0.35 * baseSize : target.rect[3] - first.origin[1];
      let x =
        fitting === 'original' && !op.replacement.includes('\n')
          ? first.origin[0]
          : region.rightAligned
            ? target.rect[2] - Math.min(width, allowedWidth)
            : width <= region.right - first.origin[0]
              ? first.origin[0]
              : Math.max(region.left, target.rect[2] - Math.min(width, allowedWidth));
      let rows = [op.replacement];
      let moves: NonNullable<Proposal['moves']> = [];
      if (width > allowedWidth + 0.1 || op.replacement.includes('\n')) {
        const attempts = [
          baseSize,
          Number((baseSize * 0.95).toFixed(6)),
          Number((baseSize * 0.9).toFixed(6)),
          Number((baseSize * 0.85).toFixed(6)),
          Number((baseSize * 0.8).toFixed(6)),
        ].filter((s) => s >= Math.min(8, baseSize));
        let fitted = false;
        for (const candidate of attempts) {
          const wrapped = makeLines(candidate);
          if (!wrapped) continue;
          const w = Math.max(...wrapped.map((t) => measure(t, candidate)));
          const candidateX = Math.max(region.left, Math.min(first.origin[0], region.right - w));
          const bottom =
            first.origin[1] +
            (wrapped.length - 1) * candidate * 1.25 +
            (bottomOffset * candidate) / baseSize;
          const regionRect: Rect = [
            candidateX,
            first.origin[1] + (topOffset * candidate) / baseSize,
            candidateX + w,
            bottom,
          ];
          if (
            bottom > pageModel.bounds[3] - 12 ||
            region.obstacles.some((r) => overlaps(r, regionRect))
          )
            continue;
          size = candidate;
          rows = wrapped;
          x = candidateX;
          fitted = true;
          fitting = wrapped.length > 1 ? 'wrap' : 'typography';
          break;
        }
        if (!fitted && target.start === 0 && target.end === line.text.length) {
          // A connected paragraph may move as a coherent section. Never infer a table
          // row, heading group, or unrelated block from proximity alone.
          const following = pageModel.lines
            .filter((l) => l.glyphs[0]?.origin[1] > first.origin[1])
            .sort((a, b) => a.glyphs[0].origin[1] - b.glyphs[0].origin[1]);
          const chain: Line[] = [];
          let baseline = first.origin[1];
          for (const l of following) {
            const g = l.glyphs[0];
            if (g.origin[1] - baseline > first.size * 1.8) break;
            if (
              Math.abs(g.origin[0] - first.origin[0]) > 2 ||
              l.glyphs.some((g) => g.font !== first.font || Math.abs(g.size - first.size) > 0.01) ||
              !/^[\x20-\x7e]+$/.test(l.text)
            )
              break;
            chain.push(l);
            baseline = g.origin[1];
          }
          const wrapped = makeLines(baseSize, region.right - first.origin[0]);
          if (chain.length && wrapped) {
            const w = Math.max(...wrapped.map((t) => measure(t, baseSize))),
              candidateX = first.origin[0],
              bottom = first.origin[1] + (wrapped.length - 1) * baseSize * 1.25 + bottomOffset;
            const dy = Math.max(0, bottom + first.size * 0.25 - chain[0].rect[1]);
            const movedGlyphs = chain.flatMap((l) => l.glyphs);
            const obstacles = region.obstacles.filter(
              (r) => !movedGlyphs.some((g) => g.rect === r),
            );
            const candidate: Rect = [
              candidateX,
              first.origin[1] + topOffset,
              candidateX + w,
              bottom,
            ];
            const destinations = chain.map(
              (l) => [l.rect[0], l.rect[1] + dy, l.rect[2], l.rect[3] + dy] as Rect,
            );
            if (
              dy > 0 &&
              destinations.every(
                (r) => r[3] < pageModel.bounds[3] - 12 && !obstacles.some((o) => overlaps(o, r)),
              ) &&
              !obstacles.some((r) => overlaps(r, candidate))
            ) {
              moves = chain.map((l) => ({
                target: targetFromRange(model, target.page, l.id, 0, l.text.length)!,
                dy,
              }));
              rows = wrapped;
              x = candidateX;
              size = baseSize;
              fitting = 'wrap';
              fitted = true;
            }
          }
        }
        if (!fitted)
          throw new Error(
            'The complete text cannot fit readably in this region without moving neighboring content. Select a larger paragraph or section, or use a shorter replacement. No text was truncated.',
          );
      }
      width = Math.max(...rows.map((t) => measure(t, size)));
      const lines = rows.map((text, i) => ({
        text,
        origin: [x, first.origin[1] + i * size * 1.25] as [number, number],
      }));
      const layoutRect: Rect = [
        Math.min(target.rect[0], x),
        Math.min(target.rect[1], lines[0].origin[1] + (topOffset * size) / baseSize),
        Math.max(target.rect[2], x + width),
        Math.max(target.rect[3], lines.at(-1)!.origin[1] + (bottomOffset * size) / baseSize),
      ];
      proposal = {
        ...proposal,
        strategy: planOperands(doc, op, glyphs, true) ? 'reconstruct' : undefined,
        font: font.getName(),
        embedded,
        horizontalScale,
        size,
        width,
        allowedWidth,
        origin: lines[0].origin,
        lines,
        moves,
        layoutRect,
        fitting,
        alignment,
      };
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
        message: `${embedded ? 'Embeds ' + font.getName() + ' for the replacement. ' : ''}${fitting === 'wrap' ? 'Reconstructs the selected text into ' + rows.length + ' readable lines within measured whitespace.' : fitting === 'typography' ? 'Typography adjustment: font size ' + first.size.toFixed(2) + ' → ' + size.toFixed(2) + ' pt.' : fitting === 'whitespace' ? 'Uses measured adjacent whitespace; neighbors and borders stay fixed.' : 'Preserves original font size and baseline.'} ${alignment === 'right' ? 'Preserves the numeric column’s right edge.' : x < first.origin[0] - 0.1 ? 'Repositions left within measured whitespace.' : 'Preserves the left edge.'} ${moves.length ? 'Moves ' + moves.length + ' connected following paragraph lines coherently by ' + moves[0].dy.toFixed(1) + ' pt. ' : ''}Export integrity will be checked before download.`,
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
        if (
          !allowed.some(
            (r) =>
              x >= Math.floor(r[0] * 1.5) - 2 &&
              x <= Math.ceil(r[2] * 1.5) + 2 &&
              y >= Math.floor(r[1] * 1.5) - 2 &&
              y <= Math.ceil(r[3] * 1.5) + 2,
          )
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

function preflight(
  doc: mupdf.PDFDocument,
  model: DocumentModel,
  operations: Operation[],
): BatchProposal {
  if (!Array.isArray(operations) || !operations.length || operations.length > 40)
    return {
      status: 'UNSUPPORTED',
      operations: [],
      message: 'Choose between 1 and 40 changes per batch.',
    };
  const proposals = operations.map((op) => check(doc, model, op));
  for (let i = 0; i < proposals.length; i++)
    for (let j = 0; j < i; j++) {
      const a = proposals[i].target,
        b = proposals[j].target;
      if (
        a.page === b.page &&
        (a.id === b.id ||
          (a.line === b.line && a.start < b.end && a.end > b.start) ||
          overlaps(proposals[i].layoutRect || a.rect, proposals[j].layoutRect || b.rect, 0.01) ||
          proposals[i].moves?.some((m) => m.target.id === b.id) ||
          proposals[j].moves?.some((m) => m.target.id === a.id))
      ) {
        proposals[i] = {
          ...proposals[i],
          status: 'UNSUPPORTED',
          message: `Conflicts with change ${j + 1}: duplicate or overlapping selection.`,
        };
        proposals[j] = {
          ...proposals[j],
          status: 'UNSUPPORTED',
          message: `Conflicts with change ${i + 1}: duplicate or overlapping selection.`,
        };
      }
    }
  const failed = proposals.findIndex((p) => p.status !== 'SAFE_TO_APPLY');
  return {
    operations: proposals,
    status: failed < 0 ? 'SAFE_TO_APPLY' : 'UNSUPPORTED',
    message:
      failed < 0
        ? 'All changes fit. The combined PDF will be validated before committing.'
        : `Change ${failed + 1} (page ${proposals[failed].target.page + 1}): ${proposals[failed].message}`,
  };
}
export function proposeBatchPDF(bytes: Uint8Array, operations: Operation[]): BatchProposal {
  const doc = openPDF(bytes);
  try {
    return preflight(doc, extract(doc, revision(bytes)), operations);
  } finally {
    doc.destroy();
  }
}
export function applyPDF(bytes: Uint8Array, op: Operation): EditResult {
  return applyBatchPDF(bytes, [op]);
}
export function applyBatchPDF(
  bytes: Uint8Array,
  operations: Operation[],
  images: ImageOperation[] = [],
): EditResult {
  const doc = openPDF(bytes);
  const arena = new Arena();
  let reopened: mupdf.PDFDocument | undefined;
  try {
    const model = extract(doc, revision(bytes));
    const batch = operations.length
      ? preflight(doc, model, operations)
      : {
          status: images.length ? 'SAFE_TO_APPLY' : 'UNSUPPORTED',
          message: 'Choose at least one change.',
          operations: [] as Proposal[],
        };
    const imagePlan = planImages(doc, model, images);
    for (const text of batch.operations)
      for (const image of imagePlan)
        if (
          image.action !== 'remove' &&
          text.target.page === image.target.page &&
          overlaps(text.layoutRect || text.target.rect, image.rect!)
        )
          throw new Error(
            'A planned image and replacement text would overlap. Adjust their placement before approval.',
          );
    // Before changing content, establish the exact expected rendering of lossless
    // image normalization. JPEG decoder downsampling differs from PNG at small
    // scales even when every decoded source pixel is identical. This reference
    // permits only those precomputed codec effects, never arbitrary image damage.
    let normalizedReference: Uint8Array | undefined;
    const logos = imagePlan.filter((op) => op.wordmark && !op.wordmark.wholeReplacement);
    if (logos.length) {
      const reference = openPDF(bytes);
      try {
        const normalization = logos.map((op) => ({
          ...op,
          rect: op.target.rect,
          wordmark: undefined,
          bytes: extractImage(reference, op.target),
        }));
        applyImages(reference, normalization);
        const buffer = reference.saveToBuffer('garbage=4,compress');
        try {
          normalizedReference = buffer.asUint8Array().slice();
        } finally {
          buffer.destroy();
        }
      } finally {
        reference.destroy();
      }
    }
    if (batch.status !== 'SAFE_TO_APPLY') throw new Error(batch.message);
    const resolved = batch.operations.flatMap((op, index) => {
      const primary = {
        ...op,
        ...resolve(model, op.target),
        index,
        operand: op.strategy
          ? planOperands(doc, op, resolve(model, op.target).glyphs, op.strategy === 'reconstruct')
          : undefined,
      };
      const moved = (op.moves || []).map((move) => {
        const selected = resolve(model, move.target),
          g = selected.glyphs[0],
          origin: [number, number] = [g.origin[0], g.origin[1] + move.dy];
        const r = selected.target.rect,
          layoutRect: Rect = [r[0], r[1], r[2], r[3] + move.dy];
        const edit: Proposal = {
          target: selected.target,
          replacement: selected.target.original,
          status: 'SAFE_TO_APPLY',
          message: 'Planned coherent paragraph movement',
          font: g.font,
          size: g.verticalSize || g.size,
          horizontalScale: g.horizontalScale || 1,
          origin,
          layoutRect,
          preserveGlyphs: true,
        };
        const operand = planOperands(doc, edit, selected.glyphs, true);
        edit.strategy = operand ? 'reconstruct' : undefined;
        return { ...edit, ...selected, index, operand };
      });
      return [primary, ...moved];
    });
    const beforeFeatures = model.pages.map((p) => {
      const page = doc.loadPage(p.index);
      try {
        return features(page);
      } finally {
        page.destroy();
      }
    });
    // Plans and permitted regions are frozen before mutation. Image occurrences clone resource paths.
    applyImages(doc, imagePlan);
    for (const op of resolved)
      if (op.strategy) op.operand = planOperands(doc, op, op.glyphs, op.strategy === 'reconstruct');
    // All geometry and glyph references above come from the same unmodified snapshot.
    for (const pageModel of model.pages) {
      let edits = resolved.filter((op) => op.target.page === pageModel.index);
      if (!edits.length) continue;
      const streamEdits = edits.filter((op) => !!op.operand);
      if (streamEdits.length) {
        if (streamEdits.some((op) => !op.operand))
          throw new Error('Content operands changed. No changes committed.');
        applyOperands(
          doc,
          pageModel.index,
          streamEdits.map((op) => op.operand!),
        );
        edits = edits.filter((op) => op.strategy !== 'operand');
        if (!edits.length) continue;
      }
      const page = arena.own(doc.loadPage(pageModel.index));
      const obj = arena.own(page.getObject());
      const annotations = arena.own(obj.get('Annots'));
      const preservedAnnotations = arena.own(doc.newArray());
      if (!annotations.isNull())
        annotations.forEach((an) => {
          arena.own(an);
          preservedAnnotations.push(an);
        });
      for (const edit of edits.filter((e) => e.strategy !== 'reconstruct')) {
        const redact = arena.own(page.createAnnotation('Redact'));
        const r = edit.target.rect;
        redact.setRect([r[0] + 0.1, r[1] + 0.1, r[2] - 0.1, r[3] - 0.1]);
        redact.update();
      }
      // Applying once per page avoids rewriting inserted replacements or invalidating later targets.
      if (edits.some((e) => e.strategy !== 'reconstruct'))
        page.applyRedactions(
          false,
          mupdf.PDFPage.REDACT_IMAGE_NONE,
          mupdf.PDFPage.REDACT_LINE_ART_NONE,
          mupdf.PDFPage.REDACT_TEXT_REMOVE,
        );
      if (!annotations.isNull()) obj.put('Annots', preservedAnnotations);
      const oldResources = arena.own(obj.getInheritable('Resources'));
      const resources = arena.own(doc.newDictionary());
      oldResources.forEach((v, k) => {
        arena.own(v);
        resources.put(k, v);
      });
      const fonts = arena.own(doc.newDictionary());
      arena.own(oldResources.get('Font')).forEach((v, k) => {
        arena.own(v);
        fonts.put(k, v);
      });
      const fontKeys = new Map<string, string>();
      let suffix = 0;
      for (const edit of edits) {
        const fontName = edit.font!;
        if (fontKeys.has(fontName)) continue;
        let key = 'EditorFont';
        while (!arena.own(fonts.get(key)).isNull()) key = `EditorFont${++suffix}`;
        const chosen = arena.own(replacementFont(edit.glyphs[0].font, edit.replacement));
        fonts.put(key, arena.own(edit.embedded ? doc.addFont(chosen) : doc.addSimpleFont(chosen)));
        fontKeys.set(fontName, key);
      }
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
      const matrix = mupdf.Matrix.invert(page.getTransform());
      const streams = edits.flatMap((edit) => {
        const first = edit.glyphs[0];
        const font = arena.own(replacementFont(first.font, edit.replacement));
        if (edit.preserveGlyphs) {
          const origin = edit.origin!,
            x = origin[0] * matrix[0] + origin[1] * matrix[2] + matrix[4],
            y = origin[0] * matrix[1] + origin[1] * matrix[3] + matrix[5];
          const vertical = edit.size!,
            horizontal = edit.horizontalScale || 1;
          const array = edit.glyphs
            .map((g, i) => {
              const encoded = '(' + g.text.replace(/[\\()]/g, '\\$&') + ')',
                next = edit.glyphs[i + 1];
              return (
                encoded +
                (next
                  ? ' ' +
                    ((font.advanceGlyph(font.encodeCharacter(g.text)) * vertical * horizontal -
                      (next.origin[0] - g.origin[0])) /
                      (vertical * horizontal)) *
                      1000
                  : '')
              );
            })
            .join(' ');
          const color =
            first.color.length === 1 ? `${first.color[0]} g` : `${first.color.join(' ')} rg`;
          return [
            `q BT /${fontKeys.get(edit.font!)} ${vertical} Tf ${color} ${horizontal} 0 0 1 ${x} ${y} Tm [${array}] TJ ET Q\n`,
          ];
        }
        const rows = edit.preserveGlyphs
          ? edit.glyphs.map((g) => ({
              text: g.text,
              origin: [g.origin[0], g.origin[1] + edit.origin![1] - first.origin[1]] as [
                number,
                number,
              ],
            }))
          : edit.lines || [{ text: edit.replacement, origin: edit.origin || first.origin }];
        return rows.map((row) => {
          const origin = row.origin;
          const x = origin[0] * matrix[0] + origin[1] * matrix[2] + matrix[4];
          const y = origin[0] * matrix[1] + origin[1] * matrix[3] + matrix[5];
          const encoded = edit.embedded
            ? '<' +
              Array.from(row.text, (c) =>
                font.encodeCharacter(c).toString(16).padStart(4, '0'),
              ).join('') +
              '>'
            : '(' + row.text.replace(/[\\()]/g, '\\$&') + ')';
          const color =
            first.color.length === 1 ? `${first.color[0]} g` : `${first.color.join(' ')} rg`;
          return `q\nBT /${fontKeys.get(edit.font!)} ${edit.size || first.size} Tf ${color} ${edit.horizontalScale || 1} 0 0 1 ${x} ${y} Tm ${encoded} Tj ET\nQ\n`;
        });
      });
      contents.push(arena.own(doc.addStream('\nQ\n' + streams.join(''), {})));
      obj.put('Contents', contents);
    }
    const output = arena.own(doc.saveToBuffer('garbage=4,compress')).asUint8Array().slice();
    reopened = openPDF(output);
    const after = extract(reopened, revision(output));
    if (after.pages.length !== model.pages.length)
      throw new Error('Validation failed: page count changed. No changes committed.');
    // Match preserved glyphs as a multiset, independently of extraction/content-stream order.
    for (const pageModel of model.pages) {
      const edits = resolved.filter((op) => op.target.page === pageModel.index);
      const selected = new Set(edits.flatMap((op) => op.glyphs));
      const unaffected = pageModel.lines
        .flatMap((l) => l.glyphs)
        .filter((g) => g.text.trim() && !selected.has(g));
      const afterGlyphs = after.pages[pageModel.index].lines.flatMap((l) => l.glyphs);
      const bag = new Map<string, Glyph[]>();
      for (const g of afterGlyphs.filter((g) => g.text.trim())) {
        const key = bucketKey(g);
        bag.set(key, [...(bag.get(key) || []), g]);
      }
      const consume = (g: Glyph) => {
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) {
            const bucket = bag.get(
              bucketKey(g, Math.floor(g.origin[0]) + dx, Math.floor(g.origin[1]) + dy),
            );
            const at = bucket?.findIndex(
              (a) =>
                Math.abs(a.origin[0] - g.origin[0]) < 0.15 &&
                Math.abs(a.origin[1] - g.origin[1]) < 0.15 &&
                Math.abs(a.size - g.size) < 0.01 &&
                a.color.length === g.color.length &&
                a.color.every((c, i) => Math.abs(c - g.color[i]) < 0.01),
            );
            if (bucket && at !== undefined && at >= 0) {
              bucket.splice(at, 1);
              return true;
            }
          }
        return false;
      };
      for (const g of unaffected)
        if (!consume(g))
          throw new Error(
            `Validation failed: neighboring text changed on page ${pageModel.index + 1} at ${g.origin.map((n) => n.toFixed(1)).join(', ')} pt. No changes committed.`,
          );
      for (const edit of edits) {
        const first = edit.glyphs[0];
        const font = arena.own(replacementFont(first.font, edit.replacement));
        const origin = edit.origin || first.origin;
        const size = edit.size || first.size;
        let x = origin[0];
        if (edit.strategy === 'operand') {
          for (let i = 0; i < edit.glyphs.length; i++) {
            if (!consume({ ...edit.glyphs[i], text: edit.replacement[i] }))
              throw new Error(
                `Change ${edit.index + 1}: original-operand replacement failed position/style verification. No changes committed.`,
              );
          }
          continue;
        }
        if (edit.preserveGlyphs) {
          for (const g of edit.glyphs)
            if (
              g.text.trim() &&
              !consume({ ...g, origin: [g.origin[0], g.origin[1] + origin[1] - first.origin[1]] })
            )
              throw new Error('Planned paragraph movement failed glyph verification.');
          continue;
        }
        for (const row of edit.lines || [{ text: edit.replacement, origin }]) {
          x = row.origin[0];
          for (const char of row.text) {
            if (
              char.trim() &&
              !consume({
                ...first,
                font: edit.font!,
                size: size * Math.sqrt(edit.horizontalScale || 1),
                text: char,
                origin: [x, row.origin[1]],
              })
            )
              throw new Error(
                `Change ${edit.index + 1}: replacement text/style could not be verified. No changes committed.`,
              );
            x += font.advanceGlyph(font.encodeCharacter(char)) * size * (edit.horizontalScale || 1);
          }
          const regionText = afterGlyphs
            .filter(
              (g) =>
                Math.abs(g.origin[1] - row.origin[1]) < 0.15 &&
                g.origin[0] >= row.origin[0] - 0.15 &&
                g.origin[0] < x - 0.01,
            )
            .sort((a, b) => a.origin[0] - b.origin[0])
            .map((g) => g.text)
            .join('');
          if (normalize(regionText).trim() !== row.text.trim())
            throw new Error(
              `Change ${edit.index + 1}: replacement or original-text removal could not be verified.`,
            );
        }
      }
      if ([...bag.values()].some((items) => items.length))
        throw new Error(
          `Validation failed: unexpected text on page ${pageModel.index + 1}. No changes committed.`,
        );
    }
    const original = openPDF(bytes);
    const reference = normalizedReference ? openPDF(normalizedReference) : undefined;
    let changedPixels = 0,
      outsidePixels = 0;
    try {
      for (let i = 0; i < model.pages.length; i++) {
        const a = original.loadPage(i),
          b = reopened.loadPage(i);
        try {
          if (features(b) !== beforeFeatures[i])
            throw new Error(
              `Validation failed: links or page features changed on page ${i + 1}. No changes committed.`,
            );
          let baseline = a;
          if (reference) {
            const normalized = reference.loadPage(i);
            try {
              const expected = compare(
                a,
                normalized,
                imagePlan
                  .filter((op) => op.wordmark && op.target.page === i)
                  .map((op) => op.target.rect),
              );
              if (expected.outside)
                throw new Error('Image normalization changed an unrelated page region.');
              if (features(normalized) !== features(a))
                throw new Error('Image normalization changed page features.');
            } finally {
              normalized.destroy();
            }
            baseline = reference.loadPage(i);
          }
          const diff = compare(baseline, b, [
            ...resolved
              .filter((op) => op.target.page === i)
              .map((op) => op.layoutRect || op.target.rect),
            ...imagePlan.filter((op) => op.target.page === i).flatMap(imageChangeRegions),
          ]);
          if (reference) baseline.destroy();
          changedPixels += diff.changed;
          outsidePixels += diff.outside;
          if (diff.outside)
            throw new Error(
              `Validation failed: ${diff.outside} unexpected pixels changed on page ${i + 1} outside selected text areas. No changes committed.`,
            );
        } finally {
          a.destroy();
          b.destroy();
        }
      }
    } finally {
      original.destroy();
      reference?.destroy();
    }
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
          'Reopened combined exported PDF',
          'Page count preserved',
          `${resolved.length} replacements searchable in their target regions`,
          'Original targets removed',
          'All unaffected text positions and styles preserved',
          'Links and annotations preserved',
          'All pages compared at 108 dpi; zero unexpected pixels',
          ...(logos.length
            ? [
                'Logo pixels outside planned wordmark region preserved exactly; codec resampling compared to a pre-mutation lossless reference',
              ]
            : []),
          'All text and image changes validated together; one atomic transaction',
        ],
      },
    };
  } finally {
    reopened?.destroy();
    arena.close();
    doc.destroy();
  }
}
