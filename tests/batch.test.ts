
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectPDF, proposeBatchPDF, applyBatchPDF, applyPDF } from '../src/engine/pdf';
import { findTargets, targetFromRange, History, type Operation } from '../src/engine/model';
const source = new Uint8Array(readFileSync('tests/fixtures/32-batch-invoice.pdf'));
function op(text: string, replacement: string, page=0, occurrence=0): Operation {
  const target=findTargets(inspectPDF(source),text).filter(t=>t.page===page)[occurrence];
  if (!target) throw new Error('Missing test target');
  return {target,replacement};
}
async function independent(bytes: Uint8Array) {
  const task=getDocument({data:bytes.slice(),standardFontDataUrl:resolve('node_modules/pdfjs-dist/standard_fonts')+'/'});
  try {
    const doc=await task.promise;
    const pages=[];
    for(let i=1;i<=doc.numPages;i++) {
      const content=await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.filter(x=>'str' in x).map(x=>'str' in x?x.str:'').join(' '));
    }
    return pages;
  } finally {await task.destroy();}
}
describe('atomic batch PDF editing',()=>{
  it('handles screenshot invoice geometry and Helvetica-Bold 9.8 pt without changing neighbors',()=>{
    const result=applyPDF(source,op('0089033','1000'));
    expect(result.validation.outsidePixels).toBe(0);
    expect(findTargets(result.model,'0089033')).toHaveLength(5);
    expect(findTargets(result.model,'1000')).toHaveLength(1);
    expect(findTargets(result.model,'INVOICE')).toHaveLength(3);
  });
  it('applies three distant partial-line changes on one page and independently verifies every replacement',async()=>{
    const before=source.slice();
    const result=applyBatchPDF(source,[op('0089033','1000'),op('Project Office','Records Team'),op('1205.00','995.00')]);
    expect(source).toEqual(before);
    const pages=await independent(result.bytes);
    expect(pages).toHaveLength(3);
    for(const text of ['1000','Records Team','995.00','ARCHIVE-42','90.00']) expect(pages[0]).toContain(text);
    expect(pages[0]).not.toContain('1205.00');
    expect(pages[1]).toContain('1205.00');
    expect(result.validation.outsidePixels).toBe(0);
    expect(result.validation.checkedPages).toBe(3);
  });
  it('applies different replacements across three pages and preserves unselected identical occurrences',async()=>{
    const result=applyBatchPDF(source,[op('0089033','1000',0),op('10/13/2026','10/14/2026',1),op('pending','ready',2)]);
    const pages=await independent(result.bytes);
    expect(pages[0]).toContain('1000');
    expect(pages[0]).toContain('0089033');
    expect(pages[1]).toContain('10/14/2026');
    expect(pages[2]).toContain('ready');
    expect(result.validation.outsidePixels).toBe(0);
  });
  it('supports two nearby fields in a dense table with different lengths',()=>{
    const result=applyBatchPDF(source,[op('1205.00','995.00'),op('90.00','85.00')]);
    expect(findTargets(result.model,'995.00')).toHaveLength(1);
    expect(findTargets(result.model,'85.00')).toHaveLength(1);
    expect(result.validation.outsidePixels).toBe(0);
  });
  it('supports adjacent disjoint spans without overwriting either replacement',()=>{
    const result=applyBatchPDF(source,[op('Review','Check'),op('required','ready')]);
    expect(findTargets(result.model,'Check')).toHaveLength(1);
    expect(findTargets(result.model,'ready')).toHaveLength(1);
    expect(result.validation.outsidePixels).toBe(0);
  });
  it('rejects duplicate, conflicting and overlapping targets before mutation',()=>{
    const one=op('0089033','1000');
    const overlap=op('0089','1000');
    for(const operations of [[one,one],[one,overlap]]) {
      const review=proposeBatchPDF(source,operations);
      expect(review.status).toBe('UNSUPPORTED');
      expect(review.operations.every(p=>p.status!=='SAFE_TO_APPLY')).toBe(true);
      expect(()=>applyBatchPDF(source,operations)).toThrow(/Conflicts/);
    }
  });
  it('rejects stale references even when the selected text survives a prior edit',()=>{
    const stale=op('Project Office','Records Team');
    const output=applyBatchPDF(source,[op('0089033','1000')]);
    expect(()=>applyBatchPDF(output.bytes,[stale])).toThrow(/older document/);
  });
  it('one invalid replacement rolls back the complete batch and identifies the failed item',()=>{
    const history=new History(source);
    const before=history.current;
    const operations=[op('0089033','1000'),op('1205.00','This replacement will overflow'),op('pending','ready',2)];
    const preflight=proposeBatchPDF(history.current,operations);
    expect(preflight.operations[1].status).toBe('UNSUPPORTED');
    expect(()=>{const result=applyBatchPDF(history.current,operations);history.commit(result.bytes);}).toThrow(/Change 2/);
    expect(history.current).toEqual(before);
    expect(history.length).toBe(0);
  });
  it('a single undo reverses the entire batch and reset restores original bytes',()=>{
    const history=new History(source);
    history.commit(applyBatchPDF(history.current,[op('0089033','1000'),op('pending','ready',2)]).bytes);
    expect(history.length).toBe(1);
    expect(history.undo()).toEqual(source);
    history.commit(applyBatchPDF(history.current,[op('Project Office','Records Team')]).bytes);
    expect(history.reset()).toEqual(source);
  });
  it('range targeting supports exact partial lines and rejects partial glyph boundaries',()=>{
    const model=inspectPDF(source), line=model.pages[0].lines.find(l=>l.text.includes('Delivery pending'))!;
    const start=line.text.indexOf('pending');
    const target=targetFromRange(model,0,line.id,start,start+7)!;
    expect(target.original).toBe('pending');
    expect(proposeBatchPDF(source,[{target,replacement:'ready'}]).status).toBe('SAFE_TO_APPLY');
    expect(targetFromRange(model,0,line.id,-1,4)).toBeUndefined();
  });
});
