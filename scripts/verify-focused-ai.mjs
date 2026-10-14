// Independent verification of the actual production-browser export; synthetic fixture only.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const encoded=process.env.FOCUSED_PDF_BASE64||'';
if(!/^[A-Za-z0-9+/=\s]+$/.test(encoded)||encoded.length>200000)throw new Error('Expected a small synthetic exported PDF.');
const output=Buffer.from(encoded,'base64');
if(output.subarray(0,5).toString()!=='%PDF-')throw new Error('Invalid PDF input.');
async function extract(bytes){
  const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});
  try{
    const pdf=await task.promise;if(pdf.numPages!==1)throw new Error('Unexpected page count.');
    return (await(await pdf.getPage(1)).getTextContent()).items.filter(x=>'str'in x&&x.str.trim()).map(x=>({text:x.str.trim(),x:x.transform[4],y:x.transform[5],width:x.width,height:x.height}));
  }finally{await task.destroy();}
}
const original=await extract(readFileSync('tests/fixtures/focused-invoice.pdf')),actual=await extract(output);
const targeted=original.filter(x=>x.text==='1205.00'||x.text==='1295.00');
if(targeted.length!==3)throw new Error('Baseline fixture mismatch.');
const remaining=[...actual];
for(const before of original){
  const expected=before.text==='1205.00'?'1000.00':before.text==='1295.00'?'1090.00':before.text;
  const i=remaining.findIndex(after=>after.text===expected&&Math.abs(after.y-before.y)<.15&&Math.abs(after.height-before.height)<.01&&
    (targeted.includes(before)?Math.abs(after.x+after.width-before.x-before.width)<.15:Math.abs(after.x-before.x)<.15));
  if(i<0)throw new Error('Independent extraction/position mismatch: '+before.text);
  remaining.splice(i,1);
}
if(remaining.length)throw new Error('Unexpected extra text.');
mkdirSync('tests/evidence',{recursive:true});
writeFileSync('tests/evidence/focused-production-ai.pdf',output);
const evidence={origin:'https://ai-pdf-editor.pages.dev',commit:process.env.CLIENT_COMMIT,run:process.env.GITHUB_RUN_ID,
  sha256:createHash('sha256').update(output).digest('hex'),independentEngine:'PDF.js 6.4.299',pages:1,replacements:3,
  expectedValues:['1000.00','1000.00','1090.00'],allUnchangedTextAndPositionsPreserved:true,numericRightEdgesPreserved:true};
writeFileSync('tests/evidence/focused-production-ai.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
