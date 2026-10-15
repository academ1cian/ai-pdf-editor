// Isolated, authenticated, invented-image probe. No credentials in arguments or logs.
import {writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {cfRequest,assertFreeSubscriptions} from './deployment.mjs';
const env=process.env,worker='ai-pdf-editor-image-probe';
const subs=await cfRequest(env,'/subscriptions?per_page=50');assertFreeSubscriptions(subs.result);
if((subs.result_info?.total_count||0)>50)throw new Error('Cannot complete the free-plan audit.');
const token=randomUUID();await mkdir('.deployment',{recursive:true});
await writeFile('.deployment/image-probe.mjs',`export default {async fetch(request,env){if(new URL(request.url).pathname==='/health')return new Response(env.PROBE_TOKEN?'ai-pdf-image-probe-ready-v2':'not ready',{status:env.PROBE_TOKEN?200:503});if(request.method!=='POST'||request.headers.get('X-Probe')!==env.PROBE_TOKEN)return new Response(null,{status:403});try{const f=await request.formData(),r=new Response(f);const result=await env.AI.run('@cf/black-forest-labs/flux-2-klein-4b',{multipart:{body:r.body,contentType:r.headers.get('content-type')}});return Response.json(result);}catch{return Response.json({error:'binding inference unavailable'},{status:502});}}};`);
await writeFile('.deployment/image-probe.json',JSON.stringify({name:worker,main:'image-probe.mjs',compatibility_date:'2026-10-14',workers_dev:true,ai:{binding:'AI'},observability:{enabled:false}}));
try{
 const deployed=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--config','.deployment/image-probe.json'],{env:{...env,WRANGLER_SEND_METRICS:'false'},stdio:'inherit',timeout:90000});if(deployed.status!==0)throw new Error('Image binding deployment failed. Workers Scripts Edit and account AI binding access must be checked.');
 await cfRequest(env,`/workers/scripts/${worker}/secrets`,{method:'PUT',body:{name:'PROBE_TOKEN',type:'secret_text',text:token}});
 const subdomain=(await cfRequest(env,'/workers/subdomain')).result.subdomain;
 let ready=false;for(let i=0;i<10;i++){const r=await fetch(`https://${worker}.${subdomain}.workers.dev/health`,{signal:AbortSignal.timeout(8000)});if(r.status===200&&(await r.text())==='ai-pdf-image-probe-ready-v2'){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,3000));}if(!ready)throw new Error('Temporary Worker route did not propagate. No inference request sent.');
 const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xedb88320:0);}return (c^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const type=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([length,type,data,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(128,0);header.writeUInt32BE(128,4);header[8]=8;header[9]=2;const raw=Buffer.alloc(128*385,255);for(let y=0;y<128;y++){raw[y*385]=0;for(let x=25;x<103;x++)if(y>=25&&y<103){const at=y*385+1+x*3;raw[at]=220;raw[at+1]=30;raw[at+2]=30;}}
 const input=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
 const form=new FormData();form.append('prompt','Edit the supplied simple red square into a blue square. Keep the plain white background. No lettering.');form.append('width','512');form.append('height','512');form.append('input_image_0',new Blob([input],{type:'image/png'}),'invented.png');
 const response=await fetch(`https://${worker}.${subdomain}.workers.dev/run`,{method:'POST',headers:{'X-Probe':token},body:form,signal:AbortSignal.timeout(60000)});const data=await response.json().catch(()=>({}));
 if(!response.ok||!data.image){console.log('Probe response type='+response.headers.get('content-type')+'; server='+response.headers.get('server')+'; JSON keys='+Object.keys(data).join(','));console.log('Image binding deployed, but live invented-image inference failed (HTTP '+response.status+'). No paid fallback or retry.');process.exitCode=1;}
 else{const bytes=Buffer.from(data.image,'base64');await writeFile('.deployment/image-result.bin',bytes);const require=createRequire(import.meta.url),canvasRequire=createRequire(require.resolve('pdfjs-dist/package.json')),{createCanvas,loadImage}=canvasRequire('@napi-rs/canvas'),image=await loadImage(bytes),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,image.width,image.height).data;let blue=0,red=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i+2]>pixels[i]*1.5&&pixels[i+2]>pixels[i+1]*1.3)blue++;if(pixels[i]>pixels[i+2]*1.5&&pixels[i]>pixels[i+1]*1.3)red++;}if(blue<image.width*image.height*.03||blue<=red*3)throw new Error('Inference returned an image but did not reliably perform the requested red-to-blue edit.');console.log('Live semantic check: output has the requested blue subject.');console.log('Verified free image binding: actual input-image inference succeeded; output bytes='+bytes.length+'; SHA256='+createHash('sha256').update(bytes).digest('hex'));}
}finally{await cfRequest(env,`/workers/scripts/${worker}`,{method:'DELETE'});console.log('Temporary image-probe Worker removed.');}
