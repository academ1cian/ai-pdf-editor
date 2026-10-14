import { glyphsForTarget, union, type DocumentModel, type Rect } from '../engine/model';
export type FieldType = 'rate' | 'quantity' | 'weight' | 'charge' | 'fee' | 'subtotal' | 'total' | 'date' | 'invoice_id' | 'number' | 'text';
export interface ContextBlock {
  id:string; page:number; text:string; rect?:Rect; order?:number; complete?:boolean;
  lineId?:string; start?:number; end?:number; font?:string; size?:number; baseline?:number; format?:string;
  field?:{type:FieldType;label:string;row:string;column:string;role?:'line_item'|'fee'|'summary'|'unknown';description?:string};
}
const numeric=/^[$£€]?-?\d[\d,]*(?:\.\d+)?%?$/;
const date=/^(?:\d{1,2}[/-]){2}\d{2,4}$/;
const feeWords=/\b(fee|unl|unload(?:ing)?|fuel|surcharge|toll|accessorial|detention|tax|handling|additional)\b/i;
export function labelType(label:string):FieldType|undefined {
  if(/^(?:(?:grand\s+)?total(?:\s+(?:amount|due))?|balance(?:\s+due)?|amount\s+due)$/i.test(label))return 'total';
  if(/^subtotal$/i.test(label))return 'subtotal';
  if(feeWords.test(label)&&label.length<=32&&!/\d|[.!;:]/.test(label)&&!/^no\b|^without\b/i.test(label)&&label.split(/\s+/).length<=4)return 'fee';
  if(/^(?:unit\s*(?:price|cost)|rate)$/i.test(label))return 'rate';
  if(/^(?:qty|quantity|units)$/i.test(label))return 'quantity';
  if(/^weight$/i.test(label))return 'weight';
  if(/^(?:charges?|amount|line\s+total)$/i.test(label))return 'charge';
  if(/\bdate\b/i.test(label)&&label.length<=40&&!/\d|[.!;]/.test(label))return 'date';
  if(/^invoice(?:\s*(?:no\.?|number|#))?$/i.test(label))return 'invoice_id';
}
export function buildContext(model:DocumentModel,instruction:string,currentPage:number):ContextBlock[] {
  const runs:ContextBlock[]=[];
  for(const p of model.pages)for(const line of p.lines){
    const ranges:{start:number;end:number}[]=[];let start=0,offset=0;
    for(let i=0;i<line.glyphs.length;i++){
      const g=line.glyphs[i],prior=line.glyphs[i-1];
      if(prior && g.origin[0]-prior.rect[2]>Math.max(5,g.size*.8)){ranges.push({start,end:offset});start=offset;}
      offset+=g.text.length;
    }
    ranges.push({start,end:offset});
    const add=(a:number,b:number)=>{
      while(a<b && /\s/.test(line.text[a]))a++;
      while(b>a && /\s/.test(line.text[b-1]))b--;
      if(a===b)return;
      const glyphs=glyphsForTarget(line,{start:a,end:b});if(!glyphs.length)return;
      runs.push({id:a===0&&b===line.text.length?line.id:line.id+'r'+a+'e'+b,lineId:line.id,start:a,end:b,page:p.index+1,
        text:line.text.slice(a,b),rect:union(glyphs.map(g=>g.rect)),font:glyphs[0].font,size:glyphs[0].size,baseline:glyphs[0].origin[1]});
    };
    for(const r of ranges){
      const value=line.text.slice(r.start,r.end).trim();add(r.start,r.end);
      if(!numeric.test(value)&&!date.test(value)){
        const re=/(?:\d{1,2}[/-]){2}\d{2,4}|[$£€]?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?%?/g;
        for(const m of line.text.slice(r.start,r.end).matchAll(re)){
          const at=r.start+m.index!,following=at+m[0].length;
          if(/[A-Za-z]/.test(line.text[at-1]||'')||/[A-Za-z]/.test(line.text[following]||''))continue;
          const prefix=line.text.slice(r.start,at).trim();
          if(prefix&&labelType(prefix))add(r.start,r.start+m.index!);
          add(r.start+m.index!,r.start+m.index!+m[0].length);
        }
      }
    }
  }
  const blocks=runs.map(b=>{
    const rect=b.rect!;const isNumber=numeric.test(b.text),isDate=date.test(b.text);
    let label='',kind:FieldType=isDate?'date':isNumber?'number':'text';
    if(isNumber||isDate){
      const candidates=runs.filter(c=>c.page===b.page&&c!==b&&labelType(c.text)&&c.text.length<80)
        .map(c=>({c,left:Math.abs(c.rect![1]-rect[1])<5&&c.rect![2]<=rect[0]+.1,
          above:c.rect![3]<=rect[1]+.1&&rect[1]-c.rect![3]<200&&(!['date','invoice_id'].includes(labelType(c.text)||'')||rect[1]-c.rect![3]<35)&&Math.abs((c.rect![0]+c.rect![2]-rect[0]-rect[2])/2)<45}))
        .filter(c=>c.left||c.above).sort((a,z)=>
          (a.left?rect[0]-a.c.rect![2]-(['total','subtotal','date','invoice_id'].includes(labelType(a.c.text)||'')?1000:0):rect[1]-a.c.rect![3]+25-(['rate','charge','quantity','weight'].includes(labelType(a.c.text)||'')?100:0))-
          (z.left?rect[0]-z.c.rect![2]-(['total','subtotal','date','invoice_id'].includes(labelType(z.c.text)||'')?1000:0):rect[1]-z.c.rect![3]+25-(['rate','charge','quantity','weight'].includes(labelType(z.c.text)||'')?100:0)));
      label=candidates[0]?.c.text||'';
      kind=isDate?'date':labelType(label)||kind;
    }
    const baseline=b.baseline??rect[3]-(b.size||10)*.3;
    const row=runs.filter(c=>c.page===b.page&&Math.abs((c.baseline??c.rect![3]-(c.size||10)*.3)-baseline)<3 && c.id!==b.id);
    const description=row.filter(c=>!numeric.test(c.text)&&!date.test(c.text)&&(!labelType(c.text)||labelType(c.text)==='fee')&&c.rect![2]<rect[0])
      .map(c=>c.text).join(' ').slice(0,140);
    const isFee=feeWords.test(description)||kind==='fee';
    const weighted=row.some(c=>numeric.test(c.text)&&Number(c.text.replace(/,/g,''))>0&&
      runs.some(h=>h.page===c.page&&labelType(h.text)==='weight'&&h.rect![3]<=c.rect![1]&&c.rect![1]-h.rect![3]<200&&Math.abs((h.rect![0]+h.rect![2]-c.rect![0]-c.rect![2])/2)<35));
    const role:NonNullable<ContextBlock['field']>['role']=['total','subtotal'].includes(kind)?'summary':
      isFee?'fee':weighted||(/\b(freight|transport|delivery|shipment|line item)\b/i.test(description))?'line_item':'unknown';
    return {...b,format:isNumber?(b.text.startsWith('$')?'currency':b.text.includes('.')?'decimal':'integer'):isDate?'date':undefined,
      field:{type:kind,label,row:'p'+b.page+'y'+Math.round(baseline/3),column:label.toLowerCase(),role,description}};
  });
  // Same-baseline fields share the row key even when font metrics differ slightly.
  for(const b of blocks)if(b.field?.type==='charge'&&b.field.role==='unknown'){
    const neighbors=blocks.filter(c=>c.page===b.page&&Math.abs(c.rect![1]-b.rect![1])<4);
    const fee=neighbors.some(c=>c.field?.role==='fee');
    if(fee)b.field.role='fee';
  }
  const terms=instruction.toLowerCase().match(/[a-z]{3,}/g)||[];
  const financial=/rate|charge|amount|total|invoice|quantity|fee/i.test(instruction);
  const monetary=blocks.filter(b=>['rate','charge','fee','total','subtotal'].includes(b.field!.type));
  const ranked=blocks.map(b=>({b,score:(b.page===currentPage+1?3:0)+terms.filter(t=>(b.text+' '+b.field?.label).toLowerCase().includes(t)).length*4+(b.field?.type==='date'&&/date|October|November|December|January|February|March|April|May|June|July|August|September/i.test(instruction)?25:0)+
    (financial&&['rate','charge','fee','total','subtotal','quantity','weight'].includes(b.field!.type)?20:0)+
    (financial&&b.field!.description?5:0)})).sort((a,b)=>b.score-a.score);
  const chosen:ContextBlock[]=[];let used=0;
  for(const {b} of ranked){const cost=JSON.stringify(b).length;
    if(chosen.length>=50||used+cost>9000)continue;chosen.push(b);used+=cost;}
  const complete=monetary.every(b=>chosen.includes(b)) && !blocks.some(b=>b.field!.type==='number'&&/^\$?\d[\d,]*\.\d{2}$/.test(b.text));
  return chosen.sort((a,b)=>a.page-b.page||a.rect![1]-b.rect![1]||a.rect![0]-b.rect![0]).map((b,order)=>({...b,order,complete}));
}
