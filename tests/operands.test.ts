import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { lexContent } from '../src/engine/operands';
import { inspectPDF, applyBatchPDF, proposeBatchPDF, renderPDF } from '../src/engine/pdf';
import { buildContext } from '../src/ai/context';
import { localInvoicePlan } from '../src/ai/invoice-intent';
import { validateAnalysis } from '../src/ai/analysis';
import { resolvePlan } from '../src/ai/resolve';
import { History, targetFromRange } from '../src/engine/model';
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
