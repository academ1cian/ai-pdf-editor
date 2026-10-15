import * as mupdf from 'mupdf';
import type { Operation, Glyph } from './model';

// Conservative operand surgery. Only digit substitutions with identical advances
// qualify. All original operators, TJ adjustments, transforms and resources remain.
interface Token {
  start: number;
  end: number;
  kind: 'string' | 'name' | 'word' | 'delimiter';
  value: string;
}
const white = (c: string) => c === String.fromCharCode(0) || /[\t\n\f\r ]/.test(c);
const delimiter = (c: string) => /[()[\]<>/%]/.test(c);
export function lexContent(source: string): Token[] {
  if (source.length > 8 * 1024 * 1024)
    throw new Error('Content stream exceeds the safe parsing limit.');
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (tokens.length > 200000) throw new Error('Too many content tokens.');
    if (white(source[i])) {
      i++;
      continue;
    }
    if (source[i] === '%') {
      while (i < source.length && !/[\r\n]/.test(source[i])) i++;
      continue;
    }
    const start = i;
    if (source[i] === '(') {
      i++;
      let depth = 1,
        value = '';
      while (i < source.length && depth) {
        let c = source[i++];
        if (c === '\\') {
          c = source[i++];
          if (c === '\r' || c === '\n') {
            if (c === '\r' && source[i] === '\n') i++;
            continue;
          }
          if (/[0-7]/.test(c)) {
            let oct = c;
            while (oct.length < 3 && /[0-7]/.test(source[i] || 'x')) oct += source[i++];
            value += String.fromCharCode(parseInt(oct, 8) & 255);
          } else
            value +=
              ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c;
        } else if (c === '(') {
          depth++;
          value += c;
        } else if (c === ')') {
          if (--depth) value += c;
        } else if (c === '\r') {
          if (source[i] === '\n') i++;
          value += '\n';
        } else value += c;
      }
      if (depth) throw new Error('Unterminated PDF string.');
      tokens.push({ start, end: i, kind: 'string', value });
    } else if (source[i] === '<' && source[i + 1] !== '<') {
      i++;
      let hex = '';
      while (i < source.length && source[i] !== '>') {
        if (!white(source[i])) hex += source[i];
        i++;
      }
      if (source[i++] !== '>' || /[^a-f\d]/i.test(hex)) throw new Error('Invalid PDF hex string.');
      if (hex.length % 2) hex += '0';
      tokens.push({
        start,
        end: i,
        kind: 'string',
        value: hex.replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16))),
      });
    } else if (source[i] === '/') {
      i++;
      while (i < source.length && !white(source[i]) && !delimiter(source[i])) i++;
      tokens.push({
        start,
        end: i,
        kind: 'name',
        value: source
          .slice(start + 1, i)
          .replace(/#([a-f\d]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
      });
    } else if (delimiter(source[i])) {
      i++;
      if ((source[start] === '<' || source[start] === '>') && source[i] === source[start]) i++;
      tokens.push({ start, end: i, kind: 'delimiter', value: source.slice(start, i) });
    } else {
      while (i < source.length && !white(source[i]) && !delimiter(source[i])) i++;
      const value = source.slice(start, i);
      // Inline image data is binary, and must never be scanned as PDF tokens.
      if (value === 'BI')
        throw new Error('Inline image content requires another editing strategy.');
      tokens.push({ start, end: i, kind: 'word', value });
    }
  }
  return tokens;
}
function latin(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}
export interface OperandPatch {
  stream: number;
  start: number;
  end: number;
  replacement: string;
}
export interface OperandPlan {
  sources: string[];
  patches: OperandPatch[];
}

export function planOperands(
  doc: mupdf.PDFDocument,
  op: Operation,
  glyphs: Glyph[],
  remove = false,
): OperandPlan | undefined {
  if (
    !remove &&
    (!/^[$£€]?-?\d[\d,.]*$/.test(op.target.original) ||
      op.replacement.length !== op.target.original.length ||
      glyphs.length !== op.replacement.length)
  )
    return;
  // Punctuation and currency must stay put; only equal-width digits may change.
  for (let i = 0; !remove && i < op.replacement.length; i++)
    if (
      op.replacement[i] !== op.target.original[i] &&
      !(/^\d$/.test(op.replacement[i]) && /^\d$/.test(op.target.original[i]))
    )
      return;
  const page = doc.loadPage(op.target.page),
    obj = page.getObject(),
    contents = obj.get('Contents'),
    resources = obj.getInheritable('Resources'),
    fonts = resources.get('Font');
  const refs: mupdf.PDFObject[] = [];
  try {
    if (contents.isArray()) contents.forEach((v) => refs.push(v));
    else refs.push(contents.get());
    const sources = refs.map((ref) => {
      const b = ref.readStream();
      try {
        const bytes = b.asUint8Array();
        if (bytes.length > 8 * 1024 * 1024)
          throw new Error('Content stream exceeds the safe parsing limit.');
        return latin(bytes);
      } finally {
        b.destroy();
      }
    });
    if (sources.reduce((size, s) => size + s.length, 0) > 16 * 1024 * 1024) return;
    const candidates: OperandPatch[] = [];
    let fontKey = '',
      inText = false,
      fontSize = 0,
      charSpace = 0,
      wordSpace = 0;
    const stack: { fontKey: string; fontSize: number; charSpace: number; wordSpace: number }[] = [];
    for (let stream = 0; stream < sources.length; stream++) {
      const tokens = lexContent(sources[stream]);
      let args: Token[] = [];
      for (const token of tokens) {
        const operator =
          token.kind === 'word' &&
          !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token.value) &&
          !['true', 'false', 'null'].includes(token.value);
        if (!operator) {
          args.push(token);
          continue;
        }
        if (token.value === 'q') stack.push({ fontKey, fontSize, charSpace, wordSpace });
        if (token.value === 'Q') {
          if (!stack.length) return;
          ({ fontKey, fontSize, charSpace, wordSpace } = stack.pop()!);
        }
        if (token.value === 'BT') inText = true;
        if (token.value === 'ET') inText = false;
        if (token.value === 'Tf') {
          fontKey = args.at(-2)?.kind === 'name' ? args.at(-2)!.value : '';
          fontSize = Number(args.at(-1)?.value);
        }
        if (token.value === 'Tc') charSpace = Number(args.at(-1)?.value);
        if (token.value === 'Tw') wordSpace = Number(args.at(-1)?.value);
        if (inText && (remove ? ['Tj', 'TJ'] : ['Tj', 'TJ', "'", '"']).includes(token.value)) {
          const strings =
            token.value === 'TJ'
              ? args.filter((t) => t.kind === 'string')
              : args.slice(-1).filter((t) => t.kind === 'string');
          for (const str of strings)
            if (str.value === op.target.original) {
              const font = fonts.get(fontKey),
                base = font.get('BaseFont'),
                descriptor = font.get('FontDescriptor'),
                encoding = font.get('Encoding'),
                differences = encoding.isDictionary() ? encoding.get('Differences') : doc.newNull(),
                widths = font.get('Widths'),
                subtype = font.get('Subtype');
              try {
                // No CID fonts, custom digit encodings, embedded substitutes or custom widths.
                if (
                  base.asName() !== glyphs[0].font ||
                  !descriptor.isNull() ||
                  !differences.isNull() ||
                  (!encoding.isNull() &&
                    (!encoding.isName() ||
                      !['StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding'].includes(
                        encoding.asName(),
                      ))) ||
                  !widths.isNull() ||
                  subtype.asName() !== 'Type1' ||
                  ![
                    'Helvetica',
                    'Helvetica-Bold',
                    'Helvetica-Oblique',
                    'Helvetica-BoldOblique',
                    'Times-Roman',
                    'Times-Bold',
                    'Times-Italic',
                    'Times-BoldItalic',
                    'Courier',
                    'Courier-Bold',
                    'Courier-Oblique',
                    'Courier-BoldOblique',
                  ].includes(base.asName())
                )
                  return;
                const metrics = new mupdf.Font(base.asName());
                try {
                  for (let i = 0; !remove && i < str.value.length; i++)
                    if (
                      Math.abs(
                        metrics.advanceGlyph(metrics.encodeCharacter(str.value[i])) -
                          metrics.advanceGlyph(metrics.encodeCharacter(op.replacement[i])),
                      ) > 0.00001
                    )
                      return;
                } finally {
                  metrics.destroy();
                }
                let advance = 0;
                if (remove) {
                  if (!(fontSize > 0)) return;
                  const metrics = new mupdf.Font(base.asName());
                  try {
                    for (const c of str.value)
                      advance +=
                        metrics.advanceGlyph(metrics.encodeCharacter(c)) * 1000 +
                        ((charSpace + (c === ' ' ? wordSpace : 0)) / fontSize) * 1000;
                  } finally {
                    metrics.destroy();
                  }
                }
                candidates.push({
                  stream,
                  start: str.start,
                  end: remove && token.value === 'Tj' ? token.end : str.end,
                  replacement: remove
                    ? token.value === 'Tj'
                      ? `[] TJ [${-advance}] TJ`
                      : ` ${-advance} `
                    : '<' +
                      Array.from(op.replacement, (c) =>
                        c.charCodeAt(0).toString(16).padStart(2, '0'),
                      ).join('') +
                      '>',
                });
              } finally {
                font.destroy();
                base.destroy();
                descriptor.destroy();
                encoding.destroy();
                differences.destroy();
                widths.destroy();
                subtype.destroy();
              }
            }
        }
        args = [];
      }
    }
    // Exact complete operand, never substring/first-match. Ambiguous occurrences fall back.
    if (candidates.length !== 1) return;
    return { sources, patches: candidates };
  } catch {
    return;
  } finally {
    refs.forEach((r) => r.destroy());
    fonts.destroy();
    resources.destroy();
    contents.destroy();
    obj.destroy();
    page.destroy();
  }
}

export function applyOperands(doc: mupdf.PDFDocument, pageIndex: number, plans: OperandPlan[]) {
  const sources = plans[0].sources,
    patches = plans.flatMap((p) => p.patches);
  const page = doc.loadPage(pageIndex),
    obj = page.getObject(),
    contents = obj.get('Contents'),
    array = doc.newArray();
  try {
    for (let i = 0; i < sources.length; i++) {
      const edits = patches.filter((p) => p.stream === i).sort((a, b) => b.start - a.start);
      if (!edits.length) {
        const ref = contents.isArray() ? contents.get(i) : contents.get();
        try {
          array.push(ref);
        } finally {
          ref.destroy();
        }
        continue;
      }
      let source = sources[i],
        last = source.length;
      for (const edit of edits) {
        if (edit.end > last) throw new Error('Conflicting content operands.');
        source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
        last = edit.start;
      }
      // Copy-on-write avoids modifying content shared by another page or XObject.
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
    obj.put('Contents', array);
  } finally {
    array.destroy();
    contents.destroy();
    obj.destroy();
    page.destroy();
  }
}
