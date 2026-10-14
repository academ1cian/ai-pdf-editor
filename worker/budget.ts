export interface BudgetConfig { dailyRequests:number; dailyTokens:number; perMinute:number; perDay:number; }
export const DEFAULT_BUDGET:BudgetConfig={dailyRequests:80,dailyTokens:100000,perMinute:4,perDay:30};
export interface Usage {
  day:string; requests:number; tokens:number;
  clients:Record<string,{minute:number;minuteRequests:number;requests:number}>;
  networks?:Record<string,{minute:number;minuteRequests:number;requests:number}>;
  pending?:Record<string,{client:string;network:string;tokens:number}>;
}
export function reserve(current:Usage|undefined,client:string,tokens:number,now:number,config=DEFAULT_BUDGET,network=client,id='legacy'):
 {allowed:boolean;usage:Usage;reason?:string;retryAfter?:number;remaining?:number} {
  const day=new Date(now).toISOString().slice(0,10), minute=Math.floor(now/60000);
  const usage:Usage=current?.day===day?structuredClone(current):{day,requests:0,tokens:0,clients:{}};
  const dailyRetry=Math.ceil((Date.parse(day+'T00:00:00Z')+86400000-now)/1000);
  const item={...(usage.clients[client]||{minute,minuteRequests:0,requests:0})};
  if(item.minute!==minute){item.minute=minute;item.minuteRequests=0;}
  usage.networks ||= {}; usage.pending ||= {};
  const nat={...(usage.networks[network]||{minute,minuteRequests:0,requests:0})};
  if(nat.minute!==minute){nat.minute=minute;nat.minuteRequests=0;}
  const deny=(reason:string,retryAfter:number)=>({allowed:false,usage,reason,retryAfter});
  if(!Number.isSafeInteger(tokens)||tokens<1) return deny('invalid_reservation',60);
  if(usage.requests>=config.dailyRequests || usage.tokens+tokens>config.dailyTokens) return deny('global_daily',dailyRetry);
  if(item.requests>=config.perDay) return deny('session_daily',dailyRetry);
  if(item.minuteRequests>=config.perMinute) return deny('session_minute',60-now/1000%60);
  // Shared corporate networks get an aggregate allowance, rather than six requests for everybody.
  if(nat.requests>=60) return deny('network_daily',dailyRetry);
  if(nat.minuteRequests>=12) return deny('network_minute',60-now/1000%60);
  if(id!=='legacy'&&usage.pending[id]) return deny('duplicate_reservation',60);
  item.requests++; item.minuteRequests++; nat.requests++; nat.minuteRequests++;
  usage.requests++; usage.tokens+=tokens;
  usage.clients[client]=item;usage.networks[network]=nat;
  if(id!=='legacy')usage.pending[id]={client,network,tokens};
  return {allowed:true,usage,remaining:Math.min(config.perDay-item.requests,config.dailyRequests-usage.requests)};
}
export function reconcile(current:Usage,id:string,actual:number|undefined,rejected=false):Usage {
  const usage=structuredClone(current), held=usage.pending?.[id];
  if(!held)return usage; // idempotent; yesterday's or unknown reservation cannot refund.
  if(rejected){usage.tokens-=held.tokens;usage.requests--;
    usage.clients[held.client].requests--; if(usage.networks?.[held.network])usage.networks[held.network].requests--;
  }else if(Number.isSafeInteger(actual)&&actual!>=0){
    usage.tokens=Math.max(0,usage.tokens-held.tokens+actual!);
  }
  delete usage.pending![id];
  return usage;
}
