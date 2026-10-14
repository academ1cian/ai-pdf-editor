export type Rect = [number, number, number, number];
export type Point = [number, number];
export type Status = 'SAFE_TO_APPLY' | 'REQUIRES_USER_APPROVAL' | 'UNSUPPORTED' | 'VALIDATION_FAILED';
export interface Glyph { text: string; origin: Point; rect: Rect; font: string; size: number; color: number[] }
export interface Line { id: string; text: string; rect: Rect; direction: Point; glyphs: Glyph[] }
export interface PageModel { index: number; bounds: Rect; lines: Line[]; warnings: string[] }
export interface DocumentModel { pages: PageModel[]; warnings: string[] }
export interface Target { id: string; page: number; line: string; start: number; end: number; original: string; rect: Rect }
export interface Operation { target: Target; replacement: string }
export interface Proposal extends Operation { status: Status; message: string; font?: string; size?: number; width?: number; allowedWidth?: number }
export interface Validation { status: 'SAFE_TO_APPLY'; pageCount: number; changedPixels: number; outsidePixels: number; checkedPages: number; checks: string[] }
export interface EditResult { bytes: Uint8Array; model: DocumentModel; validation: Validation }

export function normalize(text: string): string { return text.replace(/\u00a0/g, ' '); }
export function union(rects: Rect[]): Rect {
  return [Math.min(...rects.map(r=>r[0])),Math.min(...rects.map(r=>r[1])),Math.max(...rects.map(r=>r[2])),Math.max(...rects.map(r=>r[3]))];
}
export function overlaps(a: Rect,b: Rect, epsilon=0.15): boolean {
  return a[0]<b[2]-epsilon && a[2]>b[0]+epsilon && a[1]<b[3]-epsilon && a[3]>b[1]+epsilon;
}
export function findTargets(model: DocumentModel, query: string): Target[] {
  if (!query || query.length>500) return [];
  const needle=normalize(query); const result: Target[]=[];
  for(const page of model.pages) for(const line of page.lines) {
    const text=normalize(line.text); let from=0;
    while(from<=text.length-needle.length) {
      const start=text.indexOf(needle,from); if(start<0) break;
      const end=start+needle.length;
      result.push({id:`${page.index}:${line.id}:${start}:${end}`,page:page.index,line:line.id,start,end,original:line.text.slice(start,end),rect:union(line.glyphs.slice(start,end).map(g=>g.rect))});
      from=end;
    }
  }
  return result;
}

export class History {
  private snapshots: Uint8Array[];
  constructor(source: Uint8Array) { this.snapshots=[source.slice()]; }
  get current() { return this.snapshots.at(-1)!.slice(); }
  get length() { return this.snapshots.length-1; }
  commit(bytes: Uint8Array) { if(this.snapshots.length>=21 || this.snapshots.reduce((n,s)=>n+s.byteLength,0)+bytes.byteLength>80*1024*1024) throw new Error('This session reached its history limit (20 edits or 80 MB). Download and reopen to continue.'); this.snapshots.push(bytes.slice()); }
  undo() { if(this.length) this.snapshots.pop(); return this.current; }
  reset() { this.snapshots=this.snapshots.slice(0,1); return this.current; }
}
