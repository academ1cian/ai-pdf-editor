import type { AIPlan } from './schema';
import type { ContextBlock } from './context';
// Fixed-point millionths; no binary floating point arithmetic for money or quantities.
export function decimal(value: string): bigint {
  const clean=value.trim().replace(/^[$£€]/,'');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,6})?$/.test(clean)) throw new Error('Ambiguous numeric format.');
  const s=clean.replace(/,/g,''); const neg=s.startsWith('-'); const [whole,fraction='']=s.replace(/^-/,'').split('.');
  return (BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')))*(neg?-1n:1n);
}
export function formatNumber(value:bigint,original:string):string {
  const digits=Math.min(6,original.replace(/,/g,'').match(/\.(\d+)/)?.[1].length||0);
  const scale=10n**BigInt(6-digits),negative=value<0n,rounded=((negative?-value:value)+scale/2n)/scale;
  const base=10n**BigInt(digits);let whole=(rounded/base).toString();
  if(original.includes(','))whole=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return (original.match(/^[$£€]/)?.[0]||'')+(negative?'-':'')+whole+(digits?'.'+(rounded%base).toString().padStart(digits,'0'):'');
}
// Semantic alternatives belong in the reviewed plan; mere field count is not an ambiguity.
export function clarifyIntent(blocks:ContextBlock[],instruction:string):string|undefined {
  if(/rate|charges?/i.test(instruction)&&!blocks.some(b=>['rate','charge'].includes(b.field?.type||'')))return 'I could not identify the rate and charge values reliably in this context. Which table or page should I use?';
}
export function validateAnalysis(plan: AIPlan, blocks: ContextBlock[], instruction: string): AIPlan {
  const earlyQuestion=clarifyIntent(blocks,instruction);
  if(earlyQuestion)return {edits:[],clarification:earlyQuestion};
  const financial=/\b(rate|charges?|amount|total|subtotal|quantity)\b/i.test(instruction) && !/\b(rename|heading|label|word)\b/i.test(instruction);
  const clarify=(message:string):AIPlan=>({edits:[],clarification:message});
  const invoices=[...new Set(blocks.filter(b=>b.field?.type==='invoice_id').map(b=>b.text))];
  if(financial&&invoices.length>1&&!invoices.some(id=>instruction.includes(id)))return clarify('This context contains multiple invoice numbers. Which invoice should this instruction affect?');
  if(plan.clarification?.trim()) return clarify(plan.clarification);

  if(plan.edits.some(e=>e.ambiguity!=='none')) return clarify('Which occurrence or line item should these changes affect? Specify its row or page.');
  const resolved=plan.edits.map(e=>({e,b:blocks.find(b=>b.id===e.blockId&&b.page===e.page)}));
  for(const {e,b} of [...resolved].sort((a,b)=>(a.e.calculation?.operation==='sum'?1:0)-(b.e.calculation?.operation==='sum'?1:0))) {
    if(!b || !b.text.includes(e.original) || b.text.indexOf(e.original)!==b.text.lastIndexOf(e.original))
      return clarify('The target is not unique in the supplied context. Specify its row or page.');
    const isFinancial=['rate','quantity','charge','fee','subtotal','total'].includes(b.field?.type||'');
    if(financial && !isFinancial && !((b.field?.type==='date'&&/date|October|November|December|January|February|March|April|May|June|July|August|September/i.test(instruction))||(b.field?.type==='invoice_id'&&/invoice\s*(number|no|#)/i.test(instruction))))
      return clarify('The plan targets a label or an unrelated field instead of a requested numeric value. No changes were made.');
    if(financial && isFinancial && !e.calculation) {
      const kind=b.field?.type;
      if(b.field?.role==='fee'&&!/fees?|unloading|fuel|surcharge|accessorial|tax/i.test(instruction))return clarify('This plan would change an additional fee. I need confirmation before including that fee.');
      if(!kind || ['text','number'].includes(kind) ||
        (kind==='quantity'&&!/qty|quantity|units/i.test(instruction)) ||
        (kind==='rate'&&!/rate|unit\s*(price|cost)/i.test(instruction)) ||
        (kind==='charge'&&!/charges?|amount/i.test(instruction)))
        return clarify('Which labeled numeric field should change? The proposed value is not reliably associated with the requested label.');
      try {
        const requested=(instruction.match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)||[]).map(decimal);
        if(!requested.includes(decimal(e.replacement)))return clarify('Confirm the replacement amount for '+(e.label||e.original)+'. It was not specified in your instruction.');
        e.replacement=formatNumber(decimal(e.replacement),e.original);
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
      const allCharges=blocks.filter(s=>['charge','fee'].includes(s.field?.type||'') && s.field?.type!=='rate');
      const sum=blocks.every(s=>s.complete===true) && e.calculation.operation==='sum' && ['total','subtotal'].includes(b.field?.type||'') &&
        source.every(s=>['charge','fee'].includes(s.field?.type||'')) &&
        allCharges.length===source.length && allCharges.every(s=>source.includes(s));
      if(!product&&!sum) return clarify('Which line items, quantities, and fees make up the total? The arithmetic relationship is not established.');
      const values=source.map(s=>decimal(s.text));
      const calc=(xs:bigint[])=>product ? xs[0]*xs[1]/1000000n : xs.reduce((a,b)=>a+b,0n);
      if(calc(values)!==decimal(e.original)) return clarify('The original amounts do not reconcile. Confirm which fields make up this calculation.');
      const changed=source.map(s=>resolved.find(r=>r.b?.id===s.id&&r.e.original===s.text.trim())?.e.replacement||s.text);
      const result=calc(changed.map(decimal));
      e.replacement=formatNumber(result,e.original);
      e.explanation+=' Calculation: '+changed.join(product?' × ':' + ')+' = '+e.replacement+'. Verify the source fields before approval.';
    }
  }
  if(financial && /\b(accordingly|recalculate|recompute)\b/i.test(instruction) && !plan.edits.some(e=>e.calculation))
    return clarify('Which line item should be set to 1000, and which amounts make up the total? No financial values have been changed.');
  const feeDescriptions=blocks.filter(b=>b.field?.type==='charge'&&b.field.role==='fee');
  if(financial&&feeDescriptions.length&&!plan.interpretation)plan.interpretation='Update the primary line item; keep additional fees unchanged and recalculate the verified total.';
  return plan;
}
