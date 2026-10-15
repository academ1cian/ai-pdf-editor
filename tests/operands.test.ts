import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { lexContent, planOperands, applyOperands } from '../src/engine/operands';
import { inspectPDF, applyBatchPDF, proposeBatchPDF, renderPDF } from '../src/engine/pdf';
import { buildContext } from '../src/ai/context';
import { localInvoicePlan } from '../src/ai/invoice-intent';
import { validateAnalysis } from '../src/ai/analysis';
import { resolvePlan } from '../src/ai/resolve';
import { History, targetFromRange, glyphsForTarget } from '../src/engine/model';
const requests = [
  'Поменяй мне rate и charge на тысячу, а final amount посчитай сам.',
  'Поменяй рейты и чаржа на тысячу долларов, а итоговую сумму пересчитай автоматически.',
  'Change the rate and the charges to 1000 and the final amount accordingly.',
  'Change the rate and charge to 1000 and calculate the final amount automatically.',
];
describe('original numeric operands in dense tables', () => {
  it('lexes escaped literal strings, octal, hex, comments and TJ arrays without byte replacement', () => {
    const tokens = lexContent(
      '% (fake) Tj\nBT /F#31 10 Tf [(14\\0707.00) -42 <313438372e30303030> (a\\(b\\)\\\\c)] TJ ET',
    );
    expect(tokens.filter((t) => t.kind === 'string').map((t) => t.value)).toEqual([
      '1487.00',
      '1487.0000',
      'a(b)\\c',
    ]);
    expect(tokens.find((t) => t.kind === 'name')?.value).toBe('F1');
    expect(() => lexContent('BI /W 1 ID binary EI')).toThrow();
    expect(() => lexContent('(bad')).toThrow();
  });
  for (const [name, amount, total] of [
    ['dense-invoice-a', 1000, '$1,065.00'],
    ['dense-invoice-b', 3300, '$3,425.00'],
  ] as const) {
    it(`interprets and edits ${name} with its distinct description, row position and fee`, () => {
      const bytes = new Uint8Array(readFileSync(`tests/fixtures/${name}.pdf`)),
        model = inspectPDF(bytes);
      const instruction = `Change the rate and charge to ${amount} and calculate the final amount automatically.`;
      const context = buildContext(model, instruction, 0),
        raw = localInvoicePlan(context, instruction)!;
      expect(raw.edits).toHaveLength(3);
      const plan = validateAnalysis(raw, context, instruction);
      expect(plan.edits).toHaveLength(3);
      expect(plan.edits[2].replacement).toBe(total);
      const operations = resolvePlan(model, plan, context),
        proposals = proposeBatchPDF(bytes, operations);
      expect(proposals.status).toBe('SAFE_TO_APPLY');
      expect(proposals.operations.every((p) => p.strategy === 'operand')).toBe(true);
      const result = applyBatchPDF(bytes, operations);
      expect(result.validation.outsidePixels).toBe(0);
      expect(renderPDF(result.bytes, 1).png).toEqual(renderPDF(bytes, 1).png);
      expect(renderPDF(result.bytes, 2).png).toEqual(renderPDF(bytes, 2).png);
      const history = new History(bytes);
      history.commit(result.bytes);
      expect(history.undo()).toEqual(bytes);
      // Content remains in the original font resource and TJ arrays, no repair overlay.
      const doc = new mupdf.PDFDocument(result.bytes),
        page = doc.loadPage(0),
        obj = page.getObject(),
        resources = obj.getInheritable('Resources'),
        fonts = resources.get('Font');
      let count = 0;
      fonts.forEach((v) => {
        count++;
        v.destroy();
      });
      expect(count).toBe(1);
      fonts.destroy();
      resources.destroy();
      obj.destroy();
      page.destroy();
      doc.destroy();
    });
  }
  it('understands all required Russian/English variants locally and rejects partial model financial updates', () => {
    const model = inspectPDF(new Uint8Array(readFileSync('tests/fixtures/dense-invoice-a.pdf')));
    for (const instruction of requests) {
      const context = buildContext(model, instruction, 0),
        plan = validateAnalysis(localInvoicePlan(context, instruction)!, context, instruction);
      expect(plan.edits.map((e) => e.replacement)).toEqual(['1000.0000', '1000.00', '$1,065.00']);
      plan.edits.pop();
      expect(validateAnalysis(plan, context, instruction).edits).toEqual([]);
    }
  });
});

it('copies a shared compressed content stream before editing one page', () => {
  const original = new mupdf.PDFDocument(
    new Uint8Array(readFileSync('tests/fixtures/dense-invoice-a.pdf')),
  );
  const first = original.loadPage(0),
    obj = first.getObject(),
    resources = obj.getInheritable('Resources'),
    content = obj.get('Contents');
  const added = original.addPage([0, 0, 612, 792], 0, resources, '');
  added.put('Contents', content);
  original.insertPage(3, added);
  const buffer = original.saveToBuffer('compress'),
    bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  added.destroy();
  content.destroy();
  resources.destroy();
  obj.destroy();
  first.destroy();
  original.destroy();
  const model = inspectPDF(bytes),
    target = model.pages[0].lines.find((l) => l.text === '1487.0000')!;
  const selection = targetFromRange(model, 0, target.id, 0, target.text.length)!;
  const output = applyBatchPDF(bytes, [{ target: selection, replacement: '1000.0000' }]);
  expect(output.model.pages).toHaveLength(4);
  expect(output.model.pages[3].lines.some((l) => l.text === '1487.0000')).toBe(true);
  expect(renderPDF(output.bytes, 3).png).toEqual(renderPDF(bytes, 3).png);
});

it('reconstructs a partial standard-font operand without rewriting the dense invoice stream', () => {
  const bytes = new Uint8Array(readFileSync('tests/fixtures/mixed-invoice.pdf')),
    model = inspectPDF(bytes),
    line = model.pages[0].lines.find((l) => l.text === 'Status: pending')!,
    target = targetFromRange(model, 0, line.id, 8, 15)!,
    operations = [{ target, replacement: 'reviewed' }];
  expect(proposeBatchPDF(bytes, operations).operations[0].strategy).toBe('reconstruct');
  const output = applyBatchPDF(bytes, operations);
  expect(output.validation.outsidePixels).toBe(0);
  expect(output.model.pages[0].lines.some((l) => l.text === 'reviewed')).toBe(true);
  expect(output.model.pages[0].lines.some((l) => l.text.includes('pending'))).toBe(false);
  const streams = (data: Uint8Array) => {
    const doc = new mupdf.PDFDocument(data),
      page = doc.loadPage(0),
      obj = page.getObject(),
      contents = obj.get('Contents');
    const result: string[] = [];
    contents.forEach((ref) => {
      const buffer = ref.readStream();
      result.push(buffer.asString());
      buffer.destroy();
      ref.destroy();
    });
    contents.destroy();
    obj.destroy();
    page.destroy();
    doc.destroy();
    return result;
  };
  const before = streams(bytes),
    after = streams(output.bytes);
  // The original dense table's reciprocal scaling is renderer-sensitive. Its
  // literal operators must survive even though another operand changed.
  expect(after).toContain(before.find((s) => s.includes('(DESCRIPTION)'))!);
  for (const original of before.filter((s) => !s.includes('5374617475733A2070656E64696E67')))
    expect(after).toContain(original);
});

for (const show of [
  '(left pending right) Tj',
  '[(left pending right) 20 ( tail)] TJ',
  '(left pending pending right) Tj',
]) {
  it(`${show.includes('pending pending') ? 'rejects an ambiguous partial range' : 'preserves suffix positions and explicit spacing'} in ${show}`, () => {
    const doc = new mupdf.PDFDocument(
        new Uint8Array(readFileSync('tests/fixtures/mixed-invoice.pdf')),
      ),
      originalPage = doc.loadPage(0),
      originalObject = originalPage.getObject(),
      resources = originalObject.getInheritable('Resources'),
      fonts = resources.get('Font'),
      fontRef = fonts.get('F1'),
      page = doc.addPage(
        [0, 0, 612, 792],
        0,
        { Font: { F1: fontRef } },
        `BT /F1 12 Tf 1.25 Tc 2 Tw .9 0 0 1 40 610 Tm ${show} ET`,
      );
    doc.insertPage(0, page);
    const buffer = doc.saveToBuffer('compress'),
      bytes = buffer.asUint8Array().slice();
    buffer.destroy();
    page.destroy();
    fontRef.destroy();
    fonts.destroy();
    resources.destroy();
    originalObject.destroy();
    originalPage.destroy();
    doc.destroy();
    const model = inspectPDF(bytes),
      line = model.pages[0].lines.find((l) => l.text.includes('pending'))!,
      start = line.text.indexOf('pending'),
      target = targetFromRange(model, 0, line.id, start, start + 7)!,
      operation = { target, replacement: 'ready' },
      patchDoc = new mupdf.PDFDocument(bytes),
      plan = planOperands(patchDoc, operation, glyphsForTarget(line, target), true);
    if (show.includes('pending pending')) {
      expect(plan).toBeUndefined();
      patchDoc.destroy();
      return;
    }
    expect(plan).toBeDefined();
    applyOperands(patchDoc, 0, [plan!]);
    const patchedBuffer = patchDoc.saveToBuffer('compress'),
      patched = patchedBuffer.asUint8Array().slice();
    patchedBuffer.destroy();
    patchDoc.destroy();
    const output = { model: inspectPDF(patched) };
    expect(output.model.pages[0].lines.some((l) => l.text.includes('pending'))).toBe(false);
    const suffix = model.pages[0].lines
      .flatMap((l) => l.glyphs)
      .filter((g) => g.origin[0] > target.rect[2]);
    for (const glyph of suffix) {
      const same = output.model.pages[0].lines
        .flatMap((l) => l.glyphs)
        .find(
          (g) =>
            g.text === glyph.text &&
            Math.abs(g.origin[0] - glyph.origin[0]) < 0.001 &&
            Math.abs(g.origin[1] - glyph.origin[1]) < 0.001,
        );
      expect(same).toBeDefined();
    }
  });
}

it('shorter numeric reconstruction resolves the complete charge operand without matching its rate substring', () => {
  const bytes = new Uint8Array(readFileSync('tests/fixtures/dense-invoice-a.pdf')),
    model = inspectPDF(bytes),
    line = model.pages[0].lines.find((l) => l.text === '1487.00')!,
    target = targetFromRange(model, 0, line.id, 0, line.text.length)!,
    operation = { target, replacement: '950.00' };
  expect(proposeBatchPDF(bytes, [operation]).operations[0].strategy).toBe('reconstruct');
  const output = applyBatchPDF(bytes, [operation]);
  expect(output.model.pages[0].lines.some((l) => l.text === '1487.0000')).toBe(true);
  expect(output.model.pages[0].lines.some((l) => l.text === '950.00')).toBe(true);
  expect(output.validation.outsidePixels).toBe(0);
});
