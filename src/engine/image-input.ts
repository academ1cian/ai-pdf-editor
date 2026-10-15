export async function canvasImage(bytes: Uint8Array, type = 'image/png') {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.width ||
      !image.height ||
      image.width * image.height > 16000000 ||
      image.width > 8192 ||
      image.height > 8192
    )
      throw new Error('Use an image up to 16 megapixels and 8192 pixels per side.');
    const canvas = document.createElement('canvas');
    const scale =
      type === 'image/svg+xml'
        ? Math.min(
            4,
            4096 / image.width,
            4096 / image.height,
            Math.sqrt(16000000 / (image.width * image.height)),
          )
        : 1;
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, ctx };
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function pngBytes(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))),
      'image/png',
    ),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
export function sanitizeSVG(source: string): string {
  if (source.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('SVG declarations and entities are not allowed.');
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg')
    throw new Error('Invalid SVG.');
  const tags = new Set([
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'defs',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'title',
    'desc',
  ]);
  const attrs = new Set([
    'xmlns',
    'width',
    'height',
    'viewBox',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
    'points',
    'transform',
    'fill',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'opacity',
    'id',
    'offset',
    'stop-color',
    'stop-opacity',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'clip-path',
    'clip-rule',
    'fill-rule',
    'mask',
    'maskUnits',
    'preserveAspectRatio',
  ]);
  for (const el of xml.querySelectorAll('*')) {
    if (!tags.has(el.localName))
      throw new Error(
        'SVG contains unsupported active, text, or external content. Export a PNG instead.',
      );
    for (const a of [...el.attributes]) {
      if (a.name === 'xmlns' && a.value === 'http://www.w3.org/2000/svg') continue;
      if (
        !attrs.has(a.name) ||
        /javascript:|data:|https?:|@import|expression\(/i.test(a.value) ||
        (/url\(/i.test(a.value) && !/^url\(#[a-zA-Z0-9_-]+\)$/.test(a.value))
      )
        throw new Error('SVG contains an unsafe reference or attribute.');
    }
  }
  const root = xml.documentElement;
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!root.getAttribute('width') || !root.getAttribute('height')) {
    const box = root.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number);
    if (!box || box.length !== 4 || !box.every(Number.isFinite))
      throw new Error('SVG needs dimensions or a viewBox.');
    root.setAttribute('width', String(Math.min(2048, box[2])));
    root.setAttribute('height', String(Math.min(2048, box[3])));
  }
  const width = Number(root.getAttribute('width')?.replace(/px$/, '')),
    height = Number(root.getAttribute('height')?.replace(/px$/, ''));
  if (!(width > 0 && height > 0) || width > 4096 || height > 4096 || width * height > 16000000)
    throw new Error('SVG dimensions exceed the safe limit.');
  return new XMLSerializer().serializeToString(xml);
}
export async function readImageFile(file: File): Promise<Uint8Array> {
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or SVG below 8 MB.');
  let bytes = new Uint8Array(await file.arrayBuffer()),
    type = 'image/png';
  if (/\.svg$/i.test(file.name)) {
    bytes = new TextEncoder().encode(sanitizeSVG(new TextDecoder().decode(bytes)));
    type = 'image/svg+xml';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) type = 'image/jpeg';
  else if (!(bytes[0] === 137 && new TextDecoder().decode(bytes.slice(1, 4)) === 'PNG'))
    throw new Error('Only PNG, JPEG, and sanitized SVG images are supported.');
  if (type !== 'image/svg+xml') {
    let width = 0,
      height = 0;
    if (type === 'image/png') {
      if (bytes.length < 24) throw new Error('Invalid PNG.');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      width = view.getUint32(16);
      height = view.getUint32(20);
    } else {
      let at = 2;
      while (at + 9 < bytes.length && at < 1000000) {
        if (bytes[at] !== 255) break;
        const marker = bytes[at + 1];
        at += 2;
        if (marker === 216 || marker === 217) continue;
        const length = (bytes[at] << 8) | bytes[at + 1];
        if (length < 2 || at + length > bytes.length) break;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
          height = (bytes[at + 3] << 8) | bytes[at + 4];
          width = (bytes[at + 5] << 8) | bytes[at + 6];
          break;
        }
        at += length;
      }
    }
    if (!(width > 0 && height > 0) || width > 8192 || height > 8192 || width * height > 16000000)
      throw new Error('Invalid image dimensions or resolution above the 16 megapixel limit.');
  }
  const { canvas } = await canvasImage(bytes, type);
  return pngBytes(canvas);
}
