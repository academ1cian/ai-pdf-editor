// Isolated, authenticated, invented-image probe. No credentials in arguments or logs.
import {writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {cfRequest,assertFreeSubscriptions} from './deployment.mjs';
const env=process.env,worker='ai-pdf-editor-image-probe';
const subs=await cfRequest(env,'/subscriptions?per_page=50');assertFreeSubscriptions(subs.result);
if((subs.result_info?.total_count||0)>50)throw new Error('Cannot complete the free-plan audit.');
const token=randomUUID();await mkdir('.deployment',{recursive:true});
await writeFile('.deployment/image-probe.mjs',`export default {async fetch(request,env){if(request.method!=='POST'||request.headers.get('X-Probe')!==env.PROBE_TOKEN)return new Response(null,{status:403});try{const f=await request.formData(),r=new Response(f);const result=await env.AI.run('@cf/black-forest-labs/flux-2-klein-4b',{multipart:{body:r.body,contentType:r.headers.get('content-type')}});return Response.json(result);}catch{return Response.json({error:'binding inference unavailable'},{status:502});}}};`);
await writeFile('.deployment/image-probe.json',JSON.stringify({name:worker,main:'image-probe.mjs',compatibility_date:'2026-10-14',workers_dev:true,ai:{binding:'AI'},observability:{enabled:false}}));
try{
 const deployed=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--config','.deployment/image-probe.json'],{env:{...env,WRANGLER_SEND_METRICS:'false'},stdio:'inherit',timeout:90000});if(deployed.status!==0)throw new Error('Image binding deployment failed. Workers Scripts Edit and account AI binding access must be checked.');
 await cfRequest(env,`/workers/scripts/${worker}/secrets`,{method:'PUT',body:{name:'PROBE_TOKEN',type:'secret_text',text:token}});
 const subdomain=(await cfRequest(env,'/workers/subdomain')).result.subdomain;
 const form=new FormData();form.append('prompt','Edit the supplied simple red square into a blue square. Keep the plain white background. No lettering.');form.append('width','512');form.append('height','512');form.append('input_image_0',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64')],{type:'image/png'}),'invented.png');
 const response=await fetch(`https://${worker}.${subdomain}.workers.dev`,{method:'POST',headers:{'X-Probe':token},body:form,signal:AbortSignal.timeout(60000)});const data=await response.json().catch(()=>({}));
 if(!response.ok||!data.image){console.log('Image binding deployed, but live invented-image inference failed (HTTP '+response.status+'). No paid fallback or retry.');process.exitCode=1;}
 else{const bytes=Buffer.from(data.image,'base64');console.log('Verified free image binding: actual input-image inference succeeded; output bytes='+bytes.length+'; SHA256='+createHash('sha256').update(bytes).digest('hex'));}
}finally{await cfRequest(env,`/workers/scripts/${worker}`,{method:'DELETE'});console.log('Temporary image-probe Worker removed.');}
