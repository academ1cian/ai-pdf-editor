import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {buildContext} from '../src/ai/context';
import {validateAnalysis,formatNumber,decimal} from '../src/ai/analysis';
import {resolvePlan} from '../src/ai/resolve';
import {inspectPDF,applyBatchPDF,renderPDF,proposePDF} from '../src/engine/pdf';
import {History,findTargets} from '../src/engine/model';
import type {AIPlan} from '../src/ai/schema';
const bytes=new Uint8Array(readFileSync('tests/fixtures/recovery-logistics.pdf'));
const instruction='Change the rate and charges to 1000 and update the total accordingly.';
function scenario(){
  const model=inspectPDF(bytes),blocks=buildContext(model,instruction,0);
  const rate=blocks.find(b=>b.field?.type==='rate'&&b.field.role==='line_item')!;
  const charge=blocks.find(b=>b.field?.type==='charge'&&b.field.role==='line_item')!;
  const total=blocks.find(b=>b.field?.type==='total')!;
  const charges=blocks.filter(b=>b.field?.type==='charge'||b.field?.type==='fee');
  const edit=(b:typeof rate,replacement:string)=>({id:b.id,operation:'replace' as const,page:b.page,blockId:b.id,original:b.text,replacement,explanation:'Requested change.',ambiguity:'none' as const});
  const plan:AIPlan={interpretation:'Change the main freight row and retain the unloading fee.',edits:[edit(rate,'1000'),edit(charge,'1000'),{...edit(total,'0'),calculation:{operation:'sum',sources:charges.map(b=>({blockId:b.id,page:b.page,original:b.text}))}}]};
  return {model,blocks,rate,charge,total,charges,plan};
}
describe('recovery acceptance workflow',()=>{
  it('recognizes main freight versus fee and verifies cross-page total without count-based ambiguity',()=>{
    const s=scenario();expect(s.rate.text).toBe('1205.0000');expect(s.charge.text).toBe('1205.00');expect(s.total.page).toBe(3);
    expect(s.charges.map(b=>b.text)).toEqual(['1205.00','90.00']);
    const plan=validateAnalysis(s.plan,s.blocks,instruction);
    expect(plan.clarification).toBeUndefined();
    expect(plan.edits.map(e=>e.replacement)).toEqual(['1000.0000','1000.00','1090.00']);
  });
  it('edits and renders a real working copy, independently reopens it, and commits one undo transaction',async()=>{
    const s=scenario(),plan=validateAnalysis(s.plan,s.blocks,instruction),operations=resolvePlan(s.model,plan,s.blocks),history=new History(bytes);
    const preview=applyBatchPDF(history.current,operations);
    expect(history.current).toEqual(bytes);expect(history.length).toBe(0);
    const before=renderPDF(bytes,0).png,after=renderPDF(preview.bytes,0).png;expect(after).not.toEqual(before);
    const task=getDocument({data:preview.bytes.slice(),useSystemFonts:true});const pdf=await task.promise;
    const pages=[];
    for(let i=1;i<=3;i++)pages.push((await(await pdf.getPage(i)).getTextContent()).items.filter(x=>'str'in x).map(x=>'str'in x?x.str:'').join(' '));
    expect(pages[0]).toContain('1000.0000');expect(pages[0]).toContain('1000.00');expect(pages[0]).toContain('90.00');
    expect(pages[0]).toContain('CHARGES');expect(pages[2]).toContain('1090.00');expect(pages[1]).toContain('ARCHIVE-42');
    await task.destroy();expect(preview.validation.outsidePixels).toBe(0);
    history.commit(preview.bytes);expect(history.current).toEqual(preview.bytes);expect(history.undo()).toEqual(bytes);
  });
  it('fits a wider numeric value within its table cell and preserves formatting',()=>{
    const s=scenario(),target=findTargets(s.model,'1205.0000')[0],op={target,replacement:'10000.0000'};
    const p=proposePDF(bytes,op);expect(p.status).toBe('SAFE_TO_APPLY');expect(p.alignment).toBe('right');
    expect(applyBatchPDF(bytes,[op]).validation.outsidePixels).toBe(0);
    expect(formatNumber(decimal('1000'),'$1,205.00')).toBe('$1,000.00');
  });
  it('rejects fee changes, unresolved targets and incorrect arithmetic without changing source',()=>{
    const s=scenario(),fee=s.blocks.find(b=>b.field?.type==='charge'&&b.field.role==='fee')!;
    const bad:AIPlan={edits:[{id:'fee',operation:'replace',page:fee.page,blockId:fee.id,original:fee.text,replacement:'1000',explanation:'Wrong.',ambiguity:'none'}]};
    expect(validateAnalysis(bad,s.blocks,instruction).edits).toEqual([]);
    expect(()=>resolvePlan(s.model,{edits:[{...bad.edits[0],blockId:'missing'}]},s.blocks)).toThrow();
    const broken=structuredClone(s.plan);broken.edits[2].original='9999.00';
    expect(validateAnalysis(broken,s.blocks,instruction).edits).toEqual([]);
  });
});
