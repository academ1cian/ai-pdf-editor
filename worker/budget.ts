export interface BudgetConfig {
  dailyRequests: number;
  dailyTokens: number;
  perMinute: number;
  perDay: number;
  networkDay?: number;
  networkMinute?: number;
  minuteTokens?: number;
}
export const DEFAULT_BUDGET: BudgetConfig = {
  dailyRequests: 80,
  dailyTokens: 100000,
  perMinute: 4,
  perDay: 30,
  minuteTokens: 7500,
};
export function budgetConfig(env: Record<string, unknown>): BudgetConfig {
  const number = (name: string, fallback: number, max: number) => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  return {
    dailyRequests: number('AI_DAILY_REQUESTS', 80, 1000),
    dailyTokens: number('AI_DAILY_TOKENS', 100000, 180000),
    perMinute: number('AI_SESSION_MINUTE', 4, 10),
    perDay: number('AI_SESSION_DAY', 30, 200),
    networkDay: number('AI_NETWORK_DAY', 60, 500),
    networkMinute: number('AI_NETWORK_MINUTE', 12, 20),
    minuteTokens: number('AI_GLOBAL_MINUTE_TOKENS', 7500, 7500),
  };
}
export interface Usage {
  providerUntil?: number;
  providerReason?: string;
  seen?: Record<string, boolean>;
  day: string;
  requests: number;
  tokens: number;
  attempts?: number;
  minuteHolds?: Record<string, { expires: number; tokens: number }>;
  clients: Record<string, { minute: number; minuteRequests: number; requests: number }>;
  networks?: Record<string, { minute: number; minuteRequests: number; requests: number }>;
  pending?: Record<string, { client: string; network: string; tokens: number }>;
}
export function reserve(
  current: Usage | undefined,
  client: string,
  tokens: number,
  now: number,
  config = DEFAULT_BUDGET,
  network = client,
  id = 'legacy',
): { allowed: boolean; usage: Usage; reason?: string; retryAfter?: number; remaining?: number } {
  const day = new Date(now).toISOString().slice(0, 10),
    minute = Math.floor(now / 60000);
  const usage: Usage =
    current?.day === day ? structuredClone(current) : { day, requests: 0, tokens: 0, clients: {} };
  usage.minuteHolds = Object.fromEntries(
    Object.entries(current?.minuteHolds || {}).filter(([, held]) => held.expires > now),
  );
  const dailyRetry = Math.ceil((Date.parse(day + 'T00:00:00Z') + 86400000 - now) / 1000);
  const item = { ...(usage.clients[client] || { minute, minuteRequests: 0, requests: 0 }) };
  if (item.minute !== minute) {
    item.minute = minute;
    item.minuteRequests = 0;
  }
  usage.networks ||= {};
  usage.pending ||= {};
  const nat = { ...(usage.networks[network] || { minute, minuteRequests: 0, requests: 0 }) };
  if (nat.minute !== minute) {
    nat.minute = minute;
    nat.minuteRequests = 0;
  }
  const deny = (reason: string, retryAfter: number) => ({
    allowed: false,
    usage,
    reason,
    retryAfter: Math.ceil(retryAfter),
  });
  if ((current?.providerUntil || 0) > now)
    return deny(
      current?.providerReason || 'provider_cooldown',
      (current!.providerUntil! - now) / 1000,
    );
  if (id !== 'legacy' && (usage.pending[id] || usage.seen?.[id]))
    return deny('duplicate_reservation', 60);
  if (!Number.isSafeInteger(tokens) || tokens < 1) return deny('invalid_reservation', 60);
  if ((usage.attempts || 0) >= config.dailyRequests * 3) return deny('global_attempts', dailyRetry);
  if (usage.requests >= config.dailyRequests || usage.tokens + tokens > config.dailyTokens)
    return deny('global_daily', dailyRetry);
  if (item.requests >= config.perDay) return deny('session_daily', dailyRetry);
  if (item.minuteRequests >= config.perMinute)
    return deny('session_minute', 60 - ((now / 1000) % 60));
  // Shared corporate networks get an aggregate allowance, rather than six requests for everybody.
  if (nat.requests >= (config.networkDay ?? 60)) return deny('network_daily', dailyRetry);
  if (nat.minuteRequests >= (config.networkMinute ?? 12))
    return deny('network_minute', 60 - ((now / 1000) % 60));
  if (
    config.minuteTokens &&
    Object.values(usage.minuteHolds).reduce((n, h) => n + h.tokens, 0) + tokens >
      config.minuteTokens
  ) {
    const next = Math.min(...Object.values(usage.minuteHolds).map((h) => h.expires), now + 60000);
    return deny('global_minute', Math.max(1, (next - now) / 1000));
  }
  item.requests++;
  item.minuteRequests++;
  nat.requests++;
  nat.minuteRequests++;
  usage.requests++;
  usage.tokens += tokens;
  if (config.minuteTokens)
    usage.minuteHolds[id === 'legacy' ? client + ':' + usage.requests : id] = {
      expires: now + 60000,
      tokens,
    };
  usage.attempts = (usage.attempts || 0) + 1;
  usage.clients[client] = item;
  usage.networks[network] = nat;
  if (id !== 'legacy') {
    usage.pending[id] = { client, network, tokens };
    (usage.seen ||= {})[id] = true;
  }
  return {
    allowed: true,
    usage,
    remaining: Math.min(config.perDay - item.requests, config.dailyRequests - usage.requests),
  };
}
export function reconcile(
  current: Usage,
  id: string,
  actual: number | undefined,
  rejected = false,
): Usage {
  const usage = structuredClone(current),
    held = usage.pending?.[id];
  if (!held) {
    // A still-live rolling hold can cross midnight after daily records reset. It
    // may reconcile its minute footprint, but never refund today's daily usage.
    if (usage.minuteHolds?.[id]) {
      if (rejected) delete usage.minuteHolds[id];
      else if (Number.isSafeInteger(actual) && actual! >= 0) usage.minuteHolds[id].tokens = actual!;
    }
    return usage;
  }
  if (rejected) {
    if (usage.minuteHolds) delete usage.minuteHolds[id];
    usage.tokens -= held.tokens;
    usage.requests--;
    usage.clients[held.client].requests--;
    if (usage.networks?.[held.network]) usage.networks[held.network].requests--;
  } else if (Number.isSafeInteger(actual) && actual! >= 0) {
    usage.tokens = Math.max(0, usage.tokens - held.tokens + actual!);
    if (usage.minuteHolds?.[id]) usage.minuteHolds[id].tokens = actual!;
  }
  delete usage.pending![id];
  return usage;
}
