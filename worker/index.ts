import { DurableObject } from 'cloudflare:workers';
import { handleAPI, type AIEnv } from './api';
import { reserve, reconcile, type Usage } from './budget';
export class AIBudget extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const path=new URL(request.url).pathname;
    if(request.method!=='POST'||!['/reserve','/reconcile'].includes(path))return new Response(null,{status:404});
    const body=await request.json() as {client:string;network:string;tokens:number;id:string;actual?:number;rejected?:boolean};
    if(!/^[a-f0-9]{64}$/.test(body.client)||!body.id||body.id.length>80)return new Response(null,{status:400});
    const decision=await this.ctx.storage.transaction(async tx=>{
      const current=await tx.get<Usage>('usage');
      if(path==='/reconcile'){
        if(current?.day===new Date().toISOString().slice(0,10))await tx.put('usage',reconcile(current,body.id,body.actual,body.rejected));
        return {allowed:true};
      }
      const result=reserve(current,body.client,body.tokens,Date.now(),undefined,body.network,body.id);
      if(result.allowed)await tx.put('usage',result.usage);
      return {allowed:result.allowed,reason:result.reason,retryAfter:result.retryAfter,remaining:result.remaining};
    });
    return Response.json(decision,{status:decision.allowed?200:429});

  }
}
export default { fetch: (request: Request, env: AIEnv) => handleAPI(request, env) };
