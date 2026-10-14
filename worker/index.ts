import {IMAGE_BUDGET} from './image-api';
import { DurableObject } from 'cloudflare:workers';
import { handleAPI, type AIEnv } from './api';
import { reserve, reconcile, budgetConfig, type Usage } from './budget';
export class AIBudget extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const path=new URL(request.url).pathname;
    if(request.method!=='POST'||!['/reserve','/reconcile','/cooldown'].includes(path))return new Response(null,{status:404});
    const body=await request.json() as {client:string;network:string;tokens:number;id:string;actual?:number;rejected?:boolean;retryAfter?:number;reason?:string;kind?:string};
    if(!/^[a-f0-9]{64}$/.test(body.client)||!body.id||body.id.length>80)return new Response(null,{status:400});
    const decision=await this.ctx.storage.transaction(async tx=>{
      const current=await tx.get<Usage>('usage');
      if(path==='/cooldown'){
        if(current){current.providerUntil=Math.max(current.providerUntil||0,Date.now()+Math.min(86400,Math.max(1,body.retryAfter||60))*1000);current.providerReason=body.reason==='provider_rate_limit'?'provider_rate_limit':'provider_cooldown';await tx.put('usage',current);}
        return {allowed:true};
      }
      if(path==='/reconcile'){
        if(current?.day===new Date().toISOString().slice(0,10)){
          const updated=reconcile(current,body.id,body.actual,body.rejected);await tx.put('usage',updated);
          return {allowed:true,requests:updated.requests,tokens:updated.tokens};
        }
        return {allowed:true};
      }
      const result=reserve(current,body.client,body.tokens,Date.now(),body.kind==='image'?IMAGE_BUDGET:budgetConfig(this.env as Record<string,unknown>),body.network,body.id);
      if(result.allowed)await tx.put('usage',result.usage);
      return {allowed:result.allowed,reason:result.reason,retryAfter:result.retryAfter,remaining:result.remaining,requests:result.usage.requests,tokens:result.usage.tokens};
    });
    return Response.json(decision,{status:decision.allowed?200:429});

  }
}
export default { fetch: (request: Request, env: AIEnv) => handleAPI(request, env) };
