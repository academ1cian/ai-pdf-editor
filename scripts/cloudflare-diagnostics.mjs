// Read-only authorization diagnostics on a hosted runner. Never print credentials or bodies.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/i.test(account || '') || !token)
  throw new Error('Deployment credentials are missing or malformed.');
const probes = [
  ['Token verification', 'https://api.cloudflare.com/client/v4/user/tokens/verify'],
  [
    'Pages authorization',
    `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects?per_page=1`,
  ],
  [
    'Workers authorization',
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`,
  ],
  [
    'Subscription read authorization',
    `https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`,
  ],
];
for (const [name, url] of probes) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    let codes = [];
    try {
      const data = await response.json();
      codes = (data.errors || []).map((e) => e.code).filter(Number.isInteger);
    } catch {
      /* do not print response bodies */
    }
    console.log(
      `${name}: HTTP ${response.status}${codes.length ? ' (error codes ' + codes.join(',') + ')' : ''}`,
    );
  } catch {
    console.log(name + ': network error');
  }
}

function deploymentSummary(item) {
  if (!item) return null;
  const metadata=item.deployment_trigger?.metadata || {};
  return {id:item.id,environment:item.environment,branch:metadata.branch,commit:metadata.commit_hash,
    aliases:item.aliases,stage:item.latest_stage?.name,status:item.latest_stage?.status};
}
try {
  const headers={Authorization:`Bearer ${token}`};
  const base=`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/ai-pdf-editor`;
  const response=await fetch(base,{headers,signal:AbortSignal.timeout(20000)});
  if(response.ok) {
    const data=await response.json(),project=data.result;
    console.log(JSON.stringify({project:project.name,productionBranch:project.production_branch,
      sourceType:project.source?.type,canonical:deploymentSummary(project.canonical_deployment),
      latest:deploymentSummary(project.latest_deployment)}));
  } else console.log('Project metadata: HTTP '+response.status);
  const deployments=await fetch(base+'/deployments?per_page=5',{headers,signal:AbortSignal.timeout(20000)});
  if(deployments.ok) {
    const data=await deployments.json();
    console.log(JSON.stringify({recentDeployments:(data.result||[]).map(deploymentSummary)}));
  } else console.log('Deployment metadata: HTTP '+deployments.status);
} catch {console.log('Public deployment metadata could not be read.');}
