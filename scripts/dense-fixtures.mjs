// Invented invoices; exercises original TJ arrays and metric-box collisions.
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
export async function denseFixture({ name, description, rate, fee, y = 500 }) {
  const d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.HelveticaBold),
    p = d.addPage([612, 792]);
  const resources = d.context.obj({ Font: { F1: font.ref } });
  p.node.set(PDFName.of('Resources'), resources);
  const hex = (s) => '<' + Buffer.from(s, 'ascii').toString('hex') + '>';
  const row = (at, desc, weight, amount) => {
    const texts = [desc, weight, '1.0000', amount.toFixed(4), amount.toFixed(2)],
      xs = [42, 310, 390, 445, 537];
    let stream = `BT /F1 10 Tf 0.99 0 0 1 42 ${at} Tm [`;
    for (let i = 0; i < texts.length; i++) {
      if (i) {
        const advance = font.widthOfTextAtSize(texts[i - 1], 10);
        stream += `${(-((xs[i] - xs[i - 1]) / 0.99 - advance) * 1000) / 10} `;
      }
      stream += hex(texts[i]) + ' ';
    }
    return stream + '] TJ ET\n';
  };
  let s = 'q 0.24 0 0 0.24 0 0 cm q 4.1666666667 0 0 4.1666666667 0 0 cm\n';
  for (const [text, x] of [
    ['DESCRIPTION', 42],
    ['WEIGHT', 310],
    ['UNITS', 390],
    ['RATE', 445],
    ['CHARGES', 537],
  ])
    s += `BT /F1 10 Tf 1 0 0 1 ${x} ${y + 25} Tm (${text}) Tj ET\n`;
  s += `0.5 w 35 ${y + 15} m 585 ${y + 15} l S\n`;
  s += row(y, description, '51780.2', rate);
  // Lower baseline only 12pt away: bounding boxes overlap, visible shapes don't.
  s += `BT /F1 10 Tf 0.99 0 0 1 455 ${y - 12} Tm (Flat rate) Tj ET\n`;
  s += row(y - 40, 'Handling fee', '', fee);
  s += `BT /F1 11.5 Tf 1 0 0 1 300 65 Tm (PLEASE PAY THIS AMOUNT) Tj 1 0 0 1 528 65 Tm [${hex('$' + (rate + fee).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}] TJ ET\nQ Q`;
  const stream = d.context.flateStream(s);
  p.node.set(PDFName.of('Contents'), d.context.register(stream));
  // Generated image-only attachments; no extracted text, original pixels preserved.
  const png = await import('node:zlib').then(({ deflateSync }) => {
    const crc = (b) => {
      let c = 0xffffffff;
      for (const v of b) {
        c ^= v;
        for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
      const t = Buffer.from(type),
        len = Buffer.alloc(4),
        sum = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      sum.writeUInt32BE(crc(Buffer.concat([t, data])));
      return Buffer.concat([len, t, data, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(64, 0);
    ihdr.writeUInt32BE(64, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc((64 * 3 + 1) * 64, 255);
    for (let y = 0; y < 64; y++) {
      raw[y * 193] = 0;
      for (let x = 0; x < 64; x++)
        if (x % 8 < 2 || y % 12 < 2) raw.fill(80, y * 193 + 1 + x * 3, y * 193 + 4 + x * 3);
    }
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  });
  const image = await d.embedPng(png);
  for (let i = 0; i < 2; i++)
    d.addPage([612, 792]).drawImage(image, { x: 40 + i * 5, y: 200, width: 500, height: 500 });
  // Keep object structure straightforward; mutations still handle compressed streams.
  const bytes = await d.save({ useObjectStreams: false });
  await writeFile(`tests/fixtures/${name}.pdf`, bytes);
}
await denseFixture({
  name: 'dense-invoice-a',
  description: 'Synthetic glass crates',
  rate: 1487,
  fee: 65,
  y: 500,
});
await denseFixture({
  name: 'dense-invoice-b',
  description: 'Fictional paper rolls',
  rate: 2378,
  fee: 125,
  y: 450,
});
