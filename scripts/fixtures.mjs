// Synthetic, redistributable test documents. No real personal information.
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString } from 'pdf-lib';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
await mkdir('tests/fixtures', { recursive: true });
const cases = [
  ['01-paragraph', 'Helvetica', 12, 'The project status is pending.', 'pending', 'ready'],
  ['02-serif', 'TimesRoman', 14, 'John Smith', 'John Smith', 'Jane Doe'],
  ['03-monospace', 'Courier', 12, 'CODE: ABC123', 'ABC123', 'XYZ789'],
  ['04-large', 'Helvetica', 32, 'DRAFT', 'DRAFT', 'FINAL'],
  ['05-small', 'Helvetica', 8, 'Reference: INV-2025-12', '2025', '2026'],
  ['06-bold', 'HelveticaBold', 16, 'Sales Manager', 'Sales Manager', 'Team Lead'],
  ['07-italic', 'TimesRomanItalic', 14, 'A thoughtful sentence', 'thoughtful', 'clear'],
  ['08-bold-italic', 'HelveticaBoldOblique', 14, 'Review required', 'required', 'done'],
  ['09-shorter', 'Helvetica', 12, 'Alexander Hamilton', 'Alexander Hamilton', 'Alex'],
  ['10-longer-fits', 'Courier', 12, 'iiiiiiii', 'iiiiiiii', 'MMM'],
  ['11-overflow', 'Helvetica', 12, 'Amy', 'Amy', 'Alexandria Montgomery', 'unsupported'],
  ['12-duplicates', 'Helvetica', 12, 'John Smith', 'John Smith', 'Jane Doe', 'duplicate'],
  ['13-multipage', 'Helvetica', 12, 'Page one', 'pending', 'ready', 'multipage'],
  ['14-resume', 'Helvetica', 14, 'Jordan Example', 'Jordan Example', 'Robin Sample', 'resume'],
  ['15-invoice', 'Helvetica', 12, 'Invoice 2025-001', '2025', '2026', 'invoice'],
  ['16-table', 'Courier', 12, 'Widget A', 'Widget A', 'Gadget B', 'table'],
  ['17-vectors', 'Helvetica', 12, 'Status: pending', 'pending', 'ready', 'vectors'],
  ['18-neighbors', 'Helvetica', 12, 'John Smith', 'John Smith', 'Jane Doe', 'neighbors'],
  ['19-background', 'Helvetica', 14, 'Blue background', 'Blue', 'Teal', 'background'],
  ['20-hyperlink', 'Helvetica', 12, 'Visit example.org', 'Visit', 'See', 'link'],
  ['21-colored', 'Helvetica', 12, 'Approved later', 'later', 'now', 'color'],
  ['22-rotation', 'Helvetica', 14, 'Rotated target', 'Rotated', 'Updated', 'unsupported-rotation'],
  ['23-scanned', 'Helvetica', 12, '', 'missing', 'new', 'unsupported-scan'],
  ['24-form', 'Helvetica', 12, 'Form document', 'Form', 'Test', 'unsupported-form'],
  ['25-mixed-style', 'Helvetica', 12, 'Hello ', 'Hello world', 'Hi all', 'unsupported-mixed'],
  ['26-page-edge', 'Helvetica', 12, 'Edge target', 'target', 'text', 'edge'],
  ['27-empty-replacement', 'Helvetica', 12, 'Remove this word', 'this', '', 'delete'],
  [
    '28-paragraph-tight',
    'TimesRoman',
    11,
    'The report is pending today.',
    'pending',
    'ready',
    'paragraph',
  ],
];
const manifest = [];
for (const [id, fontName, size, text, target, replacement, kind = 'simple'] of cases) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts[fontName]);
  const page = doc.addPage([612, 792]);
  const y = kind === 'edge' ? 10 : 640;
  if (kind === 'background')
    page.drawRectangle({ x: 30, y: 610, width: 400, height: 70, color: rgb(0.82, 0.91, 0.97) });
  if (text)
    page.drawText(text, {
      x: 48,
      y,
      size,
      font,
      color: kind === 'color' ? rgb(0.2, 0.4, 0.7) : rgb(0.1, 0.12, 0.15),
      rotate: kind === 'unsupported-rotation' ? degrees(20) : degrees(0),
    });
  if (kind === 'duplicate') page.drawText(text, { x: 48, y: 580, size, font });
  if (kind === 'multipage') {
    const second = doc.addPage();
    second.drawText('Status: pending', { x: 48, y: 640, size, font });
  }
  if (kind === 'resume') {
    page.drawText('EXPERIENCE', { x: 48, y: 590, size: 10, font });
    page.drawText('Product designer | Example Studio', { x: 48, y: 565, size: 12, font });
    page.drawText('Built accessible tools for synthetic customers.', {
      x: 48,
      y: 540,
      size: 10,
      font,
    });
  }
  if (kind === 'invoice' || kind === 'table') {
    for (let i = 0; i < 4; i++) {
      page.drawLine({
        start: { x: 40, y: 610 - i * 30 },
        end: { x: 530, y: 610 - i * 30 },
        thickness: 0.5,
      });
    }
    page.drawText('Quantity     Unit cost     Total', { x: 48, y: 580, size: 10, font });
    page.drawText('2            10.00         20.00', { x: 48, y: 550, size: 10, font });
  }
  if (kind === 'vectors') {
    page.drawRectangle({
      x: 48,
      y: 400,
      width: 180,
      height: 100,
      borderColor: rgb(0.2, 0.5, 0.5),
      borderWidth: 3,
    });
    page.drawCircle({ x: 350, y: 450, size: 35, color: rgb(0.9, 0.6, 0.2) });
  }
  if (kind === 'neighbors')
    page.drawText('Keep this exactly', {
      x: 48 + font.widthOfTextAtSize(text, size) + 3,
      y,
      size,
      font,
    });
  if (kind === 'paragraph')
    page.drawText('A separate line must remain untouched.', { x: 48, y: 622, size, font });
  if (kind === 'unsupported-scan') {
    page.drawRectangle({ x: 48, y: 600, width: 300, height: 40, color: rgb(0.5, 0.5, 0.5) });
  }
  if (kind === 'unsupported-form')
    doc
      .getForm()
      .createTextField('synthetic-name')
      .addToPage(page, { x: 48, y: 500, width: 200, height: 24 });
  if (kind === 'unsupported-mixed')
    page.drawText('world', {
      x: 48 + font.widthOfTextAtSize(text, size),
      y,
      size,
      font: await doc.embedFont(StandardFonts.HelveticaBold),
    });
  if (kind === 'link') {
    const link = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [48, 635, 190, 655],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org') },
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  }
  await writeFile(`tests/fixtures/${id}.pdf`, await doc.save());
  manifest.push({
    id,
    target,
    replacement,
    page: kind === 'multipage' ? 1 : 0,
    occurrence: kind === 'duplicate' ? 1 : 0,
    expected:
      kind.startsWith('unsupported') || kind === 'unsupported' ? 'EXPECTED UNSUPPORTED' : 'PASS',
    category: kind,
  });
}
for (const [id, text, target, replacement, subset] of [
  ['29-embedded-full', 'Custom embedded font', 'Custom', 'Clear', false],
  ['30-embedded-subset', 'Subset font sample', 'Subset', 'Small', true],
  ['31-cyrillic', 'Привет, мир! Это пример.', 'Привет', 'Добрый', true],
]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(
    await readFile('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),
    { subset },
  );
  doc.addPage([612, 792]).drawText(text, { x: 48, y: 640, size: 14, font });
  await writeFile(`tests/fixtures/${id}.pdf`, await doc.save());
  manifest.push({
    id,
    target,
    replacement,
    page: 0,
    occurrence: 0,
    expected: 'EXPECTED UNSUPPORTED',
    category: 'embedded-font',
  });
}
await writeFile('tests/fixtures/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
await mkdir('public', { recursive: true });
const sample = await PDFDocument.create();
const bodyFont = await sample.embedFont(StandardFonts.Helvetica);
const bold = await sample.embedFont(StandardFonts.HelveticaBold);
const samplePage = sample.addPage([612, 792]);
const ink = rgb(0.15, 0.21, 0.19),
  muted = rgb(0.36, 0.43, 0.39),
  accent = rgb(0.16, 0.36, 0.29);
const textAt = (text, x, y, size = 10, font = bodyFont, color = ink) =>
  samplePage.drawText(text, { x, y, size, font, color });
samplePage.drawRectangle({ x: 0, y: 782, width: 612, height: 10, color: accent });
textAt('Jordan Example', 52, 714, 28, bold);
textAt('PRODUCT DESIGNER', 53, 688, 9, bold, accent);
textAt('jordan@example.org  /  portfolio.example.org  /  Chicago, IL', 53, 664, 9, bodyFont, muted);
samplePage.drawLine({
  start: { x: 52, y: 645 },
  end: { x: 560, y: 645 },
  thickness: 0.6,
  color: rgb(0.83, 0.87, 0.82),
});
textAt('PROFILE', 52, 614, 9, bold, accent);
textAt('A thoughtful designer turning complex workflows into clear, useful tools.', 52, 591, 11);
textAt('Six years of experience in document software and accessible interfaces.', 52, 573, 11);
textAt('EXPERIENCE', 52, 530, 9, bold, accent);
textAt('Senior Product Designer', 52, 502, 14, bold);
textAt('Example Studio', 52, 483, 10, bodyFont, muted);
textAt('2022 - Present', 448, 502, 9, bodyFont, muted);
for (const [y, t] of [
  [456, 'Led the design of a document workspace used by distributed teams.'],
  [437, 'Improved task completion through research, prototypes, and careful iteration.'],
  [418, 'Partnered with engineering to ship a consistent, accessible design system.'],
])
  textAt(t, 52, y, 10);
textAt('Product Designer', 52, 374, 14, bold);
textAt('Sample Company', 52, 355, 10, bodyFont, muted);
textAt('2020 - 2022', 458, 374, 9, bodyFont, muted);
textAt('Designed focused tools for reviewing, approving, and sharing information.', 52, 328, 10);
textAt('Translated customer feedback into practical improvements to daily work.', 52, 309, 10);
samplePage.drawLine({
  start: { x: 52, y: 278 },
  end: { x: 560, y: 278 },
  thickness: 0.6,
  color: rgb(0.83, 0.87, 0.82),
});
textAt('EDUCATION', 52, 249, 9, bold, accent);
textAt('Bachelor of Design', 52, 226, 11, bold);
textAt('Example University / 2020', 52, 207, 9, bodyFont, muted);
textAt('SKILLS', 345, 249, 9, bold, accent);
textAt('Interaction design / User research', 345, 226, 10);
textAt('Prototyping / Design systems', 345, 207, 10);
textAt('Accessibility / Product strategy', 345, 188, 10);
samplePage.drawRectangle({ x: 52, y: 72, width: 508, height: 48, color: rgb(0.95, 0.97, 0.94) });
textAt('A synthetic document, made for trying careful edits.', 65, 94, 9, bodyFont, muted);
textAt('No real personal or employment information.', 65, 81, 8, bodyFont, muted);
await writeFile('public/sample.pdf', await sample.save());
await copyFile(
  'node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION',
  'tests/fixtures/LICENSE-Liberation.txt',
);

const batchDoc = await PDFDocument.create();
const batchRegular = await batchDoc.embedFont(StandardFonts.Helvetica);
const batchBold = await batchDoc.embedFont(StandardFonts.HelveticaBold);
for (let n = 0; n < 3; n++) {
  const p = batchDoc.addPage([612, 792]);
  p.drawText('PROJECT OFFICE / DOCUMENT CONTROL', { x: 48, y: 744, size: 11, font: batchBold });
  p.drawText('INVOICE', { x: 412, y: 742, size: 13, font: batchBold });
  p.drawText('0089033', { x: 476, y: 742, size: 9.8, font: batchBold });
  p.drawText('DATE 10/13/2026', { x: 458, y: 724, size: 9.8, font: batchBold });
  p.drawText('ORDER NUMBER 0089033', { x: 417, y: 707, size: 9.8, font: batchBold });
  p.drawText('BILL TO', { x: 48, y: 665, size: 9, font: batchBold });
  p.drawText('Project Office', { x: 48, y: 644, size: 12, font: batchRegular });
  p.drawText('Document review and delivery', { x: 48, y: 623, size: 11, font: batchRegular });
  p.drawText('DESCRIPTION                         RATE         TOTAL', {
    x: 48,
    y: 565,
    size: 10,
    font: batchBold,
  });
  for (let i = 0; i < 4; i++)
    p.drawLine({
      start: { x: 44, y: 582 - i * 27 },
      end: { x: 565, y: 582 - i * 27 },
      thickness: 0.4,
    });
  p.drawText('Document preparation', { x: 48, y: 539, size: 10, font: batchRegular });
  p.drawText('1205.00', { x: 458, y: 539, size: 9.8, font: batchBold });
  p.drawText('90.00', { x: 530, y: 539, size: 9.8, font: batchBold });
  p.drawText('Review required', { x: 48, y: 448, size: 12, font: batchRegular });
  p.drawText('Delivery pending', { x: 48, y: 426, size: 12, font: batchRegular });
  p.drawText('Keep this reference unchanged: ARCHIVE-42', {
    x: 48,
    y: 250,
    size: 10,
    font: batchRegular,
  });
  p.drawText(`Page ${n + 1} / Synthetic invoice. No real business or payment data.`, {
    x: 48,
    y: 70,
    size: 9,
    font: batchRegular,
  });
}
const batchBytes = await batchDoc.save();
await writeFile('tests/fixtures/32-batch-invoice.pdf', batchBytes);
await writeFile('public/batch-sample.pdf', batchBytes);
manifest.push({
  id: '32-batch-invoice',
  target: '0089033',
  replacement: '1000',
  page: 0,
  occurrence: 0,
  expected: 'PASS',
  category: 'dense-invoice-batch',
});
await writeFile('tests/fixtures/manifest.json', JSON.stringify(manifest, null, 2) + '\n');

console.log(`Generated ${manifest.length} distinct synthetic fixtures.`);

// One focused, synthetic invoice for realistic numeric fitting and context regressions.
{
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
  const page=doc.addPage([612,792]);
  const text=(t,x,y,size=10)=>page.drawText(t,{x,y,size,font});
  const right=(t,x,y)=>text(t,x-font.widthOfTextAtSize(t,9.8),y,9.8);
  text('PROJECT OFFICE — SYNTHETIC INVOICE',40,720,14);
  for(const x of [350,400,470,560])page.drawLine({start:{x,y:440},end:{x,y:560},thickness:.5});
  for(const y of [440,480,505,530,560])page.drawLine({start:{x:350,y},end:{x:560,y},thickness:.5});
  text('QTY',360,540);text('RATE',420,540);text('CHARGES',490,540);
  right('1',380,515);right('1205.00',450,515);right('1205.00',540,515);
  right('1',380,490);right('90.00',450,490);right('90.00',540,490);
  text('TOTAL',405,455);right('1295.00',540,455);
  text('Payment terms: 30 days. Preserve this text.',40,390);
  const bytes=await doc.save();await writeFile('tests/fixtures/focused-invoice.pdf',bytes);
  await writeFile('public/focused-invoice.pdf',bytes);
}
