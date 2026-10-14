export interface BudgetConfig { dailyRequests:number;dailyTokens:number;perMinute:number;perDay:number }
export const DEFAULT_BUDGET:BudgetConfig={dailyRequests:40,dailyTokens:50000,perMinute:2,perDay:6};
export interface Usage {day:string;requests:number;tokens:number;clients:Record<string,{minute:number;minuteRequests:number;requests:number}>}
export function reserve(current:Usage|undefined,client:string,tokens:number,now:number,config=DEFAULT_BUDGET):{allowed:boolean;usage:Usage} {
 const day=new Date(now).toISOString().slice(0,10);const minute=Math.floor(now/60000);
 const usage:Usage=current?.day===day?structuredClone(current):{day,requests:0,tokens:0,clients:{}};
 const old=usage.clients[client];const item=old?{...old}:{minute,minuteRequests:0,requests:0};
 if(item.minute!==minute){item.minute=minute;item.minuteRequests=0;}
 if(!Number.isSafeInteger(tokens)||tokens<1||usage.requests>=config.dailyRequests||usage.tokens+tokens>config.dailyTokens||item.requests>=config.perDay||item.minuteRequests>=config.perMinute)return {allowed:false,usage};
 item.requests++;item.minuteRequests++;usage.requests++;usage.tokens+=tokens;usage.clients[client]=item;
 return {allowed:true,usage};
}
