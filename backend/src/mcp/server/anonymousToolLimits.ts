/**
 * Caps for the one tool an unauthenticated stranger may run (ENG-1034 AC4/AC5).
 *
 * Two independent ceilings, both refused LOUDLY (never a degraded answer):
 *   - per-IP: N calls per rolling window, so one caller cannot drain the day;
 *   - global: a hard daily budget across every anonymous caller, so a single
 *     bad day cannot become an unbounded bill (the ENG-973 hole, at the edge).
 *
 * Process-local by design. No table is added for this (a shared counter would be
 * a data-plane change); the effective global ceiling is therefore
 * GLOBAL_DAILY_LIMIT x running instances, which is still a hard bound. Both
 * numbers are env-tunable and the MCP_ANONYMOUS_DISCOVERY flag is the off switch.
 */

export const PER_IP_LIMIT_DEFAULT = 5;
export const PER_IP_WINDOW_MS_DEFAULT = 60 * 60 * 1000;
export const GLOBAL_DAILY_LIMIT_DEFAULT = 200;

/** Bound on tracked IPs so the limiter itself cannot be used to exhaust memory. */
const MAX_TRACKED_IPS = 10_000;

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type AnonymousLimitVerdict =
  | { allowed: true }
  | { allowed: false; scope: 'ip' | 'global'; message: string };

const CONNECT_HINT =
  'Connect an AgentWeb account (your MCP client will show a Connect / sign-in prompt) to keep going without this limit.';

export class AnonymousToolLimiter {
  private hits = new Map<string, number[]>();
  private day = '';
  private dayCount = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Count one call for `ip` if both ceilings allow it; otherwise refuse without counting. */
  check(ip: string | undefined): AnonymousLimitVerdict {
    const perIp = envInt('MCP_ANONYMOUS_PER_IP_LIMIT', PER_IP_LIMIT_DEFAULT);
    const windowMs = envInt('MCP_ANONYMOUS_PER_IP_WINDOW_MS', PER_IP_WINDOW_MS_DEFAULT);
    const daily = envInt('MCP_ANONYMOUS_GLOBAL_DAILY_LIMIT', GLOBAL_DAILY_LIMIT_DEFAULT);
    const t = this.now();

    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= daily) {
      return {
        allowed: false,
        scope: 'global',
        message: `The free, no-account site review has reached today's limit for everyone. ${CONNECT_HINT}`,
      };
    }

    // An unknown address shares one bucket: it fails closed, never open.
    const key = ip && ip.length > 0 ? ip : 'unknown';
    const recent = (this.hits.get(key) ?? []).filter(ts => t - ts < windowMs);
    if (recent.length >= perIp) {
      this.hits.set(key, recent);
      return {
        allowed: false,
        scope: 'ip',
        message: `You have used the free, no-account site review ${perIp} times recently. ${CONNECT_HINT}`,
      };
    }

    if (!this.hits.has(key) && this.hits.size >= MAX_TRACKED_IPS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    recent.push(t);
    this.hits.delete(key);
    this.hits.set(key, recent);
    this.dayCount += 1;
    return { allowed: true };
  }

  /** Test seam. */
  reset(): void {
    this.hits.clear();
    this.day = '';
    this.dayCount = 0;
  }
}

export const anonymousToolLimiter = new AnonymousToolLimiter();
