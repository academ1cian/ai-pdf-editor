import * as mupdf from 'mupdf';
import { lexContent } from './operands';
import { overlaps, type Rect, type DocumentModel } from './model';
export interface ImageStep {
  stream: number;
  start: number;
  end: number;
  key: string;
}
export interface ImageInstance {
  id: string;
  page: number;
  path: ImageStep[];
  rect: Rect;
  matrix: mupdf.Matrix;
  width: number;
  height: number;
  clipped: boolean;
  kind: 'image';
}
export interface ImageOperation {
  id: string;
  target: ImageInstance;
  action: 'replace' | 'remove' | 'place';
  bytes?: Uint8Array;
  rect?: Rect;
  wordmark?: {
    rect: Rect;
    text: string;
    color?: number[];
    background?: number[];
    base?: Uint8Array;
    wholeReplacement?: boolean;
    original?: string;
  };
}
const latin = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};
const rectFor = (m: mupdf.Matrix): Rect => {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
  return [
    Math.min(...pts.map((p) => p[0])),
    Math.min(...pts.map((p) => p[1])),
    Math.max(...pts.map((p) => p[0])),
    Math.max(...pts.map((p) => p[1])),
  ];
};
function contents(ref: mupdf.PDFObject): string[] {
  const refs: mupdf.PDFObject[] = [];
  if (ref.isArray()) ref.forEach((v) => refs.push(v));
  else refs.push(ref.get());
  try {
    return refs.map((r) => {
      const b = r.readStream();
      try {
        return latin(b.asUint8Array());
      } finally {
        b.destroy();
      }
    });
  } finally {
    refs.forEach((r) => r.destroy());
  }
}
export function inspectImages(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  revision = '',
): ImageInstance[] {
  const page = doc.loadPage(pageIndex),
    obj = page.getObject(),
    res = obj.getInheritable('Resources'),
    c = obj.get('Contents');
  const result: ImageInstance[] = [];
  const visit = (
    sources: string[],
    resources: mupdf.PDFObject,
    parent: mupdf.Matrix,
    path: ImageStep[],
    depth: number,
  ) => {
    if (depth > 8 || result.length > 100)
      throw new Error('Image nesting or instance count exceeds the safe editing limit.');
    let matrix = parent.slice() as mupdf.Matrix,
      clipped = false;
    const stack: { matrix: mupdf.Matrix; clipped: boolean }[] = [];
    for (let stream = 0; stream < sources.length; stream++) {
      let args: ReturnType<typeof lexContent> = [];
      for (const t of lexContent(sources[stream])) {
        if (
          t.kind !== 'word' ||
          /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(t.value) ||
          ['true', 'false', 'null'].includes(t.value)
        ) {
          args.push(t);
          continue;
        }
        if (t.value === 'q') stack.push({ matrix: matrix.slice() as mupdf.Matrix, clipped });
        if (t.value === 'Q') {
          const saved = stack.pop();
          if (!saved) throw new Error('Unbalanced image graphics state.');
          matrix = saved.matrix;
          clipped = saved.clipped;
        }
        if (t.value === 'cm') {
          const m = args.slice(-6).map((a) => Number(a.value));
          if (m.length !== 6 || !m.every(Number.isFinite))
            throw new Error('Invalid image transform.');
          matrix = mupdf.Matrix.concat(m as mupdf.Matrix, matrix);
        }
        if (t.value === 'W' || t.value === 'W*') clipped = true;
        if (t.value === 'Do' && args.length === 1 && args[0].kind === 'name') {
          const step = { stream, start: args[0].start, end: t.end, key: args[0].value },
            xobjects = resources.get('XObject'),
            ref = xobjects.get(step.key),
            subtype = ref.get('Subtype');
          try {
            if (subtype.asName() === 'Image') {
              const image = doc.loadImage(ref);
              try {
                result.push({
                  id:
                    `image:${revision}:${pageIndex}:` +
                    [...path, step].map((p) => p.stream + '-' + p.start).join('/'),
                  page: pageIndex,
                  path: [...path, step],
                  rect: rectFor(matrix),
                  matrix: matrix.slice() as mupdf.Matrix,
                  width: image.getWidth(),
                  height: image.getHeight(),
                  clipped,
                  kind: 'image',
                });
              } finally {
                image.destroy();
              }
            } else if (subtype.asName() === 'Form') {
              const own = ref.get('Resources'),
                fm = ref.get('Matrix'),
                bbox = ref.get('BBox'),
                b = ref.readStream();
              try {
                const values = fm.isArray() ? (fm.asJS() as mupdf.Matrix) : mupdf.Matrix.identity;
                // Form BBox remains in force through cloning. Mark transforms conservatively for movement.
                const previous = result.length;
                visit(
                  [latin(b.asUint8Array())],
                  own.isNull() ? resources : own,
                  mupdf.Matrix.concat(values, matrix),
                  [...path, step],
                  depth + 1,
                );
                if (!bbox.isNull()) for (const i of result.slice(previous)) i.clipped = true;
              } finally {
                own.destroy();
                fm.destroy();
                bbox.destroy();
                b.destroy();
              }
            }
          } finally {
            xobjects.destroy();
            ref.destroy();
            subtype.destroy();
          }
        }
        args = [];
      }
    }
  };
  try {
    visit(contents(c), res, page.getTransform(), [], 0);
    return result;
  } catch {
    return [];
  } finally {
    res.destroy();
    c.destroy();
    obj.destroy();
    page.destroy();
  }
}
function copyDict(doc: mupdf.PDFDocument, source: mupdf.PDFObject) {
  const dict = doc.newDictionary();
  source.forEach((v, k) => {
    try {
      dict.put(k, v);
    } finally {
      v.destroy();
    }
  });
  return dict;
}
export function extractImage(doc: mupdf.PDFDocument, target: ImageInstance): Uint8Array {
  const page = doc.loadPage(target.page),
    obj = page.getObject();
  let resources = obj.getInheritable('Resources');
  try {
    for (let i = 0; i < target.path.length; i++) {
      const x = resources.get('XObject'),
        ref = x.get(target.path[i].key);
      x.destroy();
      try {
        if (i === target.path.length - 1) {
          const image = doc.loadImage(ref),
            pix = image.toPixmap();
          try {
            return pix.asPNG().slice();
          } finally {
            pix.destroy();
            image.destroy();
          }
        }
        const own = ref.get('Resources');
        if (!own.isNull()) {
          resources.destroy();
          resources = own;
        } else own.destroy();
      } finally {
        ref.destroy();
      }
    }
    throw new Error('Image instance not found.');
  } finally {
    resources.destroy();
    obj.destroy();
    page.destroy();
  }
}
export function planImages(
  doc: mupdf.PDFDocument,
  model: DocumentModel,
  operations: ImageOperation[],
): ImageOperation[] {
  if (operations.length > 20) throw new Error('Use at most 20 image edits per transaction.');
  if (operations.reduce((n, op) => n + (op.bytes?.length || 0), 0) > 15 * 1024 * 1024)
    throw new Error('Keep combined replacement images below 15 MB.');
  let decodedPixels = 0;
  const ids = new Set<string>();
  return operations.map((op) => {
    const actual = inspectImages(doc, op.target.page, model.revision).find(
      (i) => i.id === op.target.id,
    );
    if (!actual || JSON.stringify(actual) !== JSON.stringify(op.target) || ids.has(actual.id))
      throw new Error('This image selection is stale or duplicated. Select it again.');
    ids.add(actual.id);
    if (!['replace', 'remove', 'place'].includes(op.action))
      throw new Error('Invalid image action.');
    const rect = op.rect || actual.rect,
      bounds = model.pages[actual.page].bounds;
    if (
      rect.some((n) => !Number.isFinite(n)) ||
      rect[2] - rect[0] < 2 ||
      rect[3] - rect[1] < 2 ||
      rect[0] < bounds[0] ||
      rect[1] < bounds[1] ||
      rect[2] > bounds[2] ||
      rect[3] > bounds[3]
    )
      throw new Error('Keep the image fully within the page at a readable size.');
    const moved = rect.some((n, i) => Math.abs(n - actual.rect[i]) > 0.01);
    if (
      moved &&
      (actual.clipped || Math.abs(actual.matrix[1]) > 0.01 || Math.abs(actual.matrix[2]) > 0.01)
    )
      throw new Error(
        'This image has clipping or rotation. Replacement preserves its transform; moving it is currently unsupported.',
      );
    if (
      moved &&
      model.pages[actual.page].lines.some((l) =>
        l.glyphs.some((g) => g.text.trim() && overlaps(g.rect, rect)),
      )
    )
      throw new Error('The image would collide with selectable text.');
    if (moved) {
      if (
        inspectImages(doc, actual.page, model.revision).some(
          (i) => i.id !== actual.id && overlaps(i.rect, rect),
        )
      )
        throw new Error('The image would collide with another image occurrence.');
      const page = doc.loadPage(actual.page),
        paths: Rect[] = [];
      const add = (path: mupdf.Path, ctm: mupdf.Matrix) => {
        let x = 0,
          y = 0,
          sx = 0,
          sy = 0;
        const point = (a: number, b: number) => [
          a * ctm[0] + b * ctm[2] + ctm[4],
          a * ctm[1] + b * ctm[3] + ctm[5],
        ];
        const line = (a: number, b: number) => {
          const p = point(x, y),
            q = point(a, b);
          paths.push([
            Math.min(p[0], q[0]) - 0.5,
            Math.min(p[1], q[1]) - 0.5,
            Math.max(p[0], q[0]) + 0.5,
            Math.max(p[1], q[1]) + 0.5,
          ]);
          x = a;
          y = b;
        };
        path.walk({
          moveTo: (a, b) => {
            x = sx = a;
            y = sy = b;
          },
          lineTo: line,
          curveTo: (a, b, c, d, e, f) => {
            const pts = [point(x, y), point(a, b), point(c, d), point(e, f)];
            paths.push([
              Math.min(...pts.map((p) => p[0])),
              Math.min(...pts.map((p) => p[1])),
              Math.max(...pts.map((p) => p[0])),
              Math.max(...pts.map((p) => p[1])),
            ]);
            x = e;
            y = f;
          },
          closePath: () => line(sx, sy),
        });
      };
      const device = new mupdf.Device({
        strokePath: (p, _s, m) => add(p, m),
        fillPath: (p, _e, m) => add(p, m),
      });
      try {
        page.runPageContents(device, mupdf.Matrix.identity);
      } finally {
        device.close();
        device.destroy();
        page.destroy();
      }
      if (
        paths.some(
          (r) =>
            overlaps(r, rect) &&
            (!overlaps(r, actual.rect) ||
              rect[0] < actual.rect[0] ||
              rect[1] < actual.rect[1] ||
              rect[2] > actual.rect[2] ||
              rect[3] > actual.rect[3]),
        )
      )
        throw new Error('The image would cross an unrelated border or artwork.');
    }
    if (op.action === 'replace') {
      if (!op.bytes || op.bytes.length > 8 * 1024 * 1024)
        throw new Error('Choose a PNG or JPEG below 8 MB.');
      const image = new mupdf.Image(op.bytes);
      try {
        decodedPixels += image.getWidth() * image.getHeight();
        if (decodedPixels > 24000000)
          throw new Error('Combined replacement images exceed the 24 megapixel transaction limit.');
        if (
          image.getWidth() * image.getHeight() > 16000000 ||
          image.getWidth() > 8192 ||
          image.getHeight() > 8192
        )
          throw new Error('Image exceeds the safe resolution limit.');
      } finally {
        image.destroy();
      }
    }
    if (op.wordmark) {
      const original = new mupdf.Image(op.wordmark.base || extractImage(doc, actual)),
        replacement = new mupdf.Image(op.bytes!),
        a = original.toPixmap(),
        b = replacement.toPixmap();
      try {
        if (a.getWidth() !== b.getWidth() || a.getHeight() !== b.getHeight())
          throw new Error(
            'Local logo reconstruction changed its image dimensions or transparency.',
          );
        const r = op.wordmark.rect,
          ap = a.getPixels(),
          bp = b.getPixels(),
          n = a.getNumberOfComponents(),
          bn = b.getNumberOfComponents(),
          w = a.getWidth();
        if (
          r.some((v) => !Number.isFinite(v)) ||
          r[0] < 0 ||
          r[1] < 0 ||
          r[2] > w ||
          r[3] > a.getHeight()
        )
          throw new Error('Invalid wordmark transformation region.');
        for (let y = 0; y < a.getHeight(); y++)
          for (let x = 0; x < w; x++)
            if (x < r[0] || x >= r[2] || y < r[1] || y >= r[3])
              for (let c = 0; c < 4; c++) {
                const ac =
                    c === 3
                      ? a.getAlpha()
                        ? ap[(y * w + x) * n + n - 1]
                        : 255
                      : ap[(y * w + x) * n + Math.min(c, n - a.getAlpha() - 1)],
                  bc =
                    c === 3
                      ? b.getAlpha()
                        ? bp[(y * w + x) * bn + bn - 1]
                        : 255
                      : bp[(y * w + x) * bn + Math.min(c, bn - b.getAlpha() - 1)];
                if (ac !== bc)
                  throw new Error(
                    'The local logo reconstruction changed pixels outside its planned wordmark region.',
                  );
              }
      } finally {
        a.destroy();
        b.destroy();
        original.destroy();
        replacement.destroy();
      }
    }
    return { ...op, target: actual, rect };
  });
}
function imageForPDF(bytes: Uint8Array): mupdf.Image {
  const image = new mupdf.Image(bytes),
    pix = image.toPixmap();
  try {
    if (pix.getAlpha()) {
      const n = pix.getNumberOfComponents(),
        pixels = pix.getPixels();
      let opaque = true;
      for (let i = n - 1; i < pixels.length; i += n)
        if (pixels[i] !== 255) {
          opaque = false;
          break;
        }
      // An all-opaque canvas PNG should not introduce a soft mask: MuPDF's image
      // interpolation path differs with a mask and can perturb unchanged edges.
      if (opaque) {
        const rgb = new mupdf.Pixmap(
            mupdf.ColorSpace.DeviceRGB,
            [0, 0, pix.getWidth(), pix.getHeight()],
            false,
          ),
          out = rgb.getPixels();
        for (let i = 0, j = 0; i < pixels.length; i += n, j += 3) {
          out[j] = pixels[i];
          out[j + 1] = pixels[i + Math.min(1, n - 2)];
          out[j + 2] = pixels[i + Math.min(2, n - 2)];
        }
        try {
          const result = new mupdf.Image(rgb);
          image.destroy();
          return result;
        } finally {
          rgb.destroy();
        }
      }
    }
    return image;
  } catch (e) {
    image.destroy();
    throw e;
  } finally {
    pix.destroy();
  }
}
export function applyImages(doc: mupdf.PDFDocument, operations: ImageOperation[]) {
  const pages = [...new Set(operations.map((o) => o.target.page))];
  for (const index of pages) {
    const page = doc.loadPage(index),
      obj = page.getObject(),
      oldRes = obj.getInheritable('Resources'),
      oldContent = obj.get('Contents');

    const rewrite = (
      sources: string[],
      resources: mupdf.PDFObject,
      edits: { op: ImageOperation; depth: number }[],
    ) => {
      const res = copyDict(doc, resources),
        oldX = resources.get('XObject'),
        xobjects = copyDict(doc, oldX);
      oldX.destroy();
      const patches: { stream: number; start: number; end: number; value: string }[] = [];
      let sequence = 0;
      const fresh = (prefix: string) => {
        for (;;) {
          const key = prefix + ++sequence,
            value = xobjects.get(key);
          try {
            if (value.isNull()) return key;
          } finally {
            value.destroy();
          }
        }
      };
      try {
        const groups = new Map<string, typeof edits>();
        for (const edit of edits) {
          const step = edit.op.target.path[edit.depth],
            key = step.stream + ':' + step.start;
          groups.set(key, [...(groups.get(key) || []), edit]);
        }
        for (const group of groups.values()) {
          const { op, depth } = group[0],
            step = op.target.path[depth];
          let code = '';
          if (depth < op.target.path.length - 1) {
            const ref = xobjects.get(step.key),
              inner = ref.get('Resources'),
              b = ref.readStream();
            try {
              const child = rewrite(
                  [latin(b.asUint8Array())],
                  inner.isNull() ? resources : inner,
                  group.map((e) => ({ ...e, depth: depth + 1 })),
                ),
                dict = copyDict(doc, ref);
              try {
                dict.delete('Length');
                dict.delete('Filter');
                dict.delete('DecodeParms');
                dict.put('Resources', child.res);
                const cloned = doc.addStream(
                    Uint8Array.from(child.sources[0], (c) => c.charCodeAt(0)),
                    dict,
                  ),
                  key = fresh('EditedForm');
                try {
                  xobjects.put(key, cloned);
                  code = '/' + key + ' Do';
                } finally {
                  cloned.destroy();
                }
              } finally {
                dict.destroy();
                child.res.destroy();
              }
            } finally {
              ref.destroy();
              inner.destroy();
              b.destroy();
            }
          } else if (op.action !== 'remove') {
            let key = step.key;
            if (op.action === 'replace') {
              const image = imageForPDF(op.bytes!),
                ref = doc.addImage(image);
              key = fresh('EditedImage');
              try {
                xobjects.put(key, ref);
              } finally {
                ref.destroy();
                image.destroy();
              }
            }
            const rect = op.rect!,
              old = op.target.rect;
            if (rect.some((n, i) => Math.abs(n - old[i]) > 0.01)) {
              const newMatrix: mupdf.Matrix = [
                rect[2] - rect[0],
                0,
                0,
                -(rect[3] - rect[1]),
                rect[0],
                rect[3],
              ];
              const delta = mupdf.Matrix.concat(newMatrix, mupdf.Matrix.invert(op.target.matrix));
              code = `q ${delta.join(' ')} cm /${key} Do Q`;
            } else code = '/' + key + ' Do';
          }
          patches.push({ ...step, value: code });
        }
        for (let i = 0; i < sources.length; i++)
          for (const p of patches.filter((p) => p.stream === i).sort((a, b) => b.start - a.start))
            sources[i] = sources[i].slice(0, p.start) + p.value + sources[i].slice(p.end);
        // Remove unused resource entries at this cloned scope. Shared occurrences still
        // retain their original resources in their own unmodified branch.
        const used = new Set<string>();
        for (const source of sources) {
          const tokens = lexContent(source);
          for (let i = 1; i < tokens.length; i++)
            if (tokens[i].value === 'Do' && tokens[i - 1].kind === 'name')
              used.add(tokens[i - 1].value);
        }
        const unused: string[] = [];
        xobjects.forEach((v, k) => {
          v.destroy();
          if (!used.has(String(k))) unused.push(String(k));
        });
        for (const key of unused) xobjects.delete(key);
        res.put('XObject', xobjects);
        return { res, sources };
      } catch (e) {
        res.destroy();
        throw e;
      } finally {
        xobjects.destroy();
      }
    };
    try {
      const edited = rewrite(
          contents(oldContent),
          oldRes,
          operations.filter((o) => o.target.page === index).map((op) => ({ op, depth: 0 })),
        ),
        array = doc.newArray();
      try {
        for (const source of edited.sources) {
          const stream = doc.addStream(
            Uint8Array.from(source, (c) => c.charCodeAt(0)),
            {},
          );
          try {
            array.push(stream);
          } finally {
            stream.destroy();
          }
        }
        obj.put('Resources', edited.res);
        obj.put('Contents', array);
      } finally {
        edited.res.destroy();
        array.destroy();
      }
    } finally {
      oldContent.destroy();
      oldRes.destroy();
      obj.destroy();
      page.destroy();
    }
  }
}

export function imageChangeRegions(op: ImageOperation): Rect[] {
  if (
    !op.wordmark ||
    op.wordmark.wholeReplacement ||
    op.rect?.some((v, i) => Math.abs(v - op.target.rect[i]) > 0.01)
  )
    return [op.target.rect, op.rect || op.target.rect];
  const r = op.wordmark.rect,
    m = op.target.matrix,
    pts = [
      [r[0], r[1]],
      [r[2], r[1]],
      [r[0], r[3]],
      [r[2], r[3]],
    ].map(([x, y]) => {
      x /= op.target.width;
      y = 1 - y / op.target.height;
      return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
    });
  return [
    [
      Math.min(...pts.map((p) => p[0])),
      Math.min(...pts.map((p) => p[1])),
      Math.max(...pts.map((p) => p[0])),
      Math.max(...pts.map((p) => p[1])),
    ],
  ];
}

export function normalizeImagePNG(bytes: Uint8Array) {
  const image = imageForPDF(bytes),
    pix = image.toPixmap();
  try {
    return pix.asPNG().slice();
  } finally {
    pix.destroy();
    image.destroy();
  }
}
