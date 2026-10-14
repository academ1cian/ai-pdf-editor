interface Env { AI_PROXY?:{fetch:(request:Request)=>Promise<Response>} }
export const onRequest=async({request,env}:{request:Request;env:Env})=>{
 if(!env.AI_PROXY){const config=new URL(request.url).pathname==='/api/config';return Response.json(config?{enabled:false,reason:'AI is not configured. Find & replace works without it.'}:{error:'AI is not configured. Use manual editing.'},{status:config?200:503,headers:{'Cache-Control':'no-store'}});}
 return env.AI_PROXY.fetch(request);
};
