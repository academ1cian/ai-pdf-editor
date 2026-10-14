import type { AIPlan } from './schema';
import type { ContextBlock } from './context';
// Fixed-point millionths; no binary floating point arithmetic for money or quantities.
export function decimal(value: string): bigint {
  const clean=value.trim().replace(/^[$£€]/,'');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,6})?$/.test(clean)) throw new Error('Ambiguous numeric format.');
  const s=clean.replace(/,/g,''); const neg=s.startsWith('-'); const [whole,fraction='']=s.replace(/^-/,'').split('.');
  return (BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')))*(neg?-1n:1n);
}
function money(value: bigint, original: string) {
  const negative=value<0n; const cents=((negative?-value:value)+5000n)/10000n;
  return (original.match(/^[$£€]/)?.[0]||'')+(negative?'-':'')+(cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0');
}
export function clarifyIntent(blocks:ContextBlock[],instruction:string):string|undefined {
  const financial=/\b(rate|charges?|amount)\b/i.test(instruction) && !/\b(rename|heading|label|word)\b/i.test(instruction);
  if(!financial || /\b(first|second|third|last|all|both|row|item|line)\b/i.test(instruction))return;
  const wanted=blocks.filter(b=>(b.field?.type==='rate'&&/rate/i.test(instruction)) ||
    (b.field?.type==='charge'&&/charges?|amount/i.test(instruction)));
  const rates=wanted.filter(b=>b.field?.type==='rate').length,charges=wanted.filter(b=>b.field?.type==='charge').length;
  if(rates>1 || charges>1){
    const amounts=(instruction.match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)||[]).map(decimal);
    const explicitlyNamed=wanted.filter(b=>{try{return amounts.includes(decimal(b.text));}catch{return false;}});
    if(explicitlyNamed.length===0)return 'This context contains '+rates+' rate values and '+charges+' charge values. Which row(s) should be set to the requested amount, and should the other rows stay unchanged?';
  }
}
export function validateAnalysis(plan: AIPlan, blocks: ContextBlock[], instruction: string): AIPlan {
  const earlyQuestion=clarifyIntent(blocks,instruction);
  if(earlyQuestion)return {edits:[],clarification:earlyQuestion};
  const financial=/\b(rate|charges?|amount|total|subtotal|quantity)\b/i.test(instruction) && !/\b(rename|heading|label|word)\b/i.test(instruction);
  const clarify=(message:string):AIPlan=>({edits:[],clarification:message});
  if(plan.clarification?.trim()) return clarify(plan.clarification);
  if(financial && plan.edits.some(e=>!/^[$£€]?-?\d[\d,]*(?:\.\d+)?$/.test(e.original.trim())))
    return clarify('Which numeric row should change? Column headings will stay unchanged.');
  if(plan.edits.some(e=>e.ambiguity!=='none')) return clarify('Which occurrence or line item should these changes affect? Specify its row or page.');
  const resolved=plan.edits.map(e=>({e,b:blocks.find(b=>b.id===e.blockId&&b.page===e.page)}));
  for(const {e,b} of [...resolved].sort((a,b)=>(a.e.calculation?.operation==='sum'?1:0)-(b.e.calculation?.operation==='sum'?1:0))) {
    if(!b || !b.text.includes(e.original) || b.text.indexOf(e.original)!==b.text.lastIndexOf(e.original))
      return clarify('The target is not unique in the supplied context. Specify its row or page.');
    if(financial && !e.calculation) {
      const kind=b.field?.type;
      if(!kind || ['text','number'].includes(kind) ||
        (kind==='quantity'&&!/qty|quantity|units/i.test(instruction)) ||
        (kind==='rate'&&!/rate|unit\s*(price|cost)/i.test(instruction)) ||
        (kind==='charge'&&!/charges?|amount/i.test(instruction)))
        return clarify('Which labeled numeric field should change? The proposed value is not reliably associated with the requested label.');
      try {
        const requested=(instruction.match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)||[]).map(decimal);
        if(!requested.includes(decimal(e.replacement)))return clarify('Confirm the replacement amount for '+(e.label||e.original)+'. It was not specified in your instruction.');
      } catch { return clarify('Use an explicit numeric replacement and identify the row.'); }
    }
    if(e.calculation) {
      const refs=e.calculation.sources.map(s=>blocks.find(b=>b.id===s.blockId&&b.page===s.page&&b.text.trim()===s.original));
      if(refs.some(b=>!b) || new Set(refs.map(b=>b!.id)).size!==refs.length) return clarify('The calculation sources could not be uniquely established.');
      const source=refs as ContextBlock[];
      // Reliable narrow relationships only: a row's rate × quantity, or every visible charge's sum.
      const product=e.calculation.operation==='product' && b.field?.type==='charge' && source.length===2 &&
        source.some(s=>s.field?.type==='rate') && source.some(s=>s.field?.type==='quantity') &&
        source.every(s=>s.page===b.page && s.field?.row===b.field?.row);
      const allCharges=blocks.filter(s=>s.field?.type==='charge');
      const sum=blocks.every(s=>s.complete===true) && e.calculation.operation==='sum' && ['total','subtotal'].includes(b.field?.type||'') &&
        source.every(s=>s.field?.type==='charge' && s.page===b.page) &&
        allCharges.length===source.length && allCharges.every(s=>source.includes(s));
      if(!product&&!sum) return clarify('Which line items, quantities, and fees make up the total? The arithmetic relationship is not established.');
      const values=source.map(s=>decimal(s.text));
      const calc=(xs:bigint[])=>product ? xs[0]*xs[1]/1000000n : xs.reduce((a,b)=>a+b,0n);
      if(calc(values)!==decimal(e.original)) return clarify('The original amounts do not reconcile. Confirm which fields make up this calculation.');
      const changed=source.map(s=>resolved.find(r=>r.b?.id===s.id&&r.e.original===s.text.trim())?.e.replacement||s.text);
      const result=calc(changed.map(decimal));
      e.replacement=money(result,e.original);
      e.explanation+=' Calculation: '+changed.join(product?' × ':' + ')+' = '+e.replacement+'. Verify the source fields before approval.';
    }
  }
  if(financial && /\b(accordingly|recalculate|recompute)\b/i.test(instruction) && !plan.edits.some(e=>e.calculation))
    return clarify('Which line item should be set to 1000, and which amounts make up the total? No financial values have been changed.');
  return plan;
}
