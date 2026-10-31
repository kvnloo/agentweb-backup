/**
 * ENG-758 — customer-facing usage breakdown for `get_account_status({ usage_month })`.
 *
 * Reads the payload of the existing `/api/subscription/usage/itemized` route (no new
 * store, index, or persisted field) and folds it into per-model and per-day token/call
 * totals plus a session count. Two deliberate omissions:
 *  - No dollars. Internal USD never reaches a customer surface (ENG-1212 AC4); the
 *    itemized items carry `costMicroUsd`, and this is the boundary that drops it.
 *  - Session counts are only exact for per-charge rows. Daily aggregate rows fold
 *    many sessions together and carry no session id, so when any are present the
 *    count is reported as a lower bound rather than invented.
 */

export interface ItemizedUsagePayload {
  month?: string;
  precision?: string;
  items?: Array<{
    date?: string;
    model?: string;
    tokens?: number;
    calls?: number;
    sessionId?: string;
    source?: string;
  }>;
}

export interface UsageTotals {
  tokens: number;
  calls: number;
}

export interface UsageBreakdown {
  month: string;
  totals: UsageTotals;
  by_model: Array<{ model: string } & UsageTotals>;
  by_day: Array<{ date: string } & UsageTotals>;
  sessions: { count: number; exact: boolean; note?: string };
  precision: string;
}

export const USAGE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function add(map: Map<string, UsageTotals>, key: string, tokens: number, calls: number): void {
  const cur = map.get(key) ?? { tokens: 0, calls: 0 };
  cur.tokens += tokens;
  cur.calls += calls;
  map.set(key, cur);
}

export function summarizeItemizedUsage(payload: ItemizedUsagePayload, month: string): UsageBreakdown {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const byModel = new Map<string, UsageTotals>();
  const byDay = new Map<string, UsageTotals>();
  const sessions = new Set<string>();
  let hasUnattributed = false;
  let hasAggregate = false;
  const totals: UsageTotals = { tokens: 0, calls: 0 };

  for (const item of items) {
    const tokens = num(item?.tokens);
    const calls = num(item?.calls);
    totals.tokens += tokens;
    totals.calls += calls;
    add(byModel, item?.model || 'unknown', tokens, calls);
    // Per-charge rows carry full ISO timestamps; bucket every row by calendar day.
    const day = typeof item?.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(item.date) ? item.date.slice(0, 10) : 'unknown';
    add(byDay, day, tokens, calls);
    if (item?.sessionId) sessions.add(item.sessionId);
    else if (tokens > 0 || calls > 0) {
      hasUnattributed = true;
      if (item?.source === 'daily_aggregate') hasAggregate = true;
    }
  }

  const exact = !hasUnattributed;
  return {
    month,
    totals,
    by_model: [...byModel.entries()]
      .map(([model, t]) => ({ model, ...t }))
      .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
    by_day: [...byDay.entries()]
      .map(([date, t]) => ({ date, ...t }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    sessions: exact
      ? { count: sessions.size, exact: true }
      : {
          count: sessions.size,
          exact: false,
          note: hasAggregate
            ? 'Lower bound: some usage is stored as daily aggregates without session ids.'
            : 'Lower bound: some usage records carry no session id.',
        },
    precision: payload?.precision ?? 'unknown',
  };
}
