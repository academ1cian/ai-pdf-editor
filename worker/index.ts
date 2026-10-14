import { DurableObject } from 'cloudflare:workers';
import { handleAPI, type AIEnv } from './api';
import { reserve, type Usage } from './budget';
export class AIBudget extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/reserve')
      return new Response(null, { status: 404 });
    const { client, tokens } = (await request.json()) as { client: string; tokens: number };
    if (!/^[a-f0-9]{64}$/.test(client)) return new Response(null, { status: 400 });
    const allowed = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Usage>('usage');
      const decision = reserve(current, client, tokens, Date.now());
      if (decision.allowed) await tx.put('usage', decision.usage);
      return decision.allowed;
    });
    return new Response(null, { status: allowed ? 204 : 429 });
  }
}
export default { fetch: (request: Request, env: AIEnv) => handleAPI(request, env) };
