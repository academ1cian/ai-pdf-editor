// Six bounded synthetic requests. Never print credentials, provider bodies, or real documents.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {SYSTEM} from '../worker/api';
import {AIPlanSchema,planJSONSchema} from '../src/ai/schema';
import {buildContext} from '../src/ai/context';
import {validateAnalysis} from '../src/ai/analysis';
import {inspectPDF} from '../src/engine/pdf';
const key=process.env.GROQ_API_KEY;
if(!key || process.env.CF_FREE_PLAN_CONFIRMED!=='true')throw new Error('Free-plan confirmation and secret are required.');
const invoice=buildContext(inspectPDF(new Uint8Array(readFileSync('tests/fixtures/recovery-logistics.pdf'))),'rate charges total invoice date',0);
const cases=[
  {name:'resume correction',instruction:'Replace Sales Manager with Team Lead.',blocks:[{id:'resume-title',page:1,text:'Sales Manager'}]},
  {name:'logistics one-sentence acceptance',instruction:'Change the rate and charges to 1000 and update the total accordingly.',blocks:invoice},
  {name:'date and financial multi-edit',instruction:'Change the invoice date to October 15, update the primary freight rate to 1000, and recalculate the charge and total. Preserve the unloading fee and ship date.',blocks:invoice},

];
const results:unknown[]=[];
for(const model of ['openai/gpt-oss-20b','openai/gpt-oss-120b']){
  for(const [index,c] of cases.entries()){
    // Spread requests below the documented 8K TPM free allowance.
    if(results.length)await new Promise(r=>setTimeout(r,30000));
    const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model,messages:[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify({instruction:c.instruction,untrusted_document_blocks:c.blocks})}],
        response_format:{type:'json_schema',json_schema:{name:'pdf_edit_plan',strict:true,schema:planJSONSchema}},max_completion_tokens:1600,reasoning_effort:'low',temperature:.1}),
      signal:AbortSignal.timeout(25000)});
    if(!response.ok){
      results.push({model,case:c.name,status:response.status,passed:false,reason:'Provider rejected benchmark request',retryAfter:response.headers.get('retry-after')});
      if(response.status===429)break;
      continue;
    }
    const data=await response.json() as {usage?:{total_tokens?:number};choices?:{finish_reason?:string;message?:{content?:string}}[]};
    let passed=false,raw,analysed;
    try{
      raw=AIPlanSchema.parse(JSON.parse(data.choices?.[0]?.message?.content||''));
      analysed=validateAnalysis(structuredClone(raw),c.blocks,c.instruction);
      const amounts=analysed.edits.some(e=>e.original==='1205.0000'&&e.replacement==='1000.0000')&&
        analysed.edits.some(e=>e.original==='1205.00'&&e.replacement==='1000.00')&&
        analysed.edits.some(e=>e.original==='1295.00'&&e.replacement==='1090.00')&&
        !analysed.edits.some(e=>e.original==='90.00'||e.original==='90.0000');
      passed=index===0?analysed.edits.length===1&&analysed.edits[0].original==='Sales Manager'&&analysed.edits[0].replacement==='Team Lead':
        index===1?amounts&&analysed.edits.length===3:
        amounts&&analysed.edits.filter(e=>e.original==='10/13/2026'&&e.replacement==='10/15/2026').length===3;

    }catch{ /* Invalid synthetic proposal is a failed benchmark. */ }
    results.push({model,case:c.name,passed,finish:data.choices?.[0]?.finish_reason,tokens:data.usage?.total_tokens,
      limits:{requests:response.headers.get('x-ratelimit-limit-requests'),tokensPerMinute:response.headers.get('x-ratelimit-limit-tokens')},
      // These proposals contain synthetic test content only.
      rawProposal:raw,proposal:analysed||raw});
  }
}
mkdirSync('tests/evidence',{recursive:true});
writeFileSync('tests/evidence/model-benchmark.json',JSON.stringify({commit:process.env.GITHUB_SHA,results},null,2));
console.log(JSON.stringify(results));

// Keep raw synthetic proposals above to distinguish provider mistakes from local validator failures.
