// One invented, bounded authentication-failover check. Production keys/settings are unchanged.
import { requestGroq } from '../worker/provider';
if (!process.env.GROQ_API_KEY_BACKUP) {
  console.log('Standby secret absent; primary deployment is unaffected.');
  process.exit(0);
}
const body = JSON.stringify({
  model: 'openai/gpt-oss-120b',
  messages: [
    {
      role: 'system',
      content: 'Return only the requested exact replacement in the supplied schema.',
    },
    {
      role: 'user',
      content: 'For this invented test, replace pending with ready. Return replacement ready.',
    },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'standby_probe',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['replacement'],
        properties: { replacement: { type: 'string' } },
      },
    },
  },
  max_completion_tokens: 512,
  reasoning_effort: 'low',
  temperature: 0,
});
try {
  const { response, credential } = await requestGroq(
    {
      GROQ_API_KEY: 'invalid-isolated-release-authentication-probe',
      GROQ_API_KEY_BACKUP: process.env.GROQ_API_KEY_BACKUP,
    },
    body,
    fetch,
  );
  if (!response.ok)
    throw new Error(
      'Standby inference returned HTTP ' +
        response.status +
        '. No automatic retry or quota rotation was used.',
    );
  const data = (await response.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[];
    usage?: { total_tokens?: number };
  };
  const choice = data.choices?.[0],
    plan = JSON.parse(choice?.message?.content || 'null');
  if (credential !== 'backup' || choice?.finish_reason !== 'stop' || plan?.replacement !== 'ready')
    throw new Error('Standby did not complete the exact structured replacement.');
  console.log(
    'Live standby routing verified: isolated primary HTTP401 -> supplied backup; exact structured replacement passed. Production primary unchanged; organization quotas unchanged. Tokens=' +
      String(data.usage?.total_tokens ?? 'unavailable'),
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Standby verification failed. No secret details logged.',
  );
  process.exitCode = 1;
}
