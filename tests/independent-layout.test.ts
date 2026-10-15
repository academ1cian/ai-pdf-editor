import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectPDF, proposePDF, applyPDF } from '../src/engine/pdf';
import { findTargets } from '../src/engine/model';
import { setFallbackFont } from '../src/engine/fonts';
const require = createRequire(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
  { createCanvas } = require('@napi-rs/canvas');
it('independent renderer checks wrapped Latin/Cyrillic text, untouched borders/footer and complete searchable content', async () => {
  setFallbackFont(new Uint8Array(readFileSync('src/assets/fonts/NotoSans-Regular.ttf')));
  const bytes = new Uint8Array(readFileSync('tests/fixtures/layout-region.pdf')),
    model = inspectPDF(bytes),
    target = findTargets(model, 'Cell text')[0];
  for (const replacement of [
    'A longer table cell with several carefully wrapped lines of complete selectable text.',
    'Длинный русский текст с несколькими строками для проверки',
  ]) {
    const proposal = proposePDF(bytes, { target, replacement }),
      output = applyPDF(bytes, { target, replacement });
    const options = {
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
      useSystemFonts: false,
    };
    const tasks = [
        getDocument({ data: bytes.slice(), ...options }),
        getDocument({ data: output.bytes.slice(), ...options }),
      ],
      docs = await Promise.all(tasks.map((t) => t.promise));
    try {
      const pages = await Promise.all(docs.map((d) => d.getPage(1))),
        contents = await Promise.all(pages.map((p) => p.getTextContent())),
        after = contents[1].items
          .filter((x) => 'str' in x)
          .map((x) => ('str' in x ? x.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ');
      expect(after).toContain(replacement);
      expect(after).not.toContain('Cell text');
      const beforeFooter = contents[0].items.find(
          (x) => 'str' in x && x.str === 'Unrelated footer',
        ),
        afterFooter = contents[1].items.find((x) => 'str' in x && x.str === 'Unrelated footer');
      if (!beforeFooter || !afterFooter || !('str' in beforeFooter) || !('str' in afterFooter))
        throw new Error('Footer missing');
      expect(afterFooter.str).toBe(beforeFooter.str);
      expect(afterFooter.transform).toEqual(beforeFooter.transform);
      expect(afterFooter.width).toBe(beforeFooter.width);
      expect(afterFooter.height).toBe(beforeFooter.height);
      for (const scale of [1, 2, 4]) {
        const images = await Promise.all(
          pages.map(async (p) => {
            const view = p.getViewport({ scale }),
              canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height)),
              context = canvas.getContext('2d');
            await p.render({ canvasContext: context, canvas, viewport: view }).promise;
            return context.getImageData(0, 0, canvas.width, canvas.height);
          }),
        );
        const a = images[0].data,
          b = images[1].data,
          w = images[0].width,
          h = images[0].height,
          r = proposal.layoutRect!;
        let changed = 0,
          outside = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const at = (y * w + x) * 4;
            if ([0, 1, 2].some((c) => Math.abs(a[at + c] - b[at + c]) > 12)) {
              changed++;
              if (
                x < Math.floor(r[0] * scale) - 2 ||
                x > Math.ceil(r[2] * scale) + 2 ||
                y < Math.floor(r[1] * scale) - 2 ||
                y > Math.ceil(r[3] * scale) + 2
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
  }
});
