/**
 * ENG-2156 — warn oncall BEFORE the production OpenRouter key hits its own monthly limit.
 *
 * On 2026-09-25 the `agentweb-prod` key reached its $400/month per-key cap and every Agent Mode
 * LLM call started failing with 402 "can only afford N tokens". The org had $4.4k of credit;
 * the cap was a stale per-key guardrail, and nothing warned before it went from healthy to
 * blocking production. ENG-2185 made the request path degrade (retry with affordable
 * max_tokens), but a key at 100% still fails. This sweep reads the key's own usage from
 * OpenRouter (`GET /api/v1/key`) and pages oncall at 80% and 95% of the limit, so a human
 * can resize the cap (a spend decision) with lead time.
 *
 * Read-only: it never changes the limit. No database writes. Dedupe is in-process via
 * sendAgentModeOncallAlert's window, keyed per threshold.
 */
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { getSecret } from '../utils/secretsManager';

export const KEY_BUDGET_INTERVAL_MS = 60 * 60 * 1000; // hourly
export const KEY_BUDGET_THRESHOLDS = [0.95, 0.8] as const; // highest first
/** One alert per threshold per 12h — enough to stay visible, not enough to flood. */
export const KEY_BUDGET_DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface OpenRouterKeyInfo {
  label?: string;
  usage: number;
  limit: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
}

export interface KeyBudgetVerdict {
  /** Fraction of the limit consumed, or null when the key has no limit. */
  fraction: number | null;
  /** The highest crossed threshold, or null when below every threshold / unlimited. */
  threshold: number | null;
}

/** Pure: which threshold (if any) the key has crossed. */
export function evaluateKeyBudget(info: OpenRouterKeyInfo): KeyBudgetVerdict {
  const limit = info.limit;
  if (limit === null || limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return { fraction: null, threshold: null };
  }
  const remaining =
    typeof info.limit_remaining === 'number' && Number.isFinite(info.limit_remaining)
      ? info.limit_remaining
      : null;
  // Prefer limit_remaining: for a monthly-reset key, `usage` is lifetime spend and would
  // over-report. Fall back to usage only when the API omits remaining.
  const used = remaining !== null ? limit - remaining : info.usage;
  const fraction = Math.max(0, used / limit);
  const threshold = KEY_BUDGET_THRESHOLDS.find((t) => fraction >= t) ?? null;
  return { fraction, threshold };
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

async function resolveApiKey(): Promise<string | undefined> {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  const secret = await getSecret(`${environment}/AgentWeb/OpenRouter`);
  return secret?.trim() || undefined;
}

export async function fetchOpenRouterKeyInfo(
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<OpenRouterKeyInfo> {
  const res = await fetchImpl('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenRouter /key returned HTTP ${res.status}`);
  const body = await res.json();
  const data = body?.data;
  if (!data || typeof data.usage !== 'number') {
    throw new Error('OpenRouter /key response missing data.usage');
  }
  return data as OpenRouterKeyInfo;
}

export interface KeyBudgetCheckDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  alert?: typeof sendAgentModeOncallAlert;
}

/** Returns the verdict and whether an alert was delivered. Never throws. */
export async function runOpenRouterKeyBudgetCheck(
  deps: KeyBudgetCheckDeps = {}
): Promise<KeyBudgetVerdict & { alerted: boolean; error?: string }> {
  const alert = deps.alert ?? sendAgentModeOncallAlert;
  try {
    const apiKey = deps.apiKey ?? (await resolveApiKey());
    if (!apiKey) return { fraction: null, threshold: null, alerted: false, error: 'no OpenRouter key' };
    const info = await fetchOpenRouterKeyInfo(apiKey, deps.fetchImpl);
    const verdict = evaluateKeyBudget(info);
    if (verdict.threshold === null || verdict.fraction === null) {
      return { ...verdict, alerted: false };
    }
    const pct = Math.round(verdict.fraction * 100);
    const band = Math.round(verdict.threshold * 100);
    const alerted = await alert({
      // ENG-2706: the subject must be stable per threshold band. The Linear oncall filer dedupes
      // on subject, so embedding the live % filed a new issue at every 1% step. Live % lives in
      // the message/context only.
      subject: `OpenRouter key past ${band}% of its monthly limit`,
      message:
        `The production OpenRouter key${info.label ? ` (${info.label})` : ''} has used ${pct}% of its ` +
        `per-key limit. At 100% every Agent Mode LLM call fails with 402 (ENG-2156, 2026-09-25). ` +
        `Raising the key's limit is a spend decision; the org credit balance is separate from this cap.`,
      context: {
        'Limit (USD)': info.limit,
        'Remaining (USD)': info.limit_remaining ?? 'unknown',
        'Limit reset': info.limit_reset ?? 'unknown',
        'Used (%)': `${pct}%`,
        Threshold: `${band}%`,
      },
      dedupeKey: `openrouter-key-budget:${verdict.threshold}`,
      dedupeWindowMs: KEY_BUDGET_DEDUPE_WINDOW_MS,
    });
    return { ...verdict, alerted };
  } catch (error: any) {
    console.error('[OpenRouterKeyBudget] check failed:', error?.message || error);
    return { fraction: null, threshold: null, alerted: false, error: String(error?.message || error) };
  }
}
