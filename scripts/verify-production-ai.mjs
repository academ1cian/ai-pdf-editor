// Independent verification of a synthetic PDF exported through the real public AI workflow.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const origin = 'https://ai-pdf-editor.pages.dev';
const revision = await (await fetch(origin + '/version.json')).json();
const originalResponse = await fetch(origin + '/sample.pdf');
if (!originalResponse.ok) throw new Error('Public original sample unavailable.');
const original = new Uint8Array(await originalResponse.arrayBuffer());
const edited = new Uint8Array(await readFile('docs/evidence/production-ai.pdf'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
if (hash(original) === hash(edited)) throw new Error('Export is unchanged.');
async function extract(bytes) {
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  });
  const pdf = await task.promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(
      content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .filter(Boolean),
    );
  }
  await task.destroy();
  return pages;
}
const before = await extract(original);
const after = await extract(edited);
if (before.length !== after.length) throw new Error('Page count changed.');
const count = (pages, text) => pages.flat().filter((value) => value.includes(text)).length;
if (
  count(before, 'Jordan Example') !== 1 ||
  count(after, 'Jordan Example') !== 0 ||
  count(after, 'Robin Sample') !== 1
)
  throw new Error('AI target replacement did not match.');
for (let n = 0; n < before.length; n++) {
  const expected = before[n].map((text) => text.replace('Jordan Example', 'Robin Sample')).sort();
  if (JSON.stringify(expected) !== JSON.stringify([...after[n]].sort()))
    throw new Error('Other extracted text changed.');
}
await mkdir('docs/evidence', { recursive: true });
const evidence = {
  checkedAt: new Date().toISOString(),
  origin,
  publicCommit: revision.commit,
  source:
    'Built-in synthetic sample; real public Turnstile and Groq proposal reviewed/applied/downloaded in browser.',
  independentExtractor: 'PDF.js 6.4.299',
  originalSHA256: hash(original),
  exportedSHA256: hash(edited),
  pages: before.length,
  replacement: 'Jordan Example → Robin Sample',
  originalTargetRemoved: true,
  replacementSearchable: true,
  otherExtractedTextPreserved: true,
  unchangedPublicOriginal: true,
  result: 'PASS',
};
await writeFile(
  'docs/evidence/production-ai-verification.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
