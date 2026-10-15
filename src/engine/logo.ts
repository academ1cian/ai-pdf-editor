import { createWorker, PSM } from 'tesseract.js';
import { canvasImage, pngBytes } from './image-input';
let initializing = false;
export async function reconstructWordmark(
  bytes: Uint8Array,
  original: string,
  replacement: string,
) {
  if (!original.trim() || !replacement.trim() || original.length > 100 || replacement.length > 120)
    throw new Error('Enter the exact old and new logo wording (up to 120 characters).');
  const { canvas, ctx } = await canvasImage(bytes);
  if (initializing)
    throw new Error(
      'Local logo recognition is still loading. Your previous preview is available; use an uploaded replacement or reload before retrying.',
    );
  initializing = true;
  const ready = createWorker('eng', 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/core',
    langPath: '/ocr/lang',
    workerBlobURL: false,
    cacheMethod: 'none',
    errorHandler: () => {},
  }).finally(() => {
    initializing = false;
  });
  let worker: Awaited<typeof ready> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            'Local logo recognition timed out. Your previous preview is preserved; use an uploaded replacement or reload before retrying.',
          ),
        ),
      30000,
    );
  });
  let boxes: { x0: number; y0: number; x1: number; y1: number }[];
  try {
    worker = await Promise.race([ready, deadline]);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const { data } = await Promise.race([
      worker.recognize(
        new Blob([bytes.slice().buffer], { type: 'image/png' }),
        {},
        { blocks: true, text: true },
      ),
      deadline,
    ]);
    const words = (data.blocks || []).flatMap((b) =>
      b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)),
    );
    const parts = original.trim().toLocaleUpperCase().split(/\s+/);
    let matches = words.flatMap((w, i) =>
      words
        .slice(i, i + parts.length)
        .map((v) => v.text.replace(/[^\p{L}\p{N}]/gu, '').toLocaleUpperCase())
        .join(' ') === parts.join(' ')
        ? [words.slice(i, i + parts.length).map((v) => v.bbox)]
        : [],
    );
    if (!matches.length && parts.length === 1 && parts[0].length >= 5) {
      // OCR localizes stylized lettering; it never supplies the replacement spelling.
      // Permit a small, unique recognition error only for a reasonably long word.
      const distance = (a: string, b: string) => {
        let row = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
          const next = [i];
          for (let j = 1; j <= b.length; j++)
            next[j] = Math.min(
              next[j - 1] + 1,
              row[j] + 1,
              row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
          row = next;
        }
        return row[b.length];
      };
      const candidates = words.filter((w) => {
        const recognized = w.text.replace(/[^\p{L}\p{N}]/gu, '').toLocaleUpperCase();
        return (
          Math.abs(recognized.length - parts[0].length) <= 1 &&
          distance(recognized, parts[0]) <= Math.min(2, Math.floor(parts[0].length / 4))
        );
      });
      if (candidates.length === 1) matches = [[candidates[0].bbox]];
    }
    if (matches.length !== 1)
      throw new Error(
        'The exact old wordmark could not be located uniquely by local OCR. Use an uploaded replacement or select a clearer image.',
      );
    boxes = matches[0];
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(
          'Local logo recognition could not load. Your previous preview is preserved; use an uploaded replacement.',
        );
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate();
    else void ready.then((w) => w.terminate()).catch(() => {});
  }
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x0)) - 4),
    y0 = Math.max(0, Math.min(...boxes.map((b) => b.y0)) - 4),
    x1 = Math.min(canvas.width, Math.max(...boxes.map((b) => b.x1)) + 4),
    y1 = Math.min(canvas.height, Math.max(...boxes.map((b) => b.y1)) + 4);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
    ring: number[][] = [];
  const rgba = (x: number, y: number) =>
    Array.from(pixels.data.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4));
  for (let x = x0; x < x1; x++) {
    ring.push(rgba(x, y0));
    ring.push(rgba(x, y1 - 1));
  }
  for (let y = y0; y < y1; y++) {
    ring.push(rgba(x0, y));
    ring.push(rgba(x1 - 1, y));
  }
  const bg = [0, 1, 2, 3].map(
    (c) => ring.map((p) => p[c]).sort((a, b) => a - b)[Math.floor(ring.length / 2)],
  );
  if (ring.filter((p) => p.every((n, c) => Math.abs(n - bg[c]) < 15)).length < ring.length * 0.92)
    throw new Error(
      'The wordmark background is not uniform enough for a clean local reconstruction. Use an uploaded replacement.',
    );
  const ink: number[][] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = rgba(x, y);
      if (
        p[3] > 200 &&
        p.slice(0, 3).some((n, c) => Math.abs(n - bg[c]) > 60) &&
        p.slice(0, 3).some((n) => n > 45)
      )
        ink.push(p);
    }
  if (!ink.length) throw new Error('The wordmark color could not be measured.');
  const color = [0, 1, 2].map(
    (c) => ink.map((p) => p[c]).sort((a, b) => a - b)[Math.floor(ink.length / 2)],
  );
  // Erase the targeted pixels in the actual bitmap, including original antialiasing.
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) pixels.data.set(bg, (y * canvas.width + x) * 4);
  ctx.putImageData(pixels, 0, 0);
  const left = x0 + 2,
    right = canvas.width - 12,
    maxWidth = right - left;
  let bottom = canvas.height - 12;
  // New lettering may occupy only clear background below/alongside the old wordmark.
  for (let y = y1; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const p = rgba(x, y);
      if (p.some((n, c) => Math.abs(n - bg[c]) > 20)) {
        bottom = y - 4;
        break;
      }
    }
  let size = y1 - y0,
    rows: string[] = [];
  for (; size >= 12; size--) {
    ctx.font = `900 ${size}px Arial, sans-serif`;
    rows = [''];
    for (const word of replacement.split(/\s+/)) {
      const last = rows.at(-1)!,
        next = last ? last + ' ' + word : word;
      if (ctx.measureText(next).width <= maxWidth) rows[rows.length - 1] = next;
      else rows.push(word);
    }
    rows = rows.filter(Boolean);
    if (
      rows.every((r) => ctx.measureText(r).width <= maxWidth) &&
      rows.length * size * 1.12 <= bottom - y0
    )
      break;
  }
  if (size < 12)
    throw new Error('The replacement cannot fit readably while preserving the emblem.');
  ctx.font = `900 ${size}px Arial, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = `rgb(${color.join(',')})`;
  ctx.lineWidth = Math.max(0.8, size / 100);
  ctx.strokeStyle = `rgb(${color.map((c) => Math.round(c * 0.45)).join(',')})`;
  for (const [i, row] of rows.entries()) {
    const y = y0 + i * size * 1.12;
    ctx.strokeText(row, left, y);
    ctx.fillText(row, left, y);
  }
  return {
    bytes: await pngBytes(canvas),
    region: [x0, y0, right, Math.max(y1, y0 + rows.length * size * 1.12)] as [
      number,
      number,
      number,
      number,
    ],
    lines: rows,
  };
}
