export type Rect = [number, number, number, number];
export type Point = [number, number];
export type Status =
  'SAFE_TO_APPLY' | 'REQUIRES_USER_APPROVAL' | 'UNSUPPORTED' | 'VALIDATION_FAILED';
export interface Glyph {
  text: string;
  origin: Point;
  rect: Rect;
  font: string;
  size: number;
  color: number[];
}
export interface Line {
  id: string;
  text: string;
  rect: Rect;
  direction: Point;
  glyphs: Glyph[];
}
export interface PageModel {
  index: number;
  bounds: Rect;
  lines: Line[];
  warnings: string[];
}
export interface DocumentModel {
  revision?: string;
  pages: PageModel[];
  warnings: string[];
}
export interface Target {
  revision?: string;
  id: string;
  page: number;
  line: string;
  start: number;
  end: number;
  original: string;
  rect: Rect;
}
export interface Operation {
  target: Target;
  replacement: string;
}
export interface Proposal extends Operation {
  status: Status;
  message: string;
  font?: string;
  size?: number;
  width?: number;
  allowedWidth?: number;
  origin?: Point;
  layoutRect?: Rect;
  fitting?: 'original' | 'whitespace' | 'typography';
  alignment?: 'left' | 'right';
}
export interface Validation {
  status: 'SAFE_TO_APPLY';
  pageCount: number;
  changedPixels: number;
  outsidePixels: number;
  checkedPages: number;
  checks: string[];
}
export interface EditResult {
  bytes: Uint8Array;
  model: DocumentModel;
  validation: Validation;
}

export function normalize(text: string): string {
  return text.replace(/\u00a0/g, ' ');
}
export function union(rects: Rect[]): Rect {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}
export function overlaps(a: Rect, b: Rect, epsilon = 0.15): boolean {
  return (
    a[0] < b[2] - epsilon && a[2] > b[0] + epsilon && a[1] < b[3] - epsilon && a[3] > b[1] + epsilon
  );
}
export interface BatchProposal {
  status: Status;
  operations: Proposal[];
  message: string;
}
export function glyphsForTarget(line: Line, target: Pick<Target, 'start' | 'end'>): Glyph[] {
  let offset = 0;
  return line.glyphs.filter((g) => {
    const start = offset;
    offset += g.text.length;
    return start >= target.start && offset <= target.end;
  });
}
export function targetFromRange(
  model: DocumentModel,
  pageIndex: number,
  lineId: string,
  start: number,
  end: number,
): Target | undefined {
  const line = model.pages[pageIndex]?.lines.find((l) => l.id === lineId);
  if (
    !line ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > line.text.length
  )
    return;
  const glyphs = glyphsForTarget(line, { start, end });
  if (!glyphs.length || glyphs.map((g) => g.text).join('') !== line.text.slice(start, end)) return;
  return {
    revision: model.revision,
    id: `${model.revision || ''}:${pageIndex}:${lineId}:${start}:${end}`,
    page: pageIndex,
    line: lineId,
    start,
    end,
    original: line.text.slice(start, end),
    rect: union(glyphs.map((g) => g.rect)),
  };
}
export function findTargets(model: DocumentModel, query: string): Target[] {
  if (!query || query.length > 500) return [];
  const needle = normalize(query);
  const result: Target[] = [];
  for (const page of model.pages)
    for (const line of page.lines) {
      const text = normalize(line.text);
      let from = 0;
      while (from <= text.length - needle.length) {
        const start = text.indexOf(needle, from);
        if (start < 0) break;
        const end = start + needle.length;
        const target = targetFromRange(model, page.index, line.id, start, end);
        if (target) result.push(target);
        from = end;
      }
    }
  return result;
}

export class History {
  private snapshots: Uint8Array[];
  constructor(source: Uint8Array) {
    this.snapshots = [source.slice()];
  }
  get current() {
    return this.snapshots.at(-1)!.slice();
  }
  get length() {
    return this.snapshots.length - 1;
  }
  commit(bytes: Uint8Array) {
    if (
      this.snapshots.length >= 21 ||
      this.snapshots.reduce((n, s) => n + s.byteLength, 0) + bytes.byteLength > 80 * 1024 * 1024
    )
      throw new Error(
        'This session reached its history limit (20 edits or 80 MB). Download and reopen to continue.',
      );
    this.snapshots.push(bytes.slice());
  }
  undo() {
    if (this.length) this.snapshots.pop();
    return this.current;
  }
  reset() {
    this.snapshots = this.snapshots.slice(0, 1);
    return this.current;
  }
}
