import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url),
  tesseractRequire = createRequire(require.resolve('tesseract.js'));
const core = path.dirname(tesseractRequire.resolve('tesseract.js-core/package.json'));
await mkdir('public/ocr/core', { recursive: true });
await mkdir('public/ocr/lang', { recursive: true });
await copyFile(require.resolve('tesseract.js/dist/worker.min.js'), 'public/ocr/worker.min.js');
await copyFile(
  require.resolve('tesseract.js/dist/worker.min.js.LICENSE.txt'),
  'public/ocr/worker.min.js.LICENSE.txt',
);
for (const file of await readdir(core))
  if (/\.wasm(?:\.js)?$/.test(file))
    await copyFile(path.join(core, file), path.join('public/ocr/core', file));
await copyFile(
  require.resolve('@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'),
  'public/ocr/lang/eng.traineddata.gz',
);
await copyFile(path.join(core, 'LICENSE'), 'public/ocr/core/LICENSE');
