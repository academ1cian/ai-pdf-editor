// Read-only authorization diagnostics on a hosted runner. Never print credentials or bodies.
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!/^[a-f0-9]{32}$/i.test(account||'')||!token)throw new Error('Deployment credentials are missing or malformed.');
const probes=[
 ['Token verification','https://api.cloudflare.com/client/v4/user/tokens/verify'],
 ['Pages authorization',`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects?per_page=1`],
 ['Workers authorization',`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`],
 ['Subscription read authorization',`https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`]
];
for(const [name,url] of probes){
 try{const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});let codes=[];try{const data=await response.json();codes=(data.errors||[]).map(e=>e.code).filter(Number.isInteger);}catch{/* do not print response bodies */}
 console.log(`${name}: HTTP ${response.status}${codes.length?' (error codes '+codes.join(',')+')':''}`);
 }catch{console.log(name+': network error');}
}
