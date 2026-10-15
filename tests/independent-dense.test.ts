import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectPDF, applyBatchPDF, proposeBatchPDF } from '../src/engine/pdf';
import { buildContext } from '../src/ai/context';
import { localInvoicePlan } from '../src/ai/invoice-intent';
import { resolvePlan } from '../src/ai/resolve';
import { findTargets } from '../src/engine/model';
const require = createRequire(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
const { createCanvas } = require('@napi-rs/canvas');
it('independent PDF.js text geometry and strict raster masks at 100%, 200%, 400%', async () => {
  for (const [name, amount, fee] of [
    ['dense-invoice-a', 1000, 65],
    ['dense-invoice-b', 3300, 125],
  ] as const) {
    const bytes = new Uint8Array(readFileSync(`tests/fixtures/${name}.pdf`)),
      model = inspectPDF(bytes);
    const instruction = `Change the rate and charge to ${amount} and calculate the final amount automatically.`,
      blocks = buildContext(model, instruction, 0),
      plan = localInvoicePlan(blocks, instruction)!;
    const ops = resolvePlan(model, plan, blocks),
      output = applyBatchPDF(bytes, ops).bytes;
    const options = {
      useSystemFonts: false,
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
    };
    const tasks = [
      getDocument({ data: bytes.slice(), ...options }),
      getDocument({ data: output.slice(), ...options }),
    ];
    const [a, b] = await Promise.all(tasks.map((t) => t.promise));
    try {
      expect(a.numPages).toBe(3);
      expect(b.numPages).toBe(3);
      for (let n = 1; n <= 3; n++) {
        const [p, q] = await Promise.all([a.getPage(n), b.getPage(n)]);
        const [oldText, newText] = await Promise.all([p.getTextContent(), q.getTextContent()]);
        const before = oldText.items.filter((x) => 'str' in x && x.str.trim()),
          after = newText.items.filter((x) => 'str' in x && x.str.trim());
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
          const x = before[i],
            y = after[i];
          if (!('str' in x) || !('str' in y)) throw new Error('Unexpected PDF.js item');
          const op = ops.find((op) => op.target.original === x.str);
          expect(y.str).toBe(op?.replacement || x.str);
          expect(y.transform).toEqual(x.transform);
          expect(y.width).toBeCloseTo(x.width, 6);
          expect(y.height).toBe(x.height);
        }
        if (n === 1) {
          expect(after.some((x) => 'str' in x && x.str === `${fee}.00`)).toBe(true);
          expect(after.some((x) => 'str' in x && x.str === `${amount}.0000`)).toBe(true);
        }
        for (const scale of [1, 2, 4]) {
          const render = async (page: typeof p) => {
            const view = page.getViewport({ scale }),
              canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height)),
              context = canvas.getContext('2d');
            await page.render({ canvasContext: context, viewport: view, canvas }).promise;
            return context.getImageData(0, 0, canvas.width, canvas.height);
          };
          const [oldImage, newImage] = await Promise.all([render(p), render(q)]);
          expect(newImage.width).toBe(oldImage.width);
          expect(newImage.height).toBe(oldImage.height);
          const width = oldImage.width,
            height = oldImage.height;
          const oldPixels = oldImage.data,
            newPixels = newImage.data;
          let changes = 0,
            outside = 0;
          // Mask derived BEFORE rendering, only the source spans (equal advances).
          const masks = n === 1 ? ops.map((op) => op.target.rect) : [];
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const offset = (y * width + x) * 4;
              if (
                oldPixels[offset] !== newPixels[offset] ||
                oldPixels[offset + 1] !== newPixels[offset + 1] ||
                oldPixels[offset + 2] !== newPixels[offset + 2] ||
                oldPixels[offset + 3] !== newPixels[offset + 3]
              ) {
                changes++;
                if (
                  !masks.some(
                    (r) =>
                      x >= Math.floor(r[0] * scale) - 1 &&
                      x <= Math.ceil(r[2] * scale) + 1 &&
                      y >= Math.floor(r[1] * scale) - 1 &&
                      y <= Math.ceil(r[3] * scale) + 1,
                  )
                )
                  outside++;
              }
            }
          expect(outside).toBe(0);
          if (n > 1) expect(changes).toBe(0);
          else expect(changes).toBeGreaterThan(0);
        }
      }
    } finally {
      await Promise.all(tasks.map((t) => t.destroy()));
    }
  }
}, 30000);

it('partial-word reconstruction leaves dense-table pixels identical in independent PDF.js rendering', async () => {
  const bytes = new Uint8Array(readFileSync('tests/fixtures/mixed-invoice.pdf')),
    model = inspectPDF(bytes),
    target = findTargets(model, 'pending')[0],
    operation = { target, replacement: 'reviewed' },
    proposal = proposeBatchPDF(bytes, [operation]).operations[0],
    output = applyBatchPDF(bytes, [operation]).bytes;
  const options = {
      useSystemFonts: false,
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
    },
    tasks = [
      getDocument({ data: bytes.slice(), ...options }),
      getDocument({ data: output.slice(), ...options }),
    ];
  try {
    const docs = await Promise.all(tasks.map((t) => t.promise)),
      pages = await Promise.all(docs.map((d) => d.getPage(1))),
      text = await pages[1].getTextContent();
    expect(
      text.items
        .filter((x) => 'str' in x)
        .map((x) => ('str' in x ? x.str : ''))
        .join(' '),
    ).toContain('reviewed');
    for (const scale of [1, 2, 4]) {
      const images = await Promise.all(
        pages.map(async (page) => {
          const viewport = page.getViewport({ scale }),
            canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
            context = canvas.getContext('2d');
          await page.render({ canvasContext: context, viewport, canvas }).promise;
          return context.getImageData(0, 0, canvas.width, canvas.height);
        }),
      );
      const [before, after] = images,
        regions = [target.rect, proposal.layoutRect!];
      let changed = 0,
        outside = 0;
      for (let y = 0; y < before.height; y++)
        for (let x = 0; x < before.width; x++) {
          const at = (y * before.width + x) * 4;
          if ([0, 1, 2].some((c) => before.data[at + c] !== after.data[at + c])) {
            changed++;
            if (
              !regions.some(
                (r) =>
                  x >= Math.floor(r[0] * scale) - 2 &&
                  x <= Math.ceil(r[2] * scale) + 2 &&
                  y >= Math.floor(r[1] * scale) - 2 &&
                  y <= Math.ceil(r[3] * scale) + 2,
              )
            )
              outside++;
          }
        }
      expect(changed).toBeGreaterThan(0);
      expect(outside).toBe(0);
    }
  } finally {
    await Promise.all(tasks.map((t) => t.destroy()));
  }
});
