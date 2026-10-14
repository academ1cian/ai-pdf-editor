// Metadata only. Never log provider bodies, headers, credentials or account IDs.
import { cfRequest, assertFreeSubscriptions } from './deployment.mjs';
const env=process.env;
const subscriptions=await cfRequest(env,'/subscriptions?per_page=50');
if((subscriptions.result_info?.total_count||0)>50)throw new Error('Subscription audit requires pagination.');
assertFreeSubscriptions(subscriptions.result);
console.log('Cloudflare: authenticated; verified free account.');
for(const name of ['GROQ_API_KEY','GROQ_API_KEY_BACKUP']){
  if(!env[name]){console.log(name+': absent');continue;}
  const response=await fetch('https://api.groq.com/openai/v1/models',{headers:{Authorization:'Bearer '+env[name]},signal:AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>({}));
  console.log(name+': HTTP '+response.status+'; configured model available='+!!data.data?.some(m=>m.id==='openai/gpt-oss-120b'));
}
try{
  const models=await cfRequest(env,'/ai/models/search?search=flux-2-klein-4b');
  console.log('Workers AI model metadata: accessible; model found='+JSON.stringify(models.result).includes('flux-2-klein-4b'));
}catch{console.log('Workers AI metadata: inaccessible. REST discovery requires Account Workers AI Read permission; Worker binding deployment will be checked separately.');}
