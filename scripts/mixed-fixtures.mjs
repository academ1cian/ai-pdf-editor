import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
const require = createRequire(import.meta.url),
  canvasRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
const { createCanvas } = canvasRequire('@napi-rs/canvas');
const canvas = createCanvas(900, 380),
  ctx = canvas.getContext('2d');
ctx.fillStyle = 'white';
ctx.fillRect(0, 0, 900, 380);
ctx.fillStyle = '#203b79';
ctx.beginPath();
ctx.arc(140, 190, 105, 0, Math.PI * 2);
ctx.fill();
ctx.fillStyle = 'white';
ctx.font = 'bold 95px sans-serif';
ctx.fillText('ARC', 40, 220);
ctx.fillStyle = '#203b79';
ctx.font = 'bold 90px sans-serif';
ctx.fillText('ARC', 290, 145);
ctx.fillStyle = '#b29a58';
ctx.fillText('CARGO', 290, 265);
const logo = canvas.toBuffer('image/png');
await writeFile('tests/fixtures/invented-logo.png', logo);
const d = await PDFDocument.load(await readFile('tests/fixtures/dense-invoice-a.pdf')),
  f = await d.embedFont(StandardFonts.HelveticaBold),
  img = await d.embedPng(logo),
  p = d.getPage(0);
p.drawImage(img, { x: 40, y: 660, width: 190, height: 80 });
p.drawText('INVOICE', { x: 415, y: 740, size: 13, font: f });
p.drawText('DEMO-4172', { x: 478, y: 740, size: 10, font: f });
p.drawText('Status: pending', { x: 40, y: 610, size: 12, font: f });
// Reuse the same image resource on a separate page: selected-instance edits must preserve it.
d.getPage(1).drawImage(img, { x: 40, y: 710, width: 150, height: 63 });
await writeFile('tests/fixtures/mixed-invoice.pdf', await d.save({ useObjectStreams: false }));
const a = await PDFDocument.create(),
  af = await a.embedFont(StandardFonts.Helvetica),
  ap = a.addPage([612, 792]);
ap.drawRectangle({
  x: 40,
  y: 520,
  width: 250,
  height: 180,
  borderWidth: 1,
  borderColor: rgb(0, 0, 0),
});
ap.drawText('Cell text', { x: 50, y: 670, size: 12, font: af });
ap.drawText('Unrelated footer', { x: 40, y: 40, size: 12, font: af });
await writeFile('tests/fixtures/layout-region.pdf', await a.save());
