import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inspectPDF, proposePDF, applyPDF, renderPDF } from '../src/engine/pdf';
import { findTargets } from '../src/engine/model';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolve } from 'node:path';
import { setFallbackFont, type FontStyle } from '../src/engine/fonts';
for (const style of ['Regular', 'Bold', 'Italic', 'BoldItalic'] as FontStyle[])
  setFallbackFont(
    new Uint8Array(readFileSync('src/assets/fonts/NotoSans-' + style + '.ttf')),
    style,
  );
const fixtures = JSON.parse(readFileSync('tests/fixtures/manifest.json', 'utf8'));
mkdirSync('tests/evidence', { recursive: true });
const results = [];
for (const fixture of fixtures) {
  const bytes = new Uint8Array(readFileSync(`tests/fixtures/${fixture.id}.pdf`));
  const started = performance.now();
  try {
    const model = inspectPDF(bytes);
    const target = findTargets(model, fixture.target).filter((t) => t.page === fixture.page)[
      fixture.occurrence
    ];
    if (!target) {
      if (fixture.expected === 'EXPECTED UNSUPPORTED') {
        results.push({
          ...fixture,
          result: 'EXPECTED UNSUPPORTED',
          reason: 'No single-style selectable target span.',
        });
        continue;
      }
      throw new Error('Target not found');
    }
    const op = { target, replacement: fixture.replacement };
    const proposal = proposePDF(bytes, op);
    if (proposal.status !== 'SAFE_TO_APPLY') {
      results.push({
        ...fixture,
        result: fixture.expected === 'EXPECTED UNSUPPORTED' ? 'EXPECTED UNSUPPORTED' : 'FAIL',
        reason: proposal.message,
      });
      continue;
    }
    if (fixture.expected === 'EXPECTED UNSUPPORTED')
      throw new Error('Unsupported fixture was incorrectly accepted');
    const output = applyPDF(bytes, op);
    writeFileSync(`tests/evidence/${fixture.id}-edited.pdf`, output.bytes);
    const options = {
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
    };
    const task = getDocument({ data: output.bytes.slice(), ...options });
    const independent = await task.promise;
    if (independent.numPages !== model.pages.length)
      throw new Error('Independent page count mismatch');
    const page = await independent.getPage(fixture.page + 1);
    const text = await page.getTextContent();
    const content = text.items
      .filter((x): x is Extract<typeof x, { str: string }> => 'str' in x)
      .map((x) => x.str)
      .join(' ');
    if (
      fixture.replacement &&
      !content.replace(/\s/g, '').includes(fixture.replacement.replace(/\s/g, ''))
    )
      throw new Error('PDF.js did not find replacement: ' + content);
    const originalTask = getDocument({ data: bytes.slice(), ...options });
    const original = await originalTask.promise;
    const originalText = await (await original.getPage(fixture.page + 1)).getTextContent();
    if (
      !originalText.items
        .filter((x) => 'str' in x)
        .map((x) => ('str' in x ? x.str : ''))
        .join('')
        .replace(/\s/g, '')
        .includes(fixture.target.replace(/\s/g, ''))
    )
      throw new Error('Original changed');
    await originalTask.destroy();
    await task.destroy();
    writeFileSync(`tests/evidence/${fixture.id}-edited.pdf`, output.bytes);
    if (['01-paragraph', '14-resume', '19-background'].includes(fixture.id)) {
      writeFileSync(`tests/evidence/${fixture.id}-before.png`, renderPDF(bytes, fixture.page).png);
      writeFileSync(
        `tests/evidence/${fixture.id}-after.png`,
        renderPDF(output.bytes, fixture.page).png,
      );
    }
    results.push({
      ...fixture,
      result: 'PASS',
      validation: output.validation,
      independent: 'PDF.js reopened and extracted replacement',
      ms: Math.round(performance.now() - started),
    });
  } catch (e) {
    results.push({ ...fixture, result: 'FAIL', reason: String(e) });
  }
}
writeFileSync('tests/evidence/results.json', JSON.stringify(results, null, 2) + '\n');
for (const r of results)
  console.log(`${r.result.padEnd(22)} ${r.id} ${'reason' in r ? r.reason : ''}`);
const counts = results.reduce(
  (a, r) => ({ ...a, [r.result]: (a[r.result] || 0) + 1 }),
  {} as Record<string, number>,
);
console.log(counts);
if (counts.FAIL) process.exitCode = 1;
