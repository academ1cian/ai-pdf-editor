import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {inspectPDF,proposePDF,applyPDF,applyBatchPDF} from '../src/engine/pdf';
import {findTargets,History} from '../src/engine/model';
import {buildContext} from '../src/ai/context';
import {validateAnalysis,decimal} from '../src/ai/analysis';
import type {AIPlan} from '../src/ai/schema';
import {reserve,reconcile} from '../worker/budget';
const source=new Uint8Array(readFileSync('tests/fixtures/focused-invoice.pdf'));
describe('focused usability and intelligence regressions',()=>{
  it('A/D/F: dense invoice numeric batch preserves right edges, extraction, neighbors and one undo',async()=>{
    const model=inspectPDF(source);
    const edits=['1205.00','1205.00','1295.00'].map((t,i)=>({target:findTargets(model,t)[i===1?1:0],replacement:i===2?'1090.00':'1000.00'}));
    const result=applyBatchPDF(source,edits);
    expect(result.validation.outsidePixels).toBe(0);
    for(const edit of edits){
      const found=findTargets(result.model,edit.replacement).find(t=>Math.abs(t.rect[2]-edit.target.rect[2])<.15);
      expect(found).toBeDefined();
    }
    const task=getDocument({data:result.bytes.slice(),useSystemFonts:true}); const pdf=await task.promise;
    const text=(await(await pdf.getPage(1)).getTextContent()).items.filter(i=>'str'in i).map(i=>('str'in i?i.str:'')).join(' ');
    expect(text).toContain('1090.00');expect(text).not.toContain('1205.00');expect(text).toContain('Payment terms: 30 days. Preserve this text.');
    await task.destroy();
    const h=new History(source);h.commit(result.bytes);expect(h.undo()).toEqual(source);
  });
  it('B: marginal overflow expands measured whitespace, and bounded type adjustment is explicit',async()=>{
    const d=await PDFDocument.create(),f=await d.embedFont(StandardFonts.Helvetica),p=d.addPage([612,792]);
    p.drawText('iiiiiiii',{x:100,y:600,size:12,font:f});
    const bytes=await d.save(),target=findTargets(inspectPDF(bytes),'iiiiiiii')[0];
    const proposal=proposePDF(bytes,{target,replacement:'MMMM'});
    expect(proposal.status).toBe('SAFE_TO_APPLY');expect(proposal.fitting).toBe('whitespace');
    expect(applyPDF(bytes,{target,replacement:'MMMM'}).validation.outsidePixels).toBe(0);
    const d2=await PDFDocument.create(),f2=await d2.embedFont(StandardFonts.Helvetica),p2=d2.addPage([612,792]);
    p2.drawText('1234',{x:100,y:600,size:12,font:f2});
    const needed=f2.widthOfTextAtSize('12345',12);
    p2.drawLine({start:{x:100+needed*.97+.5,y:580},end:{x:100+needed*.97+.5,y:620},thickness:.1});
    const bytes2=await d2.save(),op={target:findTargets(inspectPDF(bytes2),'1234')[0],replacement:'12345'};
    const fitted=proposePDF(bytes2,op);expect(fitted.status).toBe('SAFE_TO_APPLY');expect(fitted.fitting).toBe('typography');
    expect(fitted.size).toBeLessThan(12);expect(fitted.size).toBeGreaterThanOrEqual(11.4);
    expect(applyPDF(bytes2,op).validation.outsidePixels).toBe(0);
  });
  it('C: layout context identifies numeric fields and refuses header replacements or ambiguous totals',()=>{
    const blocks=buildContext(inspectPDF(source),'Change the charges and the rate to 1000 and total below accordingly.',0);
    expect(blocks.filter(b=>b.field?.type==='rate').map(b=>b.text)).toContain('1205.00');
    const heading=blocks.find(b=>b.text==='CHARGES')!;
    const plan:AIPlan={edits:[{id:'e',operation:'replace',blockId:heading.id,page:1,original:'CHARGES',replacement:'1000',explanation:'test',ambiguity:'none'}]};
    expect(validateAnalysis(plan,blocks,'Change charges and rate to 1000 and total accordingly').edits).toEqual([]);
    expect(validateAnalysis(plan,blocks,'Change charges and rate to 1000 and total accordingly').clarification).toBeTruthy();
  });
  it('C/D: total comes from decimal-safe verified sources, not the model result',()=>{
    const blocks=buildContext(inspectPDF(source),'Change first charges to 1000 and total accordingly',0);
    const charges=blocks.filter(b=>b.field?.type==='charge'),total=blocks.find(b=>b.field?.type==='total')!;
    expect(charges).toHaveLength(2);expect(total).toBeDefined();
    const plan:AIPlan={edits:[{id:'charge',operation:'replace',blockId:charges[0].id,page:1,original:charges[0].text,replacement:'1000.00',explanation:'First charge.',ambiguity:'none'},
      {id:'total',operation:'replace',blockId:total.id,page:1,original:total.text,replacement:'999999',explanation:'Total.',ambiguity:'none',
        calculation:{operation:'sum',sources:charges.map(b=>({blockId:b.id,page:b.page,original:b.text}))}}]};
    const result=validateAnalysis(plan,blocks,'On page 1, change first charges to 1000 and total accordingly');
    expect(result.edits[1].replacement).toBe('1090.00');expect(result.edits[1].explanation).toContain('1000.00 + 90.00 = 1090.00');
    expect(decimal('0.1')+decimal('0.2')).toBe(decimal('0.30'));
  });
  it('E: consecutive sessions behind one NAT reconcile actual usage and refund confirmed rejections idempotently',()=>{
    const now=Date.UTC(2026,9,14),network='nat';let usage;
    for(let i=0;i<12;i++){
      const r=reserve(usage,'session',8000,now+i*20000,undefined,network,'r'+i);
      expect(r.allowed).toBe(true);usage=reconcile(r.usage,'r'+i,250);
    }
    expect(usage!.tokens).toBe(3000);expect(usage!.requests).toBe(12);
    const r=reserve(usage,'another-session',8000,now+240000,undefined,network,'rejected');
    const refunded=reconcile(r.usage,'rejected',undefined,true);
    expect(refunded.tokens).toBe(3000);expect(refunded.requests).toBe(12);
    expect(reconcile(refunded,'rejected',undefined,true)).toEqual(refunded);
    const blocked=reserve({...refunded,tokens:100000},'a',100,now);
    expect(blocked.reason).toBe('global_daily');expect(blocked.retryAfter).toBeGreaterThan(0);
  });
});
