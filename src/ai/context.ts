import type { DocumentModel, Rect } from '../engine/model';
export type FieldType = 'rate' | 'quantity' | 'charge' | 'subtotal' | 'total' | 'number' | 'text';
export interface ContextBlock {
  id: string; page: number; text: string; rect?: Rect; order?: number;
  field?: { type: FieldType; label: string; row: string; column: string };
}
const number = /^[$£€]?-?\d[\d,]*(?:\.\d+)?%?$/;
export function buildContext(model: DocumentModel, instruction: string, currentPage: number): ContextBlock[] {
  const terms = instruction.toLowerCase().match(/[a-z]{3,}/g) || [];
  const financial = /\b(rate|charges?|amount|total|quantity|invoice|subtotal)\b/i.test(instruction);
  const blocks = model.pages.flatMap(p => p.lines.filter(l=>l.text.trim()).map((line,order) => {
    const numeric = number.test(line.text.trim());
    let label = '';
    if (numeric) {
      const candidates = p.lines.filter(l=>l!==line && !number.test(l.text.trim()) && l.text.length<65)
        .map(l=>({l, left: Math.abs(l.rect[1]-line.rect[1])<5 && l.rect[2]<line.rect[0],
          above: l.rect[3]<=line.rect[1] && line.rect[1]-l.rect[3]<160 && Math.abs((l.rect[0]+l.rect[2]-line.rect[0]-line.rect[2])/2)<45}))
        .filter(c=>c.left||c.above).sort((a,b)=>
          (a.left ? line.rect[0]-a.l.rect[2] : line.rect[1]-a.l.rect[3]+25)-
          (b.left ? line.rect[0]-b.l.rect[2] : line.rect[1]-b.l.rect[3]+25));
      label=candidates[0]?.l.text.trim() || '';
    }
    const type: FieldType = !numeric ? 'text' : /subtotal/i.test(label) ? 'subtotal' : /total|balance/i.test(label) ? 'total' :
      /rate|unit\s*(?:price|cost)/i.test(label) ? 'rate' : /qty|quantity|units/i.test(label) ? 'quantity' :
      /charge|amount/i.test(label) ? 'charge' : 'number';
    return {id:line.id,page:p.index+1,text:line.text.slice(0,1500),rect:line.rect,order,
      field:{type,label,row:'p'+p.index+'y'+Math.round(line.glyphs[0]?.origin[1]/5),column:label.toLowerCase()},
      score:(p.index===currentPage?4:0)+terms.filter(t=>line.text.toLowerCase().includes(t)).length*8+(financial&&numeric?8:0)};
  }));
  const chosen: typeof blocks = [];
  let size=0;
  for (const b of [...blocks].sort((a,b)=>b.score-a.score)) {
    const cost=JSON.stringify(b).length;
    if(chosen.length>=50 || size+cost>11000) continue;
    chosen.push(b); size+=cost;
  }
  return chosen.sort((a,b)=>a.page-b.page || (a.rect[1]-b.rect[1]) || a.rect[0]-b.rect[0]).map(b=>({id:b.id,page:b.page,text:b.text,rect:b.rect,order:b.order,field:b.field}));
}
